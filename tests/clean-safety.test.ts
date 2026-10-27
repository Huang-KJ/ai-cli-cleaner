import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { copyFile, link, mkdir, readFile, realpath, rename, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanEntries } from "../src/cleaners/clean.js";
import type { CleanerManifest, ScanEntry } from "../src/cleaners/types.js";
import { findOpenPaths } from "../src/fs/open-files.js";
import * as paths from "../src/fs/paths.js";
import { scanManifests } from "../src/fs/scan.js";
import { moveToSystemTrash } from "../src/fs/trash.js";
import { inspectOperation, listOperations, withOperation, wrapOperationTrash } from "../src/recovery/operations.js";

const fixtureHomes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtureHomes.splice(0).map((home) =>
    fixtureTrash(home, { recursive: true, force: true })
  ));
});

describe("cleanEntries safety branches", () => {
  it("does not count a moved file twice when a later post-move check fails", async () => {
    const home = await makeHome();
    const database = path.join(home, ".fixture", "state.sqlite");
    const wal = `${database}-wal`;
    await mkdir(path.dirname(database), { recursive: true });
    await writeFile(database, "database");
    await writeFile(wal, "wal");
    const entries = await scanEntries(home, ["~/.fixture/state.sqlite*"]);
    const move = await makeTrash(home);
    const original = paths.pathExists;
    let moved = false;
    vi.spyOn(paths, "pathExists").mockImplementation(async (file) => {
      if (moved && file === wal) throw Object.assign(new Error("post-move access denied"), { code: "EACCES" });
      return original(file);
    });
    const result = await cleanEntries(entries, { trash: async (files) => {
      await move(files);
      moved = true;
    } });
    expect(result.deleted.map((entry) => entry.path)).toEqual([database]);
    expect(result.failures.map((failure) => failure.entry.path)).toEqual([wal]);
  });
  it("refuses a known open file and unsupported lsof without bypassing the check", async () => {
    const home = await makeHome();
    const openFile = path.join(home, ".fixture", "open.log");
    const unsupportedFile = path.join(home, ".fixture", "unsupported.log");
    await mkdir(path.dirname(openFile), { recursive: true });
    await writeFile(openFile, "open fixture");
    await writeFile(unsupportedFile, "unsupported fixture");

    const openEntry = await scanEntry(home, "~/.fixture/open.log");
    const openTrash = vi.fn(async () => undefined);
    const openResult = await cleanEntries([openEntry], {
      checkOpenPaths: async (paths) => ({ supported: true, openPaths: paths }),
      trash: openTrash
    });

    expect(openTrash).not.toHaveBeenCalled();
    expect(openResult.deleted).toEqual([]);
    expect(openResult.failures.map((failure) => failure.entry.path)).toEqual([openFile]);
    expect(openResult.failures[0]?.error.message).toMatch(/Refusing to clean open file/);

    const unsupportedEntry = await scanEntry(home, "~/.fixture/unsupported.log");
    const lsof = vi.fn(async () => ({ supported: false, stdout: "" }));
    const unsupportedTrash = vi.fn(async () => undefined);
    const unsupportedResult = await cleanEntries([unsupportedEntry], {
      checkOpenPaths: (paths) => findOpenPaths(paths, "darwin", lsof),
      trash: unsupportedTrash
    });

    expect(lsof).toHaveBeenCalledOnce();
    expect(unsupportedTrash).not.toHaveBeenCalled();
    expect(unsupportedResult.openFileCheckUnsupported).toBe(true);
    expect(unsupportedResult.failures.map((failure) => failure.entry.path))
      .toEqual([unsupportedFile]);
  });

  it("moves unchanged data into a temporary Trash and verifies the original is gone", async () => {
    const home = await makeHome();
    const target = path.join(home, ".fixture", "session.jsonl");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "conversation fixture");
    const entry = await scanEntry(home, "~/.fixture/session.jsonl");
    const trash = await makeTrash(home);
    const result = await cleanEntries([entry], {
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }), trash
    });
    expect(trash).toHaveBeenCalledExactlyOnceWith([target], new Map([[target, entry.identity]]));
    expect(result.deleted).toEqual([entry]);
    expect(result.failures).toEqual([]);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(home, "trash", "session.jsonl"), "utf8")).toBe("conversation fixture");
  });

  it("does not report deletion when Trash resolves without moving the data", async () => {
    const home = await makeHome();
    const target = path.join(home, ".fixture", "session.jsonl");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "conversation fixture");
    const entry = await scanEntry(home, "~/.fixture/session.jsonl");
    const trash = vi.fn(async () => undefined);
    const result = await cleanEntries([entry], { trash });
    expect(trash).toHaveBeenCalledOnce();
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toContain("Original path still exists after the Trash operation");
    expect(await readFile(target, "utf8")).toBe("conversation fixture");
  });

  it("rejects file and directory content changes since scanning", async () => {
    const home = await makeHome();
    const file = path.join(home, ".fixture", "state.log");
    const directory = path.join(home, ".fixture", "sessions");
    await mkdir(directory, { recursive: true });
    await writeFile(file, "before");
    await writeFile(path.join(directory, "old.jsonl"), "old session");
    const entries = await scanEntries(home, ["~/.fixture/state.log", "~/.fixture/sessions"]);

    await writeFile(file, "changed after scan");
    await writeFile(path.join(directory, "new.jsonl"), "new session");
    const trash = vi.fn(async () => undefined);

    const result = await cleanEntries(entries, { trash });

    expect(trash).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(result.failures.map((failure) => failure.entry.path).sort())
      .toEqual([file, directory].sort());
    expect(result.failures.every((failure) =>
      failure.error.message.includes("Path changed after scanning")
    )).toBe(true);
  });

  it("rejects canonical symlink redirects", async () => {
    const home = await makeHome();
    const outside = await makeHome();
    const target = path.join(home, ".fixture", "state.log");
    const redirect = path.join(outside, "redirect.log");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "scanned fixture");
    await writeFile(redirect, "outside fixture");
    const entry = await scanEntry(home, "~/.fixture/state.log");
    await fixtureTrash(target);
    await symlink(redirect, target);
    const trash = vi.fn(async () => undefined);

    const result = await cleanEntries([entry], { trash });

    expect(trash).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.entry.path).toBe(target);
    expect(result.failures[0]?.error.message).toMatch(/Path changed after scanning/);
  });

  it("groups SQLite sidecars and reports partial Trash success after an error", async () => {
    const home = await makeHome();
    const database = path.join(home, ".fixture", "state.sqlite");
    const wal = `${database}-wal`;
    const shm = `${database}-shm`;
    await mkdir(path.dirname(database), { recursive: true });
    await writeFile(database, "synthetic database fixture");
    await writeFile(wal, "synthetic wal fixture");
    await writeFile(shm, "synthetic shm fixture");
    const entries = await scanEntries(home, ["~/.fixture/state.sqlite*"]);
    const trash = vi.fn(async () => {
      await rename(database, path.join(home, "trashed.sqlite"));
      throw new Error("Trash failed after moving one item");
    });

    const result = await cleanEntries(entries, { trash });

    expect(trash).toHaveBeenCalledOnce();
    expect(trash).toHaveBeenCalledWith(expect.arrayContaining([database, wal, shm]), expect.any(Map));
    expect(result.deleted.map((entry) => entry.path)).toEqual([database]);
    expect(result.failures.map((failure) => failure.entry.path).sort()).toEqual([wal, shm].sort());
    expect(result.failures.every((failure) =>
      failure.error.message === "Trash failed after moving one item"
    )).toBe(true);
  });

  it("groups unannotated SQLite paths by provider and inferred base path", async () => {
    const home = await makeHome();
    const database = path.join(home, ".fixture", "state.sqlite");
    const wal = `${database}-wal`;
    await mkdir(path.dirname(database), { recursive: true });
    await writeFile(database, "database");
    await writeFile(wal, "wal");
    const scannedEntries = await scanEntries(home, ["~/.fixture/state.sqlite*"]);
    const entries = scannedEntries.map((entry) => {
      const { sqliteGroup: _sqliteGroup, ...unannotated } = entry;
      return unannotated;
    });
    const walEntry = entries.find((entry) => entry.path === wal)!;
    const otherProviderWal = {
      ...walEntry,
      providerId: "opencode" as const,
      providerName: "OpenCode fixture"
    };
    const trash = vi.fn(async () => undefined);

    await cleanEntries([...entries, otherProviderWal], { trash });

    expect(trash).toHaveBeenNthCalledWith(1, [database, wal], expect.any(Map));
    expect(trash).toHaveBeenNthCalledWith(2, [wal], expect.any(Map));
  });

  it("rejects SQLite annotations that point an unrelated path at a group", async () => {
    const home = await makeHome();
    const target = path.join(home, ".fixture", "session.log");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "fixture");
    const entry = await scanEntry(home, "~/.fixture/session.log");
    const mislabeledEntry: ScanEntry = {
      ...entry,
      sqliteGroup: {
        basePath: path.join(home, ".fixture", "state.sqlite"),
        members: [],
        complete: true
      }
    };
    const trash = vi.fn(async () => undefined);

    const result = await cleanEntries([mislabeledEntry], { trash });

    expect(trash).not.toHaveBeenCalled();
    expect(result.failures[0]?.error.message).toMatch(/SQLite sidecar set changed/);
  });

  it("cleans a SQLite group when only its shared-memory file changes", async () => {
    const home = await makeHome();
    const database = path.join(home, ".fixture", "state.sqlite");
    const wal = `${database}-wal`;
    const shm = `${database}-shm`;
    await mkdir(path.dirname(database), { recursive: true });
    await writeFile(database, "database");
    await writeFile(wal, "wal");
    await writeFile(shm, "before");
    const entries = await scanEntries(home, ["~/.fixture/state.sqlite*"]);
    await writeFile(shm, "after!");
    await utimes(shm, new Date(), new Date(entries.find((entry) => entry.path === shm)!.identity!.modifiedMs + 1000));
    const trash = await makeTrash(home);

    const result = await cleanEntries(entries, { trash });

    expect(trash).toHaveBeenCalledWith([database, shm, wal], expect.any(Map));
    expect(result.deleted).toHaveLength(3);
    expect(result.failures).toEqual([]);
  });

  it("moves a synthetic WAL database through the native claim and journal after same-size SHM drift", async () => {
    const home = await realpath(await makeHome());
    const database = await makeSQLiteGroup(home);
    const shm = `${database}-shm`;
    const entries = await scanEntries(home, ["~/.fixture/state.sqlite*"]);
    const expected = entries.find((entry) => entry.path === shm)!.identity!;
    await utimes(shm, new Date(), new Date(expected.modifiedMs + 1000));
    expect((await stat(shm)).mtimeMs).not.toBe(expected.modifiedMs);
    const approved = new Map(await Promise.all(entries.map(async (entry) => [entry.path, await readFile(entry.path)] as const)));
    const destination = path.join(home, "native-trash");
    await mkdir(destination);
    const run = vi.fn(async (_binary: string, files: string[]) => {
      expect(files).toHaveLength(3);
      for (const file of files) {
        expect(file).toContain("/.ai-cli-cleaner/recovery/");
        expect(file).toContain("/original/");
        await rename(file, path.join(destination, path.basename(file)));
      }
    });
    const result = await withOperation({ home, kind: "clean", target: ["codex"] }, () => cleanEntries(entries, {
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: wrapOperationTrash((files, identities) => {
        expect(identities?.get(shm)).toEqual(expected);
        return moveToSystemTrash(files, identities!, { run });
      })
    }));
    expect(result.failures).toEqual([]);
    expect(result.deleted).toHaveLength(3);
    expect(run).toHaveBeenCalledOnce();
    for (const [index, entry] of entries.entries()) {
      await expect(stat(entry.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(destination, `${String(index).padStart(3, "0")}-${path.basename(entry.path)}`)))
        .toEqual(approved.get(entry.path));
    }
    const [operation] = await listOperations(home);
    expect((await inspectOperation(operation!.id, home)).claims[0]?.state).toBe("trashed");
  });

  it.each(["replacement", "growth", "hardlink", "hardlink without mtime drift", "unselected main database"])(
    "refuses SHM drift with %s", async (change) => {
      const home = await makeHome();
      const database = await makeSQLiteGroup(home);
      const shm = `${database}-shm`;
      const entries = await scanEntries(home, [change === "unselected main database" ? "~/.fixture/state.sqlite-shm" : "~/.fixture/state.sqlite*"]);
      const original = entries.find((entry) => entry.path === shm)!.identity!;
      if (change === "replacement") {
        const retained = path.join(home, "retained-shm");
        await rename(shm, retained);
        await copyFile(retained, shm);
      }
      if (change === "growth") await writeFile(shm, Buffer.alloc(original.sizeBytes + 1));
      if (change.startsWith("hardlink")) await link(shm, path.join(home, "linked-shm"));
      if (change === "hardlink without mtime drift") expect((await stat(shm)).mtimeMs).toBe(original.modifiedMs);
      else await utimes(shm, new Date(), new Date(original.modifiedMs + 1000));
      const trash = vi.fn();
      const result = await cleanEntries(entries, { trash });
      expect(trash).not.toHaveBeenCalled();
      expect(result.deleted).toEqual([]);
      expect(result.failures.every((failure) => failure.error.message.includes(shm))).toBe(true);
      expect(result.failures).toHaveLength(entries.length);
    }
  );

  it.each(["", "-wal", "-journal"])("keeps the SQLite group when %s changes along with SHM", async (suffix) => {
    const home = await makeHome();
    const database = await makeSQLiteGroup(home);
    if (suffix === "-journal") await writeFile(`${database}-journal`, "synthetic journal");
    const entries = await scanEntries(home, ["~/.fixture/state.sqlite*"]);
    for (const file of [`${database}-shm`, `${database}${suffix}`]) {
      const original = entries.find((entry) => entry.path === file)!.identity!;
      await utimes(file, new Date(), new Date(original.modifiedMs + 1000));
    }
    const trash = vi.fn();
    const result = await cleanEntries(entries, { trash });
    expect(trash).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(entries.length);
    expect(result.failures.every((failure) => failure.error.message.includes(`${database}${suffix}`))).toBe(true);
  });

  it.each(["-wal", "-shm", "-journal"])(
    "refuses the scanned SQLite group when a new %s member appears",
    async (suffix) => {
      const home = await makeHome();
      const database = path.join(home, ".fixture", "state.sqlite");
      const newMember = `${database}${suffix}`;
      await mkdir(path.dirname(database), { recursive: true });
      await writeFile(database, "database");
      const entries = await scanEntries(home, ["~/.fixture/state.sqlite*"]);
      await writeFile(newMember, "new sidecar");
      const trash = vi.fn(async () => undefined);

      const result = await cleanEntries(entries, { trash });

      expect(trash).not.toHaveBeenCalled();
      expect(result.deleted).toEqual([]);
      expect(result.failures.map((failure) => failure.entry.path)).toEqual([database]);
      expect(result.failures[0]?.error.message).toMatch(/SQLite sidecar set changed/);
    }
  );

  it("rejects a redirected SQLite shared-memory file", async () => {
    const home = await makeHome();
    const database = path.join(home, ".fixture", "state.sqlite");
    const shm = `${database}-shm`;
    const redirect = path.join(home, ".fixture", "redirect");
    await mkdir(path.dirname(database), { recursive: true });
    await writeFile(database, "database");
    await writeFile(shm, "before");
    await writeFile(redirect, "redirect");
    const entries = await scanEntries(home, ["~/.fixture/state.sqlite*"]);
    await fixtureTrash(shm);
    await symlink(redirect, shm);
    const trash = vi.fn(async () => undefined);

    const result = await cleanEntries(entries, { trash });

    expect(trash).not.toHaveBeenCalled();
    expect(result.failures.map((failure) => failure.entry.path)).toEqual([database, shm]);
    expect(result.failures.every((failure) => failure.error.message.includes(shm))).toBe(true);
  });
});

