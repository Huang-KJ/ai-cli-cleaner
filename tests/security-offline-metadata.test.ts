import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCodexThreadsMetadata } from "../src/conversations/codex-metadata.js";
import { getCodexMetadataPaths } from "../src/conversations/codex-paths.js";
import { createMetadataInventory } from "../src/conversations/metadata-safety.js";
import { createMetadataPlan } from "../src/conversations/metadata-plan.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { discoverConversations } from "../src/conversations/discover.js";
import type { ConversationRecord } from "../src/conversations/types.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-offline-metadata-")));
  homes.push(home);
  const paths = getCodexMetadataPaths(home);
  await fs.mkdir(path.join(home, ".codex"));
  const database = new DatabaseSync(paths.stateDatabase);
  database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT); INSERT INTO threads VALUES('selected', 'selected.jsonl'), ('retained', 'retained.jsonl')");
  database.close();
  await fs.writeFile(paths.sessionIndex, '{"id":"selected"}\n{"id":"retained"}\n');
  const trash = async (files: string[]) => {
    for (const file of files) await fixtureTrash(file);
  };
  return { home, paths, trash };
}

describe("offline metadata publication", () => {
  it.each(["codex", "antigravity"] as const)("keeps a hard-linked SHM sentinel unchanged during %s discovery", async (provider) => {
    const item = await fixture();
    const root = provider === "codex" ? path.join(item.home, ".codex") : path.join(item.home, ".gemini", "antigravity-cli");
    await fs.mkdir(root, { recursive: true });
    const file = provider === "codex" ? item.paths.stateDatabase : path.join(root, "conversation_summaries.db");
    const database = new DatabaseSync(file);
    database.exec(provider === "codex" ? "PRAGMA journal_mode=WAL" : "PRAGMA journal_mode=WAL; CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY)");
    database.close();
    const sentinel = path.join(item.home, "discovery-shm.bin");
    const before = Buffer.alloc(32 * 1024, 0xa5);
    await fs.writeFile(sentinel, before);
    await fs.link(sentinel, `${file}-shm`);
    const result = await discoverConversations([provider], { home: item.home });
    expect((await fs.readFile(sentinel)).equals(before)).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/hard-linked|link count/);
  });

  it("lists a stable open WAL snapshot while preserving every original database and sidecar byte", async () => {
    const item = await fixture();
    const database = new DatabaseSync(item.paths.stateDatabase);
    try {
      database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE threads SET rollout_path = ''");
      const files = [item.paths.stateDatabase, `${item.paths.stateDatabase}-wal`, `${item.paths.stateDatabase}-shm`];
      const before = await Promise.all(files.map((file) => fs.readFile(file)));
      const result = await discoverConversations(["codex"], { home: item.home });
      expect(result.warnings).toEqual([]);
      expect(result.conversations.map((row) => row.id).sort()).toEqual(["retained", "selected"]);
      const after = await Promise.all(files.map((file) => fs.readFile(file)));
      expect(after.every((bytes, index) => bytes.equals(before[index]!))).toBe(true);
    } finally { database.close(); }
  });

  it("never opens a published Antigravity WAL database against a late hard-linked SHM sentinel", async () => {
    const item = await fixture();
    const root = path.join(item.home, ".gemini", "antigravity-cli");
    const data = path.join(root, "brain", "selected");
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, "artifact.txt"), "selected");
    const file = path.join(root, "conversation_summaries.db");
    const database = new DatabaseSync(file);
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY); INSERT INTO conversation_summaries VALUES('selected'),('retained')");
    database.close();
    const sentinel = path.join(item.home, "retained-shm.bin");
    const before = Buffer.alloc(32 * 1024, 0xa5);
    await fs.writeFile(sentinel, before);
    const conversation: ConversationRecord = { key: "antigravity:selected", providerId: "antigravity", providerName: "Antigravity",
      id: "selected", title: "selected", sizeBytes: 1, dataPaths: [data], guardPaths: [], warnings: [],
      deleteStrategy: { kind: "local", metadata: { kind: "antigravity", summaryDatabase: file } } };
    const result = await deleteConversations([conversation], { home: item.home,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: async (files) => {
        await item.trash(files);
        if (files.some((source) => source.includes(`${path.sep}recovery${path.sep}`))) {
          await fixtureTrash(`${file}-shm`, { force: true });
          await fs.link(sentinel, `${file}-shm`);
        }
      }
    });
    expect((await fs.readFile(sentinel)).equals(before)).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("publishes a new SQLite inode while preserving the original database object", async () => {
    const item = await fixture();
    const plan = await prepareCodexThreadsMetadata(item.home, item.paths, ["selected"], item.trash);
    await plan.prepareRecovery();
    const original = await fs.open(item.paths.stateDatabase, "r");
    try {
      const identity = await original.stat();
      const before = await original.readFile();
      await plan.execute();
      const after = Buffer.alloc(before.length);
      await original.read(after, 0, after.length, 0);
      expect(after).toEqual(before);
      expect((await fs.stat(item.paths.stateDatabase)).ino).not.toBe(identity.ino);
      const checked = new DatabaseSync(item.paths.stateDatabase, { readOnly: true });
      try { expect(checked.prepare("SELECT id FROM threads").all()).toEqual([{ id: "retained" }]); }
      finally { checked.close(); }
      expect(await fs.readFile(item.paths.sessionIndex, "utf8")).toBe('{"id":"retained"}\n');
    } finally { await original.close(); }
  });

  it("keeps a late hard-link alias to the held original byte-equivalent", async () => {
    const item = await fixture();
    const file = item.paths.stateDatabase;
    const before = await fs.readFile(file);
    const alias = path.join(item.home, "retained-alias.sqlite");
    const inventory = await createMetadataInventory([file], path.join(item.home, ".codex"), item.home);
    let recovery = "";
    const plan = createMetadataPlan({ home: item.home, inventory, changedPaths: [file], providerId: "codex", conversationIds: ["selected"],
      write: async (_changed, copies) => {
        const held = (await fs.readdir(path.join(recovery, "original"))).find((name) => name.endsWith("state_5.sqlite"))!;
        await fs.link(path.join(recovery, "original", held), alias);
        const database = new DatabaseSync(copies.get(file)!);
        try { database.exec("DELETE FROM threads WHERE id = 'selected'"); }
        finally { database.close(); }
      }
    });
    await plan.prepareRecovery();
    recovery = plan.recoveryPath!;
    await plan.execute(item.trash);
    expect(await fs.readFile(alias)).toEqual(before);
    expect((await fs.stat(alias)).ino).not.toBe((await fs.stat(file)).ino);
  });

  it("copies committed WAL data without modifying the original database or WAL objects", async () => {
    const item = await fixture();
    await fixtureTrash(item.paths.stateDatabase);
    const seed = path.join(item.home, "seed.sqlite");
    const database = new DatabaseSync(seed);
    try {
      database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT); INSERT INTO threads VALUES('selected','selected.jsonl'),('retained','retained.jsonl')");
      await fs.copyFile(seed, item.paths.stateDatabase);
      await fs.copyFile(`${seed}-wal`, `${item.paths.stateDatabase}-wal`);
      await fs.copyFile(`${seed}-shm`, `${item.paths.stateDatabase}-shm`);
    } finally { database.close(); }
    const plan = await prepareCodexThreadsMetadata(item.home, item.paths, ["selected"], item.trash);
    await plan.prepareRecovery();
    const original = await fs.open(item.paths.stateDatabase, "r");
    const wal = await fs.open(`${item.paths.stateDatabase}-wal`, "r");
    try {
      const before = await original.readFile();
      const walBefore = await wal.readFile();
      await plan.execute();
      const after = Buffer.alloc(before.length);
      const walAfter = Buffer.alloc(walBefore.length);
      await original.read(after, 0, after.length, 0);
      await wal.read(walAfter, 0, walAfter.length, 0);
      expect(after).toEqual(before);
      expect(walAfter).toEqual(walBefore);
      const checked = new DatabaseSync(item.paths.stateDatabase, { readOnly: true });
      try { expect(checked.prepare("SELECT id FROM threads").all()).toEqual([{ id: "retained" }]); }
      finally { checked.close(); }
    } finally { await original.close(); await wal.close(); }
  });

  it("preserves a concurrent replacement and retains recovery when publication refuses an occupied target", async () => {
    const item = await fixture();
    const file = item.paths.stateDatabase;
    const inventory = await createMetadataInventory([file], path.join(item.home, ".codex"), item.home);
    const original = await fs.readFile(file);
    const concurrent = "retained concurrent database";
    const plan = createMetadataPlan({ home: item.home, inventory, changedPaths: [file], providerId: "codex", conversationIds: ["selected"],
      write: async (_changed, copies) => {
        const database = new DatabaseSync(copies.get(file)!);
        try { database.exec("DELETE FROM threads WHERE id = 'selected'"); }
        finally { database.close(); }
        await fs.writeFile(file, concurrent);
      }
    });
    await plan.prepareRecovery();
    const recovery = plan.recoveryPath!;
    await expect(plan.execute(item.trash)).rejects.toMatchObject({ metadataChanged: true, recoveryPath: recovery });
    expect(await fs.readFile(file, "utf8")).toBe(concurrent);
    const held = (await fs.readdir(path.join(recovery, "original"))).find((name) => name.endsWith("state_5.sqlite"))!;
    expect(await fs.readFile(path.join(recovery, "original", held))).toEqual(original);
  });
});
