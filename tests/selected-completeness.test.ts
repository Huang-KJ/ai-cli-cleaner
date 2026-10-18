import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteConversations } from "../src/conversations/delete.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

describe("selected SQLite deletion completeness", () => {
  it("protects retained sqlitecache rows before moving conversation data", async () => {
    const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-prefix-")));
    homes.push(home);
    const root = path.join(home, ".gemini", "antigravity-cli");
    const data = path.join(root, "brain", "selected");
    const content = path.join(data, "artifact.txt");
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(content, "selected artifact");
    const file = path.join(root, "conversation_summaries.db");
    const database = new DatabaseSync(file);
    try {
      database.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY);
        CREATE TABLE sqlitecache (conversation_id TEXT, body TEXT);
        INSERT INTO conversation_summaries VALUES ('selected'), ('retained');
        INSERT INTO sqlitecache VALUES ('retained', 'keep');
        CREATE TRIGGER remove_cache AFTER DELETE ON conversation_summaries
          WHEN old.conversation_id = 'selected' BEGIN
            DELETE FROM sqlitecache WHERE conversation_id = 'retained'; END`);
    } finally { database.close(); }
    const original = await fs.readFile(file);
    const originalData = await fs.readFile(content);
    const conversation: ConversationRecord = {
      key: "antigravity:selected", providerId: "antigravity", providerName: "Antigravity", id: "selected", title: "selected",
      sizeBytes: 1, dataPaths: [data], guardPaths: [], warnings: [],
      deleteStrategy: { kind: "local", metadata: { kind: "antigravity", summaryDatabase: file } }
    };
    const trashed: string[] = [];
    const result = await deleteConversations([conversation], {
      home, checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: async (paths) => {
        for (const source of paths) {
          const destination = path.join(home, "trash", String(trashed.length));
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.rename(source, destination);
          trashed.push(source);
        }
      }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(/Unselected data in sqlitecache changed/);
    expect(trashed).toEqual([]);
    expect(await fs.readFile(file)).toEqual(original);
    expect(await fs.readFile(content)).toEqual(originalData);
  });

  it.each([
    ["codex", "ignore"], ["codex", "reinsert"],
    ["copilot", "ignore"], ["copilot", "reinsert"],
    ["antigravity", "ignore"], ["antigravity", "reinsert"]
  ] as const)("rejects %s %s triggers before moving conversation data", async (provider, mode) => {
    const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-completeness-")));
    homes.push(home);
    const root = path.join(home, ...(provider === "codex" ? [".codex"]
      : provider === "copilot" ? [".copilot"] : [".gemini", "antigravity-cli"]));
    const data = provider === "codex" ? path.join(root, "sessions", "selected.jsonl")
      : path.join(root, provider === "copilot" ? "session-state" : "brain", "selected");
    const content = provider === "codex" ? data : path.join(data, "events.jsonl");
    await fs.mkdir(path.dirname(content), { recursive: true });
    await fs.writeFile(content, JSON.stringify({ type: "session_meta", payload: { id: "selected" } }) + "\n");
    const file = path.join(root, provider === "codex" ? "state_5.sqlite"
      : provider === "copilot" ? "session-store.db" : "conversation_summaries.db");
    const table = provider === "codex" ? "threads" : provider === "copilot" ? "sessions" : "conversation_summaries";
    const column = provider === "antigravity" ? "conversation_id" : "id";
    const database = new DatabaseSync(file);
    try {
      database.exec(`CREATE TABLE ${table} (${column} TEXT PRIMARY KEY, rollout_path TEXT)`);
      database.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run("selected", data);
      database.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run("retained", "keep");
      if (mode === "ignore") {
        database.exec(`CREATE TRIGGER preserve_selected BEFORE DELETE ON ${table}
          WHEN old.${column} = 'selected' BEGIN SELECT RAISE(IGNORE); END`);
      } else {
        database.exec(`CREATE TRIGGER restore_selected AFTER DELETE ON ${table}
          WHEN old.${column} = 'selected' BEGIN
            INSERT INTO ${table} VALUES (old.${column}, old.rollout_path); END`);
      }
    } finally { database.close(); }
    const metadata = provider === "codex"
      ? { kind: "codex" as const, stateDatabase: file, sessionIndex: path.join(root, "session_index.jsonl") }
      : provider === "copilot" ? { kind: "copilot" as const, sessionStoreDatabase: file }
        : { kind: "antigravity" as const, summaryDatabase: file };
    const conversation: ConversationRecord = {
      key: `${provider}:selected`, providerId: provider, providerName: provider, id: "selected", title: "selected",
      sizeBytes: 1, dataPaths: [data], guardPaths: [], warnings: [],
      deleteStrategy: { kind: "local", metadata }
    };
    const original = await fs.readFile(file);
    const originalData = await fs.readFile(content);
    const trashed: string[] = [];
    const result = await deleteConversations([conversation], {
      home, checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: async (paths) => {
        for (const source of paths) {
          const destination = path.join(home, "trash", String(trashed.length));
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.rename(source, destination);
          trashed.push(source);
        }
      }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(/Selected data remains in/);
    expect(trashed).toEqual([]);
    expect(await fs.readFile(file)).toEqual(original);
    expect(await fs.readFile(content)).toEqual(originalData);
  });
});

const grokHomes: string[] = [];
afterEach(async () => {
  await Promise.all(grokHomes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

describe("Grok selected search deletion completeness", () => {
  it.each(["ignore", "reinsert"] as const)("refuses a permitted %s trigger before moving the source", async (mode) => {
    const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-grok-complete-")));
    grokHomes.push(home);
    const root = path.join(home, ".grok");
    const directory = path.join(root, "sessions", "group", "selected");
    await fs.mkdir(directory, { recursive: true });
    const summary = path.join(directory, "summary.json");
    const transcript = path.join(directory, "updates.jsonl");
    await fs.writeFile(summary, JSON.stringify({ info: { id: "selected" } }));
    await fs.writeFile(transcript, "selected private transcript\n");
    const file = path.join(root, "sessions", "session_search.sqlite");
    const database = new DatabaseSync(file);
    try {
      database.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE session_docs (session_id TEXT PRIMARY KEY, cwd TEXT, updated_at INTEGER, title TEXT, content TEXT, content_hash TEXT);
        CREATE VIRTUAL TABLE session_docs_fts USING fts5(title, content, content='session_docs', content_rowid='rowid');
        CREATE TRIGGER session_docs_ai AFTER INSERT ON session_docs BEGIN
          INSERT INTO session_docs_fts(rowid, title, content) VALUES(new.rowid, new.title, new.content); END;
        INSERT INTO session_docs VALUES ('selected', '/fixtures', 1, 'selected', 'selected private content', 'selected-hash');
        INSERT INTO session_docs VALUES ('retained', '/fixtures', 2, 'retained', 'retained private content', 'retained-hash');
        INSERT INTO meta VALUES ('version', '1');`);
      database.exec(mode === "ignore" ? `
        CREATE TRIGGER session_docs_ad BEFORE DELETE ON session_docs BEGIN SELECT RAISE(IGNORE); END;` : `
        CREATE TRIGGER session_docs_ad AFTER DELETE ON session_docs BEGIN
          INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content)
            VALUES('delete', old.rowid, old.title, old.content);
          INSERT INTO session_docs(session_id, cwd, updated_at, title, content, content_hash)
            VALUES(old.session_id, old.cwd, old.updated_at, old.title, old.content, old.content_hash); END;`);
    } finally {
      database.close();
    }
    const files = [summary, transcript, file];
    const original = await Promise.all(files.map((item) => fs.readFile(item)));
    const conversation: ConversationRecord = {
      key: "grok:selected", providerId: "grok", providerName: "Grok", id: "selected", title: "selected",
      sizeBytes: 1, dataPaths: [directory], guardPaths: [], warnings: [], deleteStrategy: { kind: "indexed" }
    };
    let moved = 0;
    const trash = vi.fn(async (paths: string[]) => {
      for (const source of paths) {
        const target = path.join(home, "trash", String(moved++));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(source, target);
      }
    });
    const result = await deleteConversations([conversation], {
      home, trash, checkOpenPaths: async () => ({ supported: true, openPaths: [] })
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(/The selected Grok conversation remains in the search index after deletion/);
    expect(trash).not.toHaveBeenCalled();
    expect(await Promise.all(files.map((item) => fs.readFile(item)))).toEqual(original);
    await expect(fs.lstat(path.join(home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
    const retained = new DatabaseSync(file, { readOnly: true });
    try {
      expect(retained.prepare("SELECT session_id FROM session_docs ORDER BY session_id").all())
        .toEqual([{ session_id: "retained" }, { session_id: "selected" }]);
    } finally {
      retained.close();
    }
  });
});