async function scanEntry(home: string, pattern: string): Promise<ScanEntry> {
  const entries = await scanEntries(home, [pattern]);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.exists).toBe(true);
  return entries[0]!;
}

async function scanEntries(home: string, patterns: string[]): Promise<ScanEntry[]> {
  const manifest: CleanerManifest = {
    id: "codex",
    name: "Codex fixture",
    deletePatterns: patterns,
    preservedPaths: []
  };
  const summary = await scanManifests([manifest], { home });
  expect(summary.every((entry) => !entry.error)).toBe(true);
  return summary;
}

async function makeHome(): Promise<string> {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cli-cleaner-safety-"));
  fixtureHomes.push(home);
  return home;
}

async function makeSQLiteGroup(home: string): Promise<string> {
  const source = path.join(home, "fixture-source.sqlite");
  const destination = path.join(home, ".fixture", "state.sqlite");
  await mkdir(path.dirname(destination), { recursive: true });
  const database = new DatabaseSync(source);
  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE logs(body TEXT); INSERT INTO logs VALUES('synthetic log')");
    for (const suffix of ["", "-wal", "-shm"]) await copyFile(`${source}${suffix}`, `${destination}${suffix}`);
  } finally { database.close(); }
  return destination;
}

async function makeTrash(home: string) {
  const destination = path.join(home, "trash");
  await mkdir(destination);
  return vi.fn(async (paths: string[]) => {
    for (const file of paths) await rename(file, path.join(destination, path.basename(file)));
  });
}
