import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { prepareGrokDeletion } from "../src/conversations/grok.js";
import { prepareOpenCodeDeletion } from "../src/conversations/opencode.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

describe("SQLite internal table prefix", () => {
  it.each(["opencode", "grok"] as const)("%s rejects an unknown sqlitecache user table before preparing deletion", async (provider) => {
    const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-prefix-")));
    homes.push(home);
    const root = provider === "opencode" ? path.join(home, ".local", "share", "opencode")
      : path.join(home, ".grok");
    await fs.mkdir(root, { recursive: true });
    let data: string[] = [];
    const file = provider === "opencode" ? path.join(root, "opencode.db")
      : path.join(root, "sessions", "session_search.sqlite");
    if (provider === "grok") {
      const directory = path.join(root, "sessions", "group", "selected");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "summary.json"), JSON.stringify({ info: { id: "selected" } }));
      data = [directory];
    }
    const database = new DatabaseSync(file);
    try {
      if (provider === "opencode") database.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT);
        INSERT INTO session VALUES ('selected', NULL);`);
      else database.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE session_docs (session_id TEXT PRIMARY KEY, cwd TEXT, updated_at INTEGER, title TEXT, content TEXT, content_hash TEXT);
        CREATE VIRTUAL TABLE session_docs_fts USING fts5(title, content, content='session_docs', content_rowid='rowid');
        CREATE TRIGGER session_docs_ai AFTER INSERT ON session_docs BEGIN
          INSERT INTO session_docs_fts(rowid, title, content) VALUES(new.rowid, new.title, new.content); END;
        CREATE TRIGGER session_docs_ad AFTER DELETE ON session_docs BEGIN
          INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content); END;
        INSERT INTO session_docs VALUES ('selected', '/fixtures', 1, 'selected', 'selected content', 'hash');`);
      database.exec("CREATE TABLE sqlitecache (session_id TEXT, content TEXT); INSERT INTO sqlitecache VALUES ('selected', 'private content')");
    } finally {
      database.close();
    }
    const before = await fs.readFile(file);
    const conversation: ConversationRecord = {
      key: `${provider}:selected`, providerId: provider, providerName: provider, id: "selected", title: "selected",
      sizeBytes: 1, dataPaths: data, guardPaths: [], warnings: [], deleteStrategy: { kind: "indexed" }
    };
    const prepare = provider === "opencode" ? prepareOpenCodeDeletion : prepareGrokDeletion;
    const expectedError = provider === "opencode"
      ? /Unsupported OpenCode tables/
      : /Unsupported Grok search index tables/;
    await expect(prepare(conversation, home)).rejects.toThrow(expectedError);
    expect(await fs.readFile(file)).toEqual(before);
    await expect(fs.lstat(path.join(home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
