import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClean } from "../src/cleaners/plan.js";
import {
  assertMetadataInventoryUnchanged, createMetadataInventory, rehearseMetadata, withPrivateReadDatabase
} from "../src/conversations/metadata-safety.js";
import { findOpenPaths } from "../src/fs/open-files.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

describe("SQLite SHM bookkeeping preflight", () => {
  it("reproduces readonly SHM drift and accepts it only under the explicit snapshot policy", async () => {
    const item = await fixture();
    const strict = await createMetadataInventory([item.file], item.root, item.home);
    const relaxed = await createMetadataInventory([item.file], item.root, item.home, { allowShmBookkeeping: true });
    const before = await snapshot(item.file);
    readOriginal(item.file);
    const after = await snapshot(item.file);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[2]!.bytes).not.toEqual(before[2]!.bytes);
    expect(after[2]!.inode).toBe(before[2]!.inode);
    expect(after[2]!.size).toBe(before[2]!.size);
    await expect(assertMetadataInventoryUnchanged(strict)).rejects.toThrow(/Metadata .*changed after preflight/);
    await expect(assertMetadataInventoryUnchanged(relaxed)).resolves.toBeUndefined();
    const opened = vi.spyOn(fs, "open");
    await rehearseMetadata(relaxed, async (copies) => {
      const database = new DatabaseSync(copies.get(item.file)!, { readOnly: true });
      try { expect(database.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({ count: 1 }); }
      finally { database.close(); }
    });
    expect(opened.mock.calls.some(([file]) => String(file) === `${item.file}-shm`)).toBe(false);
    expect(await snapshot(item.file)).toEqual(after);
  });

  it("private readonly snapshots leave every original database and sidecar byte and timestamp unchanged", async () => {
    const item = await fixture();
    const before = await snapshot(item.file);
    await withPrivateReadDatabase(item.home, item.root, item.file, (database) => {
      expect(database.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({ count: 1 });
    });
    expect(await snapshot(item.file)).toEqual(before);
  });

  it("completes bulk cleanup after a closed readonly connection changes only SHM bookkeeping", async () => {
    const item = await fixture();
    const plan = await prepareClean(["codex"], item.options);
    const before = await snapshot(item.file);
    readOriginal(item.file);
    const after = await snapshot(item.file);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[2]!.bytes).not.toEqual(before[2]!.bytes);
    const result = await plan.execute();
    expect(result.failures).toEqual([]);
    expect(result.deleted.map((entry) => entry.path).sort()).toEqual(
      [item.file, `${item.file}-shm`, `${item.file}-wal`].sort()
    );
    expect(JSON.parse(await fs.readFile(item.global, "utf8"))).toEqual({ "pinned-thread-ids": [], theme: "dark" });
  });

  it.each(["database", "wal-salt", "wal-frame"] as const)(
    "rejects same-size %s byte changes with restored timestamps before any movement", async (kind) => {
      const item = await fixture();
      const target = kind === "database" ? item.file : `${item.file}-wal`;
      const timestamp = new Date("2026-01-01T00:00:00Z");
      await fs.utimes(target, timestamp, timestamp);
      const plan = await prepareClean(["codex"], item.options);
      const original = await fs.readFile(target);
      const bytes = Buffer.from(original);
      const offset = kind === "wal-salt" ? 16 : bytes.length - 1;
      bytes[offset] = bytes[offset]! ^ 1;
      await fs.writeFile(target, bytes);
      await fs.utimes(target, timestamp, timestamp);
      expect((await fs.stat(target)).mtimeMs).toBe(timestamp.getTime());
      expect(bytes.length).toBe(original.length);
      await expect(plan.execute()).rejects.toThrow(/Metadata contents changed after preflight/);
      expect(item.trash).not.toHaveBeenCalled();
      expect(await fs.readFile(target)).toEqual(bytes);
      expect(JSON.parse(await fs.readFile(item.global, "utf8"))["pinned-thread-ids"]).toEqual(["selected"]);
      await expect(fs.lstat(path.join(item.home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("rejects a real WAL commit with unchanged main database before any movement", async () => {
    const item = await fixture();
    const plan = await prepareClean(["codex"], item.options);
    const before = await snapshot(item.file);
    const writer = new DatabaseSync(item.file);
    try {
      writer.exec("PRAGMA wal_autocheckpoint = 0; INSERT INTO logs VALUES('later', 'synthetic committed content')");
      const after = await snapshot(item.file);
      expect(after[0]).toEqual(before[0]);
      expect(after[1]!.bytes).not.toEqual(before[1]!.bytes);
      await expect(plan.execute()).rejects.toThrow(/Metadata .*changed after preflight/);
      expect(item.trash).not.toHaveBeenCalled();
      expect(writer.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({ count: 2 });
      await expect(fs.lstat(path.join(item.home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { writer.close(); }
  });

  it("keeps orphan SHM bytes strict when no main database was inventoried", async () => {
    const item = await fixture();
    const shm = `${item.file}-shm`;
    await fs.rename(item.file, path.join(item.home, "held-database.sqlite"));
    const timestamp = new Date("2026-01-01T00:00:00Z");
    await fs.utimes(shm, timestamp, timestamp);
    const inventory = await createMetadataInventory([item.file], item.root, item.home, { allowShmBookkeeping: true });
    const bytes = await fs.readFile(shm);
    bytes[104] = bytes[104]! ^ 1;
    await fs.writeFile(shm, bytes);
    await fs.utimes(shm, timestamp, timestamp);
    await expect(assertMetadataInventoryUnchanged(inventory)).rejects.toThrow(/Metadata contents changed after preflight/);
  });

  it.each(["inode", "symlink", "hardlink", "size", "mode", "missing", "appeared"] as const)(
    "retains the SHM %s guard under the explicit bookkeeping policy", async (kind) => {
      const item = await fixture();
      const shm = `${item.file}-shm`;
      const held = path.join(item.home, "held-shm.bin");
      if (kind === "appeared") await fs.rename(shm, held);
      const inventory = await createMetadataInventory([item.file], item.root, item.home, { allowShmBookkeeping: true });
      if (kind === "inode" || kind === "symlink" || kind === "missing") await fs.rename(shm, held);
      if (kind === "inode" || kind === "appeared") await fs.copyFile(held, shm);
      if (kind === "symlink") await fs.symlink(held, shm);
      if (kind === "hardlink") await fs.link(shm, held);
      if (kind === "size") await fs.truncate(shm, (await fs.stat(shm)).size + 1);
      if (kind === "mode") await fs.chmod(shm, 0o400);
      await expect(assertMetadataInventoryUnchanged(inventory)).rejects.toThrow(/Metadata|SHM|link count/);
      expect(item.trash).not.toHaveBeenCalled();
    }
  );

  it.each(["reader", "writer"] as const)("refuses a still-open real SQLite %s before any movement", async (kind) => {
    const item = await fixture();
    const plan = await prepareClean(["codex"], { ...item.options, checkOpenPaths: findOpenPaths });
    const connection = new DatabaseSync(item.file, { readOnly: kind === "reader" });
    try {
      if (kind === "writer") connection.exec("BEGIN IMMEDIATE");
      else connection.prepare("SELECT COUNT(*) FROM logs").get();
      const open = await findOpenPaths([item.file, `${item.file}-wal`, `${item.file}-shm`]);
      expect(open.supported).toBe(true);
      expect(open.openPaths.length).toBeGreaterThan(0);
      await expect(plan.execute()).rejects.toThrow(/Quit the relevant agents completely/);
      expect(item.trash).not.toHaveBeenCalled();
      expect(connection.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({ count: 1 });
    } finally {
      if (connection.isTransaction) connection.exec("ROLLBACK");
      connection.close();
    }
  }, 15_000);
});

async function fixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-shm-preflight-")));
  homes.push(home);
  const root = path.join(home, ".codex");
  await fs.mkdir(root);
  const seed = path.join(home, "seed.sqlite");
  const file = path.join(root, "logs_2.sqlite");
  const writer = new DatabaseSync(seed);
  try {
    writer.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE logs(thread_id TEXT, body TEXT); INSERT INTO logs VALUES('selected', 'synthetic content')`);
    for (const suffix of ["", "-wal", "-shm"]) await fs.copyFile(`${seed}${suffix}`, `${file}${suffix}`);
  } finally { writer.close(); }
  const global = path.join(root, ".codex-global-state.json");
  await fs.writeFile(global, JSON.stringify({ "pinned-thread-ids": ["selected"], theme: "dark" }));
  const trash = vi.fn(async (files: string[]) => {
    for (const source of files) await fixtureTrash(source);
  });
  return { home, root, file, global, trash, options: { home, trash,
    checkOpenPaths: async () => ({ supported: true, openPaths: [] as string[] }) } };
}

function readOriginal(file: string): void {
  const reader = new DatabaseSync(file, { readOnly: true });
  try { reader.prepare("SELECT COUNT(*) FROM logs").get(); }
  finally { reader.close(); }
}

async function snapshot(file: string) {
  return Promise.all(["", "-wal", "-shm"].map(async (suffix) => {
    const target = `${file}${suffix}`;
    const stat = await fs.stat(target);
    return { bytes: await fs.readFile(target), inode: stat.ino, size: stat.size, modifiedMs: stat.mtimeMs };
  }));
}
