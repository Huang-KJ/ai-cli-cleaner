import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCodexThreadsMetadata } from "../src/conversations/codex-metadata.js";
import { deleteConversations } from "../src/conversations/delete.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});

async function fixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-codex-preview-")));
  homes.push(home);
  const root = path.join(home, ".codex");
  const rollout = path.join(root, "sessions", "selected.jsonl");
  await fs.mkdir(path.dirname(rollout), { recursive: true });
  await fs.writeFile(rollout, JSON.stringify({ payload: { id: "selected" } }) + "\n");
  const file = path.join(root, "state_5.sqlite");
  // 保持寫入連線開啟，模擬執行中的代理。
  const database = new DatabaseSync(file);
  database.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);
    CREATE TABLE thread_items (thread_id TEXT, contents TEXT);`);
  database.prepare("INSERT INTO threads VALUES (?, ?)").run("selected", rollout);
  database.prepare("INSERT INTO threads VALUES (?, ?)").run("retained", "retained-rollout");
  database.prepare("INSERT INTO thread_items VALUES (?, ?)").run("selected", "before-preview");
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
  const rows = () => ({
    threads: database.prepare("SELECT * FROM threads ORDER BY id").all(),
    items: database.prepare("SELECT * FROM thread_items ORDER BY contents").all()
  });
  return { home, root, file, database, paths, conversation, rollout, moved, trash, rows };
}

describe("Codex preview metadata plans", () => {
  it("tolerates a running agent's writes but never backs up or rewrites metadata", async () => {
    const item = await fixture();
    try {
      const plan = await prepareCodexThreadsMetadata(item.home, item.paths, ["selected"], item.trash, [], { preview: true });
      expect(plan.operations).toEqual(["Selected Codex conversations metadata: state_5.sqlite"]);
      item.database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run("updated-retained", "retained");
      item.database.prepare("INSERT INTO thread_items VALUES (?, ?)").run("selected", "during-preview");
      const before = item.rows();
      await expect(plan.validate()).resolves.toBeUndefined();
      await expect(plan.prepareRecovery()).rejects.toThrow("A preview plan cannot create deletion backups.");
      await expect(plan.execute()).rejects.toMatchObject({ message: "A preview plan cannot execute deletion.", metadataChanged: false });
      expect(plan.recoveryPath).toBeUndefined();
      expect(item.rows()).toEqual(before);
      expect(item.trash).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(item.home, ".ai-cli-cleaner", "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { item.database.close(); }
  });

  it("previews selected deletion while the agent keeps its database open", async () => {
    const item = await fixture();
    try {
      const before = item.rows();
      const result = await deleteConversations([item.conversation], {
        home: item.home, trash: item.trash, dryRun: true,
        checkOpenPaths: async (paths) => ({ supported: true, openPaths: paths.filter((file) => file === item.file) })
      });
      expect(result.failures).toEqual([]);
      expect(result.previewed).toEqual([item.conversation]);
      expect(item.rows()).toEqual(before);
      expect(item.trash).not.toHaveBeenCalled();
      await expect(fs.stat(item.rollout)).resolves.toBeDefined();
      await expect(fs.stat(path.join(item.home, ".ai-cli-cleaner", "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { item.database.close(); }
  });

  it("refuses open Codex indexes before creating a backup or invoking a selected writer", async () => {
    const item = await fixture();
    const write = fs.writeFile.bind(fs);
    let manifestWrites = 0;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await write(...args);
      if (String(args[0]).endsWith("/manifest.json")) manifestWrites++;
    });
    try {
      const before = item.rows();
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
      expect(item.rows()).toEqual(before);
      await expect(fs.stat(path.join(item.home, ".ai-cli-cleaner", "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { item.database.close(); }
  });
});
