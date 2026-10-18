import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareLiveCodexThreadsMetadata } from "../src/conversations/codex-metadata.js";
import { deleteConversations } from "../src/conversations/delete.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});

interface Manifest {
  files: Array<{ originalPath: string; backupPath: string }>;
}

async function fixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-live-recovery-")));
  homes.push(home);
  const root = path.join(home, ".codex");
  const rollout = path.join(root, "sessions", "selected.jsonl");
  await fs.mkdir(path.dirname(rollout), { recursive: true });
  await fs.writeFile(rollout, JSON.stringify({ payload: { id: "selected" } }) + "\n");
  const file = path.join(root, "state_5.sqlite");
  const database = new DatabaseSync(file);
  database.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);
    CREATE TABLE thread_items (thread_id TEXT, contents TEXT);`);
  database.prepare("INSERT INTO threads VALUES (?, ?)").run("selected", rollout);
  database.prepare("INSERT INTO threads VALUES (?, ?)").run("retained", "retained-rollout");
  database.prepare("INSERT INTO thread_items VALUES (?, ?)").run("selected", "before-backup");
  const paths = { stateDatabase: file, sessionIndex: path.join(root, "session_index.jsonl") };
  const conversation: ConversationRecord = {
    key: "codex:selected", providerId: "codex", providerName: "Codex", id: "selected", title: "selected",
    sizeBytes: 1, dataPaths: [rollout], guardPaths: [file], warnings: [],
    deleteStrategy: { kind: "local", metadata: { kind: "codex", ...paths } }
  };
  const moved: string[] = [];
  const trash = vi.fn(async (files: string[]) => {
    await fs.mkdir(path.join(home, "trash"), { recursive: true });
    for (const source of files) {
      await fs.rename(source, path.join(home, "trash", String(moved.length)));
      moved.push(source);
    }
  });
  return { home, root, file, database, paths, conversation, rollout, moved, trash };
}

async function manifest(directory: string): Promise<Manifest> {
  return JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as Manifest;
}

describe("live SQLite recovery consistency", () => {
  it.each(["update", "insert"])("rejects a selected %s after backup and preserves committed WAL in recovery", async (change) => {
    const item = await fixture();
    try {
      const plan = await prepareLiveCodexThreadsMetadata(item.home, item.paths, ["selected"], item.trash);
      await plan.prepareRecovery();
      const recovery = plan.recoveryPath!;
      if (change === "update") item.database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?")
        .run("updated-rollout", "selected");
      else item.database.prepare("INSERT INTO thread_items VALUES (?, ?)").run("selected", "after-backup");
      await expect(plan.validate()).rejects.toThrow(/Selected SQLite data changed after the recovery backup/);
      await expect(plan.execute()).rejects.toMatchObject({ metadataChanged: false, recoveryPath: recovery });
      expect(item.database.prepare("SELECT id FROM threads WHERE id = 'selected'").get()).toEqual({ id: "selected" });
      expect(item.moved).toEqual([]);
      const stored = await manifest(recovery);
      const copy = new DatabaseSync(stored.files.find((entry) => entry.originalPath === item.file)!.backupPath, { readOnly: true });
      try {
        expect(copy.prepare("SELECT rollout_path FROM threads WHERE id = 'selected'").get()).toEqual({ rollout_path: item.rollout });
        expect(copy.prepare("SELECT * FROM thread_items").all()).toEqual([{ thread_id: "selected", contents: "before-backup" }]);
      } finally { copy.close(); }
    } finally { item.database.close(); }
  });

  it("validates unrelated live updates but refuses execution without changing any rows", async () => {
    const item = await fixture();
    try {
      const plan = await prepareLiveCodexThreadsMetadata(item.home, item.paths, ["selected"], item.trash);
      await plan.prepareRecovery();
      item.database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run("updated-retained", "retained");
      item.database.exec("INSERT INTO threads VALUES ('new-thread', 'new-rollout'); CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep');");
      await expect(plan.validate()).resolves.toBeUndefined();
      await expect(plan.execute()).rejects.toMatchObject({
        message: expect.stringContaining("live cleanup is no longer supported"), metadataChanged: false, recoveryPath: plan.recoveryPath
      });
      expect(item.database.prepare("SELECT * FROM threads ORDER BY id").all()).toEqual([
        { id: "new-thread", rollout_path: "new-rollout" }, { id: "retained", rollout_path: "updated-retained" },
        { id: "selected", rollout_path: item.rollout }
      ]);
      expect(item.database.prepare("SELECT * FROM thread_items").all()).toEqual([{ thread_id: "selected", contents: "before-backup" }]);
      expect(item.database.prepare("SELECT * FROM unrelated").all()).toEqual([{ value: "keep" }]);
      expect(item.moved).toEqual([]);
      expect(item.trash).not.toHaveBeenCalled();
    } finally { item.database.close(); }
  });

  it("refuses open Codex indexes before creating a backup or invoking a selected writer", async () => {
    const item = await fixture();
    const write = fs.writeFile.bind(fs);
    let manifestWrites = 0;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await write(...args);
      if (String(args[0]).endsWith("/manifest.json")) {
        manifestWrites++;
        item.database.prepare("INSERT INTO thread_items VALUES (?, ?)").run("selected", "after-backup");
      }
    });
    try {
      const result = await deleteConversations([item.conversation], {
        home: item.home, trash: item.trash,
        checkOpenPaths: async (paths) => ({ supported: true, openPaths: paths.filter((file) => file === item.file) })
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error.message).toContain("open Codex indexes");
      expect(result.failures[0]?.recoveryPath).toBeUndefined();
      expect(manifestWrites).toBe(0);
      expect(item.moved).toEqual([]);
      expect(item.trash).not.toHaveBeenCalled();
      await expect(fs.stat(item.rollout)).resolves.toBeDefined();
      expect(item.database.prepare("SELECT * FROM threads ORDER BY id").all()).toEqual([
        { id: "retained", rollout_path: "retained-rollout" }, { id: "selected", rollout_path: item.rollout }
      ]);
      expect(item.database.prepare("SELECT * FROM thread_items").all()).toEqual([{ thread_id: "selected", contents: "before-backup" }]);
      await expect(fs.stat(path.join(item.home, ".ai-cli-cleaner", "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { item.database.close(); }
  });

  it("refuses live execution before opening a write transaction", async () => {
    const item = await fixture();
    try {
      const plan = await prepareLiveCodexThreadsMetadata(item.home, item.paths, ["selected"], item.trash);
      await plan.prepareRecovery();
      const recovery = plan.recoveryPath;
      const exec = DatabaseSync.prototype.exec;
      let changed = false;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
        if (!changed && sql === "BEGIN IMMEDIATE") {
          changed = true;
          item.database.prepare("INSERT INTO thread_items VALUES (?, ?)").run("selected", "last-moment-write");
        }
        return exec.call(this, sql);
      });
      await expect(plan.execute()).rejects.toMatchObject({
        message: expect.stringContaining("live cleanup is no longer supported"), metadataChanged: false, recoveryPath: recovery
      });
      expect(changed).toBe(false);
      expect(item.database.prepare("SELECT * FROM threads ORDER BY id").all()).toEqual([
        { id: "retained", rollout_path: "retained-rollout" }, { id: "selected", rollout_path: item.rollout }
      ]);
      expect(item.database.prepare("SELECT * FROM thread_items").all()).toEqual([{ thread_id: "selected", contents: "before-backup" }]);
      expect(item.moved).toEqual([]);
      expect(item.trash).not.toHaveBeenCalled();
    } finally { item.database.close(); }
  });

  it("refuses live execution before starting either database writer and retains the backup", async () => {
    const item = await fixture();
    const history = path.join(item.root, "thread_history_1.sqlite");
    const database = new DatabaseSync(history);
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE thread_items (thread_id TEXT, contents TEXT); INSERT INTO thread_items VALUES ('selected', 'original-history');");
    try {
      const plan = await prepareLiveCodexThreadsMetadata(item.home, { ...item.paths, threadHistoryDatabase: history }, ["selected"], item.trash);
      await plan.prepareRecovery();
      const recovery = plan.recoveryPath!;
      const exec = DatabaseSync.prototype.exec;
      let transactions = 0;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
        if (sql === "BEGIN IMMEDIATE" && ++transactions === 2) {
          database.exec("INSERT INTO thread_items VALUES ('selected', 'later-history')");
        }
        return exec.call(this, sql);
      });
      await expect(plan.execute()).rejects.toMatchObject({
        message: expect.stringContaining("live cleanup is no longer supported"), metadataChanged: false, recoveryPath: recovery
      });
      expect(transactions).toBe(0);
      expect(item.database.prepare("SELECT * FROM threads ORDER BY id").all()).toEqual([
        { id: "retained", rollout_path: "retained-rollout" }, { id: "selected", rollout_path: item.rollout }
      ]);
      expect(item.database.prepare("SELECT * FROM thread_items").all()).toEqual([{ thread_id: "selected", contents: "before-backup" }]);
      expect(database.prepare("SELECT contents FROM thread_items ORDER BY contents").all()).toEqual([
        { contents: "original-history" }
      ]);
      expect((await manifest(recovery)).files.map((entry) => entry.originalPath).sort()).toEqual([item.file, history].sort());
      expect(item.moved).toEqual([]);
      expect(item.trash).not.toHaveBeenCalled();
    } finally { database.close(); item.database.close(); }
  });
});
