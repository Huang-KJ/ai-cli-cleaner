import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteConversations } from "../src/conversations/delete.js";
import { getCodexMetadataPaths } from "../src/conversations/codex-paths.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});

async function fixture(count = 2, live = false) {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-codex-batch-")));
  homes.push(home);
  const root = path.join(home, ".codex");
  const paths = getCodexMetadataPaths(home);
  await fs.mkdir(path.join(root, "sessions"), { recursive: true });
  const database = new DatabaseSync(paths.stateDatabase);
  if (live) database.exec("PRAGMA journal_mode = WAL");
  database.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
    CREATE TABLE thread_items (thread_id TEXT, contents TEXT);`);
  const ids = [...Array.from({ length: count }, (_, index) => index ? `child-${index}` : "parent"), "parent-longer", "keep-child"];
  const conversations: ConversationRecord[] = [];
  for (const [index, id] of ids.entries()) {
    const file = path.join(root, "sessions", `${id}.jsonl`);
    await fs.writeFile(file, JSON.stringify({ payload: { id } }) + "\n");
    database.prepare("INSERT INTO threads VALUES (?, ?)").run(id, file);
    database.prepare("INSERT INTO thread_items VALUES (?, ?)").run(id, `contents-${id}`);
    if (index && index < count) database.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?)").run("parent", id);
    if (index < count) conversations.push({
      key: `codex:${id}`, providerId: "codex", providerName: "Codex", id, title: id,
      parentId: index ? "parent" : undefined,
      sizeBytes: 1, dataPaths: [file], guardPaths: [paths.stateDatabase], warnings: [],
      deleteStrategy: { kind: "local", metadata: { kind: "codex", ...paths } }
    });
  }
  database.exec("INSERT INTO thread_spawn_edges VALUES ('keep-child', 'parent-longer')");
  const logs = new DatabaseSync(paths.logsDatabase!);
  logs.exec("CREATE TABLE logs (thread_id TEXT, message TEXT)");
  for (const id of ids) logs.prepare("INSERT INTO logs VALUES (?, ?)").run(id, `log-${id}`);
  logs.close();
  await fs.writeFile(paths.sessionIndex, ids.map((id) => JSON.stringify({ id })).join("\n") + "\n");
  await fs.writeFile(paths.historyFile!, ids.map((session_id) => JSON.stringify({ session_id })).join("\n") + "\n");
  await fs.writeFile(paths.globalStateFiles![0]!, JSON.stringify({
    "pinned-thread-ids": ids, "thread-project-assignments": Object.fromEntries(ids.map((id) => [id, "project"])),
    "electron-thread-read-state-v1": { local: Object.fromEntries(ids.map((id) => [id, true])), remote: { parent: true } },
    customSetting: "parent"
  }));
  if (!live) database.close();
  const calls: string[][] = [];
  const moved: string[] = [];
  const trash = async (files: string[]) => {
    calls.push(files);
    await fs.mkdir(path.join(home, "fake-trash"), { recursive: true });
    for (const source of files) {
      await fs.rename(source, path.join(home, "fake-trash", String(moved.length)));
      moved.push(source);
    }
  };
  const check = vi.fn(async (files: string[]) => ({ supported: true,
    openPaths: live ? files.filter((file) => file === paths.stateDatabase) : [] }));
  const options = { home, trash, checkOpenPaths: check };
  return { home, root, paths, database, conversations, ids, calls, moved, options };
}

function state(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      threads: database.prepare("SELECT id FROM threads ORDER BY id").all(),
      items: database.prepare("SELECT * FROM thread_items ORDER BY thread_id").all(),
      edges: database.prepare("SELECT * FROM thread_spawn_edges").all()
    };
  } finally { database.close(); }
}

describe("Codex selected batch deletion", () => {
  it.each([false, true])("enforces offline scope for one conversation; live=%s", async (live) => {
    const item = await fixture(1, live);
    try {
      const selected = item.conversations[0]!;
      const archived = path.join(item.root, "archived_sessions", "copy-parent.jsonl");
      await fs.mkdir(path.dirname(archived));
      await fs.writeFile(archived, JSON.stringify({ payload: { id: selected.id } }) + "\n");
      selected.dataPaths.push(archived);

      const result = await deleteConversations([selected], item.options);

      if (live) {
        expect(result.deleted).toEqual([]);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]?.error.message).toContain("open Codex indexes");
        expect(item.moved).toEqual([]);
        expect(state(item.paths.stateDatabase).threads).toHaveLength(3);
        return;
      }

      expect(result.failures).toEqual([]);
      expect(result.deleted).toEqual([selected]);
      expect(item.calls.filter((files) => files.some((file) => selected.dataPaths.includes(file))))
        .toEqual(selected.dataPaths.map((file) => [file]));
      expect(item.moved.filter((file) => file.includes("/recovery/"))).toHaveLength(1);
      expect(state(item.paths.stateDatabase).threads).toEqual([{ id: "keep-child" }, { id: "parent-longer" }]);
    } finally { if (live) item.database.close(); }
  });

  it("previews one conversation without checking occupancy, staging, or moving data", async () => {
    const item = await fixture(1);
    const result = await deleteConversations(item.conversations, { ...item.options, dryRun: true });
    expect(result.previewed).toEqual(item.conversations);
    expect(result.failures).toEqual([]);
    expect(item.options.checkOpenPaths).not.toHaveBeenCalled();
    expect(item.moved).toEqual([]);
    await expect(fs.stat(path.join(item.home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(state(item.paths.stateDatabase).threads).toHaveLength(3);
  });

  // 大量 SQLite 寫入、備份與檔案重驗需要獨立的 CI I/O 預算。
  it.each([false, true])("enforces offline scope for 121 selected parents and children; live=%s", async (live) => {
    const item = await fixture(121, live);
    try {
      let lastChecked: string[] = [];
      const result = await deleteConversations([...item.conversations, item.conversations[0]!], { ...item.options,
        checkOpenPaths: async (files) => { lastChecked = files; return item.options.checkOpenPaths(files); },
        trash: async (files) => {
          if (files.some((file) => file.includes("/sessions/"))) {
            expect(lastChecked).toEqual(expect.arrayContaining([item.paths.stateDatabase,
              `${item.paths.stateDatabase}-wal`, `${item.paths.stateDatabase}-shm`, `${item.paths.stateDatabase}-journal`]));
          }
          await item.options.trash(files);
        }
      });
      if (live) {
        expect(result.deleted).toEqual([]);
        expect(result.failures).toHaveLength(121);
        expect(result.failures.every((failure) => failure.error.message.includes("open Codex indexes"))).toBe(true);
        expect(item.moved).toEqual([]);
        expect(state(item.paths.stateDatabase).threads).toHaveLength(123);
        return;
      }
      expect(result.failures).toEqual([]);
      expect(result.deleted).toHaveLength(121);
      expect(item.calls.filter((files) => files.some((file) => file.includes("/sessions/"))).map((files) => files.length)).toEqual([64, 57]);
      const backupIndex = item.moved.findIndex((file) => file.includes("/recovery/"));
      expect(item.moved.filter((file) => file.includes("/recovery/"))).toHaveLength(1);
      const backup = path.join(item.home, "fake-trash", String(backupIndex));
      const manifest = JSON.parse(await fs.readFile(path.join(backup, "manifest.json"), "utf8")) as {
        conversationIds: string[]; files: Array<{ originalPath: string; backupPath: string }>;
      };
      expect(manifest.conversationIds.sort()).toEqual(item.conversations.map((row) => row.id).sort());
      const copied = manifest.files.find((file) => file.originalPath === item.paths.stateDatabase)!;
      const restored = state(path.join(backup, path.basename(copied.backupPath)));
      expect(restored.threads).toHaveLength(123);
      expect(state(item.paths.stateDatabase)).toEqual({
        threads: [{ id: "keep-child" }, { id: "parent-longer" }],
        items: [{ thread_id: "keep-child", contents: "contents-keep-child" }, { thread_id: "parent-longer", contents: "contents-parent-longer" }],
        edges: [{ parent_thread_id: "keep-child", child_thread_id: "parent-longer" }]
      });
      expect(await fs.readFile(item.paths.sessionIndex, "utf8")).toBe('{"id":"parent-longer"}\n{"id":"keep-child"}\n');
      expect(await fs.readFile(item.paths.historyFile!, "utf8")).toBe('{"session_id":"parent-longer"}\n{"session_id":"keep-child"}\n');
      expect(JSON.parse(await fs.readFile(item.paths.globalStateFiles![0]!, "utf8"))).toMatchObject({
        "pinned-thread-ids": ["parent-longer", "keep-child"],
        "electron-thread-read-state-v1": { remote: { parent: true } }, customSetting: "parent"
      });
      const logs = new DatabaseSync(item.paths.logsDatabase!, { readOnly: true });
      try { expect(logs.prepare("SELECT thread_id FROM logs ORDER BY thread_id").all()).toEqual([{ thread_id: "keep-child" }, { thread_id: "parent-longer" }]); }
      finally { logs.close(); }
    } finally { if (live) item.database.close(); }
  }, 15_000);

  it.each(["rollout", "json", "unsupported"])("rejects %s before any source movement", async (kind) => {
    const item = await fixture();
    const result = await deleteConversations(item.conversations, { ...item.options,
      checkOpenPaths: async (files) => ({ supported: kind !== "unsupported", openPaths: files.filter((file) =>
        file === (kind === "json" ? item.paths.sessionIndex : item.conversations[1]!.dataPaths[0])) })
    });
    expect(result.failures).toHaveLength(2);
    expect(item.moved).toEqual([]);
    expect(state(item.paths.stateDatabase).threads).toHaveLength(4);
  });

  it("previews the full batch without backup or Trash", async () => {
    const item = await fixture();
    const result = await deleteConversations(item.conversations, { ...item.options, dryRun: true });
    expect(result.previewed).toEqual(item.conversations);
    expect(result.failures).toEqual([]);
    expect(item.moved).toEqual([]);
    expect(item.options.checkOpenPaths).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(item.home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unlisted rollout added after staging before moving any source", async () => {
    const item = await fixture();
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await write(...args);
      if (String(args[0]).endsWith("/manifest.json")) {
        await write(path.join(item.root, "sessions", "unlisted-copy.jsonl"), '{"payload":{"id":"child-1"}}\n');
      }
    });
    const result = await deleteConversations(item.conversations, item.options);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.every((row) => /added or removed after discovery/.test(row.error.message) && row.recoveryPath)).toBe(true);
    expect(item.moved).toEqual([]);
    expect(state(item.paths.stateDatabase).threads).toHaveLength(4);
  });

  it("keeps one backup and per-conversation partial paths when a source batch fails", async () => {
    const item = await fixture();
    const result = await deleteConversations(item.conversations, { ...item.options, trash: async (files) => {
      await item.options.trash([files[0]!]);
      throw new Error("partial Trash failure");
    } });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]?.deletedPaths).toEqual(item.conversations[0]!.dataPaths);
    expect(result.failures[1]?.deletedPaths).toEqual([]);
    const recovery = result.failures[0]!.recoveryPath!;
    expect(result.failures[1]?.recoveryPath).toBe(recovery);
    await expect(fs.stat(path.join(recovery, "manifest.json"))).resolves.toBeDefined();
    expect(state(item.paths.stateDatabase).threads).toHaveLength(4);
  });

  it("rejects database updates after offline staging without overwriting retained changes", async () => {
    const item = await fixture();
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await write(...args);
      if (String(args[0]).endsWith("/manifest.json")) {
        const writer = new DatabaseSync(item.paths.stateDatabase);
        try { writer.exec("INSERT INTO thread_items VALUES ('child-1', 'new-selected'); UPDATE thread_items SET contents = 'new-retained' WHERE thread_id = 'keep-child'"); }
        finally { writer.close(); }
      }
    });
    try {
      const result = await deleteConversations(item.conversations, item.options);
      expect(result.failures).toHaveLength(2);
      expect(result.failures[0]?.error.message).toMatch(/changed/i);
      expect(item.moved).toEqual([]);
      expect(state(item.paths.stateDatabase).items).toContainEqual({ thread_id: "keep-child", contents: "new-retained" });
    } finally { if (item.database.isOpen) item.database.close(); }
  });

  it("refuses database writes during batch movement and preserves their contents", async () => {
    const item = await fixture();
    try {
      const result = await deleteConversations(item.conversations, { ...item.options, trash: async (files) => {
        if (files.some((file) => file.includes("/sessions/"))) {
          const writer = new DatabaseSync(item.paths.stateDatabase);
          try { writer.exec("UPDATE thread_items SET contents = 'live-retained' WHERE thread_id = 'keep-child'"); }
          finally { writer.close(); }
        }
        await item.options.trash(files);
      } });
      expect(result.deleted).toEqual([]);
      expect(result.failures).toHaveLength(2);
      expect(state(item.paths.stateDatabase).threads).toHaveLength(4);
      expect(state(item.paths.stateDatabase).items).toContainEqual({ thread_id: "keep-child", contents: "live-retained" });
    } finally { if (item.database.isOpen) item.database.close(); }
  });

  it("rejects a cascade into an unselected child during preflight", async () => {
    const item = await fixture();
    const database = new DatabaseSync(item.paths.stateDatabase);
    database.exec("CREATE TRIGGER erase_retained AFTER DELETE ON threads WHEN old.id = 'parent' BEGIN DELETE FROM threads WHERE id = 'keep-child'; END");
    database.close();
    const result = await deleteConversations(item.conversations, item.options);
    expect(result.failures).toHaveLength(2);
      expect(result.failures[0]?.error.message).toMatch(/Unselected data in .* changed/);
    expect(item.moved).toEqual([]);
    expect(state(item.paths.stateDatabase).threads).toHaveLength(4);
  });

  it("deletes only selected children while their parent and other children remain", async () => {
    const item = await fixture(4);
    const result = await deleteConversations(item.conversations.slice(1, 3), item.options);
    expect(result.failures).toEqual([]);
    expect(state(item.paths.stateDatabase).threads).toEqual([
      { id: "child-3" }, { id: "keep-child" }, { id: "parent" }, { id: "parent-longer" }
    ]);
    expect(state(item.paths.stateDatabase).edges).toEqual([
      { parent_thread_id: "parent", child_thread_id: "child-3" },
      { parent_thread_id: "keep-child", child_thread_id: "parent-longer" }
    ]);
    await expect(fs.readFile(item.conversations[0]!.dataPaths[0]!, "utf8")).resolves.toContain('"parent"');
  });

  it("updates index-only conversations in the shared batch", async () => {
    const item = await fixture();
    for (const conversation of item.conversations) {
      await fs.rename(conversation.dataPaths[0]!, path.join(item.home, `${conversation.id}-relocated.jsonl`));
      conversation.dataPaths = [];
    }
    const result = await deleteConversations(item.conversations, item.options);
    expect(result.failures).toEqual([]);
    expect(result.deleted).toHaveLength(2);
    expect(item.calls).toHaveLength(1);
    expect(state(item.paths.stateDatabase).threads).toEqual([{ id: "keep-child" }, { id: "parent-longer" }]);
  });

  it("rejects a recreated selected rollout before updating any indexes", async () => {
    const item = await fixture();
    const result = await deleteConversations(item.conversations, { ...item.options, trash: async (files) => {
      await item.options.trash(files);
      await fs.writeFile(item.conversations[1]!.dataPaths[0]!, '{"payload":{"id":"child-1"}}\n');
    } });
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]?.recoveryPath).toBeDefined();
      expect(result.failures[0]?.error.message).toMatch(/Original path still exists after the Trash operation/);
    expect(state(item.paths.stateDatabase).threads).toHaveLength(4);
  });

  it("refuses a database reopened after source movement before rewriting indexes", async () => {
    const item = await fixture();
    let reopened = false;
    const result = await deleteConversations(item.conversations, { ...item.options,
      checkOpenPaths: async (files) => ({ supported: true, openPaths: reopened ? files.filter((file) => file === item.paths.stateDatabase) : [] }),
      trash: async (files) => { await item.options.trash(files); reopened = true; }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]?.error.message).toContain("open Codex indexes");
    expect(result.failures[0]?.recoveryPath).toBeDefined();
    expect(state(item.paths.stateDatabase).threads).toHaveLength(4);
  });

  // 此案例另建立 64 筆 rollout，並驗證資料庫與 sidecar 的批次邊界。
  it("keeps SQLite artifacts and their sidecars together at the batch boundary", async () => {
    const item = await fixture(62);
    const selected = item.conversations.at(-1)!;
    const file = path.join(item.root, "shell_snapshots", `${selected.id}.sqlite`);
    await fs.mkdir(path.dirname(file));
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.writeFile(`${file}${suffix}`, "synthetic artifact");
      selected.dataPaths.push(`${file}${suffix}`);
    }
    const result = await deleteConversations(item.conversations, item.options);
    expect(result.failures).toEqual([]);
    expect(item.calls.slice(0, 2).map((files) => files.length)).toEqual([62, 3]);
    expect(item.calls[1]).toEqual([file, `${file}-wal`, `${file}-shm`]);
  }, 15_000);
});
