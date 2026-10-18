import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-selected-other-")));
  homes.push(home);
  let counter = 0;
  const moved: string[] = [];
  return {
    home, moved, checkOpenPaths: async () => ({ supported: true, openPaths: [] as string[] }),
    trash: async (files: string[]) => {
      const sink = path.join(home, "trash");
      await fs.mkdir(sink, { recursive: true });
      for (const file of files) {
        await fs.rename(file, path.join(sink, String(counter++)));
        moved.push(file);
      }
    }
  };
}

describe("other selected conversation ownership", () => {
  it("deletes Copilot data linked through explicit foreign keys while preserving another session", async () => {
    const item = await fixture();
    const root = path.join(item.home, ".copilot");
    const selected = path.join(root, "session-state", "selected");
    await fs.mkdir(selected, { recursive: true });
    await fs.writeFile(path.join(selected, "events.jsonl"), "synthetic selected transcript");
    const file = path.join(root, "session-store.db");
    const database = new DatabaseSync(file);
    try {
      database.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE sessions(id TEXT PRIMARY KEY);
        CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), body TEXT);
        CREATE TABLE chunks(id TEXT PRIMARY KEY, message_id TEXT REFERENCES messages(id), body TEXT);
        CREATE TABLE details(chunk_id TEXT REFERENCES chunks(id), body TEXT);
        INSERT INTO sessions VALUES('selected'),('retained');
        INSERT INTO messages VALUES('message-a','selected','remove'),('message-b','retained','keep');
        INSERT INTO chunks VALUES('chunk-a','message-a','remove chunk'),('chunk-b','message-b','keep chunk');
        INSERT INTO details VALUES('chunk-a','remove detail'),('chunk-b','keep detail');`);
    } finally { database.close(); }
    const discovery = await discoverConversations(["copilot"], item);
    const result = await deleteConversations(discovery.conversations.filter(({ id }) => id === "selected"), item);
    expect(result.failures).toEqual([]);
    expect(result.deleted.map(({ id }) => id)).toEqual(["selected"]);
    const checked = new DatabaseSync(file, { readOnly: true });
    try {
      expect(checked.prepare("SELECT * FROM sessions").all()).toEqual([{ id: "retained" }]);
      expect(checked.prepare("SELECT * FROM messages").all()).toEqual([{ id: "message-b", session_id: "retained", body: "keep" }]);
      expect(checked.prepare("SELECT * FROM chunks").all()).toEqual([{ id: "chunk-b", message_id: "message-b", body: "keep chunk" }]);
      expect(checked.prepare("SELECT * FROM details").all()).toEqual([{ chunk_id: "chunk-b", body: "keep detail" }]);
      expect(checked.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { checked.close(); }
    await expect(fs.lstat(selected)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses conflicting Grok summary identifiers before deleting a conversation", async () => {
    const item = await fixture();
    const selected = path.join(item.home, ".grok", "sessions", "group", "selected");
    await fs.mkdir(selected, { recursive: true });
    const file = path.join(selected, "summary.json");
    const contents = JSON.stringify({ info: { id: "selected", session_id: "retained" } });
    await fs.writeFile(file, contents);
    const discovery = await discoverConversations(["grok"], item);
    expect(discovery.conversations[0]?.disabledReason).toMatch(/identifiers conflict/);
    const result = await deleteConversations(discovery.conversations, item);
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(item.moved).toEqual([]);
    expect(await fs.readFile(file, "utf8")).toBe(contents);
  });

  it("refuses Copilot foreign-key rows shared by selected and retained messages", async () => {
    const item = await fixture();
    const root = path.join(item.home, ".copilot");
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "session-store.db");
    const database = new DatabaseSync(file);
    try {
      database.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY);
        CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id));
        CREATE TABLE links(left_id TEXT REFERENCES messages(id), right_id TEXT REFERENCES messages(id), body TEXT);
        INSERT INTO sessions VALUES('selected'),('retained');
        INSERT INTO messages VALUES('message-a','selected'),('message-b','retained');
        INSERT INTO links VALUES('message-a','message-b','shared content');`);
    } finally { database.close(); }
    const original = await fs.readFile(file);
    const discovery = await discoverConversations(["copilot"], item);
    const result = await deleteConversations(discovery.conversations.filter(({ id }) => id === "selected"), item);
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(item.moved).toEqual([]);
    expect(await fs.readFile(file)).toEqual(original);
  });

  it.each(["missing", "synchronized"] as const)("handles Copilot external-content indexes with %s DELETE synchronization", async (mode) => {
    const item = await fixture();
    const root = path.join(item.home, ".copilot");
    const selected = path.join(root, "session-state", "selected");
    await fs.mkdir(selected, { recursive: true });
    const transcript = path.join(selected, "events.jsonl");
    await fs.writeFile(transcript, "selected transcript");
    const file = path.join(root, "session-store.db");
    const database = new DatabaseSync(file);
    try {
      database.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY);
        CREATE TABLE messages(session_id TEXT, body TEXT);
        CREATE VIRTUAL TABLE messages_fts USING fts5(session_id UNINDEXED, body, content='messages');
        INSERT INTO sessions VALUES('selected'),('retained');
        INSERT INTO messages VALUES('selected','selectedsecret'),('retained','retainedsecret');
        INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`);
      if (mode === "synchronized") {
        database.exec(`CREATE TRIGGER messages_delete AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, session_id, body)
            VALUES('delete', old.rowid, old.session_id, old.body); END;`);
      }
      expect(database.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'selectedsecret'").all()).toEqual([{ rowid: 1 }]);
    } finally { database.close(); }
    const original = await fs.readFile(file);
    const discovery = await discoverConversations(["copilot"], item);
    const result = await deleteConversations(discovery.conversations.filter(({ id }) => id === "selected"), item);
    if (mode === "missing") {
      expect(result.deleted).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(item.moved).toEqual([]);
      expect(await fs.readFile(file)).toEqual(original);
      expect(await fs.readFile(transcript, "utf8")).toBe("selected transcript");
    } else {
      expect(result.failures).toEqual([]);
      expect(result.deleted.map(({ id }) => id)).toEqual(["selected"]);
      await expect(fs.lstat(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const checked = new DatabaseSync(file, { readOnly: true });
    try {
      expect(checked.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'selectedsecret'").all())
        .toEqual(mode === "missing" ? [{ rowid: 1 }] : []);
      expect(checked.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'retainedsecret'").all()).toEqual([{ rowid: 2 }]);
      expect(checked.prepare("SELECT * FROM messages WHERE session_id='retained'").all())
        .toEqual([{ session_id: "retained", body: "retainedsecret" }]);
    } finally { checked.close(); }
  });
});
