import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";
import type { ConversationRecord } from "../src/conversations/types.js";
import { deleteConversations } from "../src/conversations/delete.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

describe("selected conversation isolation", () => {
  it.each(["cascade", "trigger"])("rejects Codex %s changes to retained conversations before touching source files", async (mode) => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    const rollout = path.join(root, "sessions", "selected.jsonl");
    await fs.mkdir(path.dirname(rollout), { recursive: true });
    await fs.writeFile(rollout, JSON.stringify({ type: "session_meta", payload: { id: "selected" } }) + "\n");
    const file = path.join(root, "state_5.sqlite");
    const database = new DatabaseSync(file);
    database.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, parent TEXT REFERENCES threads(id) ON DELETE CASCADE);
      CREATE TABLE thread_items (thread_id TEXT, item TEXT);
      INSERT INTO thread_items VALUES ('selected', 'remove'), ('retained', 'keep');`);
    database.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("selected", rollout, null);
    database.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("retained", "", mode === "cascade" ? "selected" : null);
    if (mode === "trigger") database.exec("CREATE TRIGGER change_other AFTER DELETE ON threads BEGIN UPDATE thread_items SET item='changed' WHERE thread_id='retained'; END");
    database.close();
    const original = await fs.readFile(file);
    const conversation: ConversationRecord = {
      key: "codex:selected", providerId: "codex", providerName: "Codex", id: "selected", title: "selected",
      sizeBytes: 1, dataPaths: [rollout], guardPaths: [], warnings: [],
      deleteStrategy: { kind: "local", metadata: { kind: "codex", stateDatabase: file, sessionIndex: path.join(root, "session_index.jsonl") } }
    };
    const trashed: string[] = [];
    const result = await deleteConversations([conversation], options(home, trashed));
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]?.error.message).toMatch(/Unselected data in .* changed/);
    expect(trashed).toEqual([]);
    expect(await fs.readFile(file)).toEqual(original);
    expect(await fs.readFile(rollout, "utf8")).toContain("selected");
  });

  it.each(["cascade", "trigger"])("rejects Antigravity %s changes to retained summaries and related rows", async (mode) => {
    const home = await makeHome();
    const root = path.join(home, ".gemini", "antigravity-cli");
    const directory = path.join(root, "brain", "selected");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "artifact.txt"), "selected content");
    const file = path.join(root, "conversation_summaries.db");
    const database = new DatabaseSync(file);
    database.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent TEXT REFERENCES conversation_summaries(conversation_id) ON DELETE CASCADE);
      CREATE TABLE retained_notes (conversation_id TEXT, body TEXT);
      INSERT INTO retained_notes VALUES ('retained', 'keep');
      INSERT INTO conversation_summaries VALUES ('selected', NULL);`);
    database.prepare("INSERT INTO conversation_summaries VALUES (?, ?)").run("retained", mode === "cascade" ? "selected" : null);
    if (mode === "trigger") database.exec("CREATE TRIGGER change_other AFTER DELETE ON conversation_summaries BEGIN UPDATE retained_notes SET body='changed' WHERE conversation_id='retained'; END");
    database.close();
    const original = await fs.readFile(file);
    const conversation: ConversationRecord = {
      key: "antigravity:selected", providerId: "antigravity", providerName: "Antigravity", id: "selected", title: "selected",
      sizeBytes: 1, dataPaths: [directory], guardPaths: [], warnings: [],
      deleteStrategy: { kind: "local", metadata: { kind: "antigravity", summaryDatabase: file } }
    };
    const trashed: string[] = [];
    const result = await deleteConversations([conversation], options(home, trashed));
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]?.error.message).toMatch(/Unselected data in .* changed/);
    expect(trashed).toEqual([]);
    expect(await fs.readFile(file)).toEqual(original);
    expect(await fs.readFile(path.join(directory, "artifact.txt"), "utf8")).toBe("selected content");
  });

  it("refuses discovery when an unsupported Codex database version exists", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "state_6.sqlite"), "unknown schema");
    await fs.writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: "selected", thread_name: "selected" }) + "\n");
    const result = await discoverConversations(["codex"], { home });
    expect(result.conversations).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/Unsupported Codex conversation databases detected.*state_6/);
  });

  it("removes Codex input history and index-only entries while retained content stays readable", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(root, { recursive: true });
    const retained = { id: "selected-longer", thread_name: "keep" };
    await fs.writeFile(path.join(root, "session_index.jsonl"), [
      { id: "selected", thread_name: "remove" }, retained
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const history = path.join(root, "history.jsonl");
    const retainedHistory = JSON.stringify({ session_id: retained.id, text: "selected is only text" });
    await fs.writeFile(history, JSON.stringify({ session_id: "selected", text: "remove" }) + "\n" + retainedHistory + "\n");
    const before = await discoverConversations(["codex"], { home });
    const selected = before.conversations.find((item) => item.id === "selected")!;
    expect(selected).toBeDefined();
    const trashed: string[] = [];
    const result = await deleteConversations([selected], options(home, trashed));
    expect(result.failures).toEqual([]);
    expect(result.deleted.map((item) => item.id)).toEqual(["selected"]);
    expect(await fs.readFile(history, "utf8")).toBe(retainedHistory + "\n");
    expect(await fs.readFile(path.join(root, "session_index.jsonl"), "utf8")).toBe(JSON.stringify(retained) + "\n");
    expect(trashed.some((file) => file.includes("recovery"))).toBe(true);
    const after = await discoverConversations(["codex"], { home });
    expect(after.warnings).toEqual([]);
    expect(after.conversations.map((item) => item.id)).toEqual([retained.id]);
  });

  it("rejects a Copilot cascade that would change another session before moving any data", async () => {
    const home = await makeHome();
    const root = path.join(home, ".copilot");
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "session-store.db");
    const database = new DatabaseSync(file);
    database.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE events (session_id TEXT REFERENCES sessions(id), parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, body TEXT);
      INSERT INTO sessions VALUES ('selected'), ('retained');
      INSERT INTO events VALUES ('retained', 'selected', 'keep');`);
    database.close();
    const before = await fs.readFile(file);
    const discovery = await discoverConversations(["copilot"], { home });
    const trashed: string[] = [];
    const result = await deleteConversations(discovery.conversations.filter((item) => item.id === "selected"), options(home, trashed));
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]?.error.message).toMatch(/Unselected data in .* changed/);
    expect(trashed).toEqual([]);
    expect(await fs.readFile(file)).toEqual(before);
  });

  it("preserves Copilot FTS results, blobs and 64-bit integers when sharing retention checks", async () => {
    const home = await makeHome();
    const root = path.join(home, ".copilot");
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "session-store.db");
    const database = new DatabaseSync(file);
    database.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE events (session_id TEXT, body TEXT, sequence INTEGER, data BLOB);
      CREATE VIRTUAL TABLE events_fts USING fts5(session_id UNINDEXED, body);
      CREATE TRIGGER events_insert AFTER INSERT ON events BEGIN INSERT INTO events_fts VALUES(new.session_id, new.body); END;
      CREATE TRIGGER events_delete AFTER DELETE ON events BEGIN DELETE FROM events_fts WHERE session_id = old.session_id; END;
      INSERT INTO sessions VALUES ('selected'), ('retained');`);
    const insert = database.prepare("INSERT INTO events VALUES (?, ?, ?, ?)");
    insert.run("selected", "remove", 1n, Buffer.from([1]));
    insert.run("retained", "searchable", 9223372036854775807n, Buffer.from([0, 255, 42]));
    database.close();
    const discovery = await discoverConversations(["copilot"], { home });
    const result = await deleteConversations(discovery.conversations.filter((item) => item.id === "selected"), options(home, []));
    expect(result.failures).toEqual([]);
    const checked = new DatabaseSync(file, { readOnly: true });
    try {
      const query = checked.prepare("SELECT * FROM events");
      query.setReadBigInts(true);
      expect(query.all()).toEqual([{ session_id: "retained", body: "searchable", sequence: 9223372036854775807n,
        data: new Uint8Array([0, 255, 42]) }]);
      expect(checked.prepare("SELECT session_id FROM events_fts WHERE events_fts MATCH 'searchable'").all()).toEqual([{ session_id: "retained" }]);
      expect(checked.prepare("SELECT session_id FROM events_fts WHERE events_fts MATCH 'remove'").all()).toEqual([]);
    } finally { checked.close(); }
  });

  it("finds Copilot DB-only sessions and preserves retained foreign-key data", async () => {
    const home = await makeHome();
    const root = path.join(home, ".copilot");
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "session-store.db");
    const database = new DatabaseSync(file);
    database.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE events (session_id TEXT REFERENCES sessions(id), body TEXT);
      INSERT INTO sessions VALUES ('selected'), ('retained');
      INSERT INTO events VALUES ('selected', 'remove'), ('retained', 'selected is just text');`);
    database.close();
    const before = await discoverConversations(["copilot"], { home });
    expect(before.warnings).toEqual([]);
    expect(before.conversations).toHaveLength(2);
    const result = await deleteConversations(before.conversations.filter((item) => item.id === "selected"), options(home, []));
    expect(result.failures).toEqual([]);
    const checked = new DatabaseSync(file);
    try {
      expect(checked.prepare("SELECT * FROM sessions").all()).toEqual([{ id: "retained" }]);
      expect(checked.prepare("SELECT * FROM events").all()).toEqual([{ session_id: "retained", body: "selected is just text" }]);
      expect(checked.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(checked.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally { checked.close(); }
    const after = await discoverConversations(["copilot"], { home });
    expect(after.warnings).toEqual([]);
    expect(after.conversations.map((item) => item.id)).toEqual(["retained"]);
  });
});

async function makeHome(): Promise<string> {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-isolation-")));
  homes.push(home);
  return home;
}

function options(home: string, trashed: string[]) {
  let counter = 0;
  return {
    home,
    checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
    trash: async (paths: string[]) => {
      for (const file of paths) {
        const destination = path.join(home, "trash", String(counter++));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(file, destination);
        trashed.push(file);
      }
    }
  };
}
