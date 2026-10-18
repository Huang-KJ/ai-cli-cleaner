import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCodexThreadsMetadata } from "../src/conversations/codex-metadata.js";
import { prepareGrokDeletion } from "../src/conversations/grok.js";
import { getCodexMetadataPaths } from "../src/conversations/codex-paths.js";
import { antigravityHistoryId } from "../src/conversations/metadata-values.js";
import type { ConversationRecord } from "../src/conversations/types.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

describe("Antigravity unrelated history rows", () => {
  it("accepts a system row without conversation aliases", () => {
    expect(antigravityHistoryId({ system: true })).toBeUndefined();
  });
  it("accepts a named conversation ID with matching aliases", () => {
    expect(antigravityHistoryId({ conversationId: "selected", conversation_id: "selected" })).toBe("selected");
  });
});

async function fixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-security-metadata-")));
  homes.push(home);
  await fs.mkdir(path.join(home, ".codex"));
  const trash = async (files: string[]) => {
    for (const file of files) await fixtureTrash(file);
  };
  return { home, trash };
}

describe("Codex metadata identity boundaries", () => {
  it("preserves project references and nested data that equal a selected thread ID", async () => {
    const { home, trash } = await fixture();
    const file = path.join(home, ".codex", ".codex-global-state.json");
    await fs.writeFile(file, JSON.stringify({
      "thread-project-assignments": { selected: "project", retained: "selected" },
      "thread-projectless-output-directories": { selected: "/remove", retained: "selected" },
      "thread-workspace-root-hints": { selected: "/remove", retained: { id: "selected", roots: ["selected"] } },
      "thread-writable-roots": { selected: ["/remove"], retained: ["selected"] },
      "sidebar-project-thread-orders": { selected: ["retained"], project: ["selected", "retained"] },
      "pinned-thread-ids": ["selected", "retained"],
      "projectless-thread-ids": ["selected", "retained"],
      "queued-follow-ups": {},
      "electron-thread-read-state-v1": { local: { selected: true, retained: { label: "selected" } }, remote: { selected: true } },
      "app-server-migrated-pinned-thread-ids-by-host": { local: ["selected", "retained"], remote: ["selected"] }
    }));
    const plan = await prepareCodexThreadsMetadata(home, { ...getCodexMetadataPaths(home), globalStateFiles: [file] }, ["selected"], trash);
    await plan.execute();
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      "thread-project-assignments": { retained: "selected" },
      "thread-projectless-output-directories": { retained: "selected" },
      "thread-workspace-root-hints": { retained: { id: "selected", roots: ["selected"] } },
      "thread-writable-roots": { retained: ["selected"] },
      "sidebar-project-thread-orders": { selected: ["retained"], project: ["retained"] },
      "pinned-thread-ids": ["retained"],
      "projectless-thread-ids": ["retained"],
      "queued-follow-ups": {},
      "electron-thread-read-state-v1": { local: { retained: { label: "selected" } }, remote: { selected: true } },
      "app-server-migrated-pinned-thread-ids-by-host": { local: ["retained"], remote: ["selected"] }
    });
  });

  it.each([
    { "pinned-thread-ids": { selected: true } },
    { "projectless-thread-ids": ["selected", { id: "retained" }] },
    { "sidebar-project-thread-orders": ["selected"] },
    { "thread-project-assignments": ["selected"] },
    { "electron-thread-read-state-v1": { local: ["selected"] } },
    { "app-server-migrated-pinned-thread-ids-by-host": { local: { selected: true } } },
    { "queued-follow-ups": [{ threadId: "selected", text: "keep until format is supported" }] }
  ])("rejects unknown global-state shapes without altering the source: %j", async (state) => {
    const { home, trash } = await fixture();
    const file = path.join(home, ".codex", ".codex-global-state.json");
    const original = JSON.stringify(state);
    await fs.writeFile(file, original);
    await expect(prepareCodexThreadsMetadata(home, getCodexMetadataPaths(home), ["selected"], trash))
      .rejects.toThrow(/Unrecognized Codex global state field/);
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it.each([
    { session_id: "retained", thread_id: "selected" },
    { session_id: "selected", thread_id: "retained" },
    { session_id: "selected", thread_id: 1 },
    { session_id: "selected", thread_id: null },
    { session_id: "selected", thread_id: "../invalid" }
  ])("rejects ambiguous history aliases before metadata changes: %j", async (row) => {
    const { home, trash } = await fixture();
    const file = path.join(home, ".codex", "history.jsonl");
    const original = `${JSON.stringify(row)}\n`;
    await fs.writeFile(file, original);
    await expect(prepareCodexThreadsMetadata(home, { ...getCodexMetadataPaths(home), historyFile: file }, ["selected"], trash)).rejects.toThrow(/ID/);
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it("supports each single history alias and consistent aliases while preserving retained text", async () => {
    const { home, trash } = await fixture();
    const file = path.join(home, ".codex", "history.jsonl");
    const retained = '{ "session_id": "retained", "thread_id": "retained", "text": "selected" }';
    await fs.writeFile(file, [JSON.stringify({ session_id: "selected" }), JSON.stringify({ thread_id: "selected" }),
      JSON.stringify({ session_id: "selected", thread_id: "selected" }), retained].join("\n") + "\n");
    const plan = await prepareCodexThreadsMetadata(home, { ...getCodexMetadataPaths(home), historyFile: file }, ["selected"], trash);
    await plan.execute();
    expect(await fs.readFile(file, "utf8")).toBe(`${retained}\n`);
  });
});

async function grokFixture(definition: string, retained: string | number | null, selected = "selected") {
  const { home, trash } = await fixture();
  const root = path.join(home, ".grok");
  const directory = path.join(root, "sessions", "group", selected);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "summary.json"), JSON.stringify({ info: { id: selected } }));
  const file = path.join(root, "sessions", "session_search.sqlite");
  const database = new DatabaseSync(file);
  try {
    database.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE session_docs (session_id ${definition}, cwd TEXT, updated_at INTEGER, title TEXT, content TEXT, content_hash TEXT);
      CREATE VIRTUAL TABLE session_docs_fts USING fts5(title, content, content='session_docs', content_rowid='rowid');
      CREATE TRIGGER session_docs_ai AFTER INSERT ON session_docs BEGIN
        INSERT INTO session_docs_fts(rowid, title, content) VALUES(new.rowid, new.title, new.content); END;
      CREATE TRIGGER session_docs_ad AFTER DELETE ON session_docs BEGIN
        INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content); END;`);
    database.prepare("INSERT INTO session_docs VALUES (?, '/fixtures', 1, 'retained', 'preserved content', 'hash')").run(retained);
  } finally { database.close(); }
  const conversation: ConversationRecord = { key: `grok:${selected}`, providerId: "grok", providerName: "Grok", id: selected,
    title: selected, sizeBytes: 1, dataPaths: [directory], guardPaths: [], warnings: [], deleteStrategy: { kind: "indexed" } };
  return { home, trash, file, conversation };
}

function grokRows(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return { docs: database.prepare("SELECT rowid, * FROM session_docs ORDER BY rowid").all(),
      fts: database.prepare("SELECT rowid, title, content FROM session_docs_fts WHERE session_docs_fts MATCH 'preserved'").all() };
  } finally { database.close(); }
}

describe("Grok exact search identity", () => {
  it.each([
    ["TEXT COLLATE NOCASE PRIMARY KEY", "SELECTED", "selected"],
    ["TEXT COLLATE RTRIM PRIMARY KEY", "selected ", "selected"]
  ] as const)("preserves unselected IDs under %s", async (definition, retained, selected) => {
    const item = await grokFixture(definition, retained, selected);
    const before = grokRows(item.file);
    const plan = await prepareGrokDeletion(item.conversation, item.home);
    await plan.execute(item.trash);
    expect(grokRows(item.file)).toEqual(before);
  });

  it.each([["TEXT PRIMARY KEY", null, "selected"], ["NUMERIC PRIMARY KEY", 1, "01"]] as const)(
    "rejects non-string search ownership under %s before changing the original database", async (definition, id, selected) => {
    const item = await grokFixture(definition, id, selected);
    const before = await fs.readFile(item.file);
    await expect(prepareGrokDeletion(item.conversation, item.home)).rejects.toThrow(/session ID/);
    expect(await fs.readFile(item.file)).toEqual(before);
  });

  it("deletes only the exact selected BINARY row and retains other search content", async () => {
    const item = await grokFixture("TEXT PRIMARY KEY", "retained");
    const database = new DatabaseSync(item.file);
    database.exec("INSERT INTO session_docs VALUES ('selected', '/fixtures', 2, 'selected', 'remove content', 'hash')");
    database.close();
    const before = grokRows(item.file);
    const plan = await prepareGrokDeletion(item.conversation, item.home);
    await plan.execute(item.trash);
    expect(grokRows(item.file)).toEqual({ ...before, docs: before.docs.filter((row) => row.session_id !== "selected") });
  });

  it("refuses a named trigger that changes a retained search row identity while keeping FTS consistent", async () => {
    const item = await grokFixture("TEXT PRIMARY KEY", "retained");
    const database = new DatabaseSync(item.file);
    database.exec(`INSERT INTO session_docs VALUES ('selected', '/fixtures', 2, 'selected', 'remove content', 'hash');
      DROP TRIGGER session_docs_ad;
      CREATE TRIGGER session_docs_ad AFTER DELETE ON session_docs BEGIN
        INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
        INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content)
          SELECT 'delete', rowid, title, content FROM session_docs WHERE session_id = 'retained';
        UPDATE session_docs SET rowid = rowid + 100 WHERE session_id = 'retained';
        INSERT INTO session_docs_fts(rowid, title, content)
          SELECT rowid, title, content FROM session_docs WHERE session_id = 'retained';
      END;`);
    database.close();
    const before = await fs.readFile(item.file);
    await expect(prepareGrokDeletion(item.conversation, item.home)).rejects.toThrow(/Unselected Grok indexes changed/);
    expect(await fs.readFile(item.file)).toEqual(before);
  });
});
