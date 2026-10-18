import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { prepareOpenCodeDeletion } from "../src/conversations/opencode.js";
import { prepareGrokDeletion } from "../src/conversations/grok.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true }))); });

async function homeFixture() {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-native-"));
  homes.push(home);
  const trashRoot = path.join(home, "trash");
  await fs.mkdir(trashRoot);
  let count = 0;
  const trash = vi.fn(async (paths: string[]) => {
    for (const file of paths) await fs.rename(file, path.join(trashRoot, `${count++}-${path.basename(file)}`));
  });
  return { home, trashRoot, trash, checkOpenPaths: async () => ({ supported: true, openPaths: [] as string[] }) };
}

async function openCodeFixture(parent = false) {
  const setup = await homeFixture();
  const root = path.join(setup.home, ".local", "share", "opencode");
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE project (id TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER,
      project_id TEXT REFERENCES project(id), share_url TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id) ON DELETE CASCADE, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT REFERENCES message(id) ON DELETE CASCADE, session_id TEXT, data TEXT);
    CREATE TABLE todo (session_id TEXT REFERENCES session(id) ON DELETE CASCADE, content TEXT);
    CREATE TABLE session_share (session_id TEXT REFERENCES session(id) ON DELETE CASCADE, url TEXT);
    INSERT INTO project VALUES ('project', 'shared project');
    INSERT INTO session VALUES ('selected',NULL,'Selected','/fixtures',123,'project','https://fixture.invalid/shared');
    INSERT INTO session VALUES ('retained',NULL,'Retained','/fixtures',456,'project',NULL);
    INSERT INTO message VALUES ('msg-selected','selected','selected message'),('msg-retained','retained','retained message');
    INSERT INTO part VALUES ('part-selected','msg-selected','selected','selected part'),('part-retained','msg-retained','retained','retained part');
    INSERT INTO todo VALUES ('selected','selected todo'),('retained','retained todo');
    INSERT INTO session_share VALUES ('selected','https://fixture.invalid/shared');
  `);
  if (parent) db.exec("UPDATE session SET parent_id='selected' WHERE id='retained'");
  db.close();
  const diff = path.join(root, "storage", "session_diff", "selected.json");
  await fs.mkdir(path.dirname(diff), { recursive: true });
  await fs.writeFile(diff, '[{"file":"selected.ts"}]');
  await fs.writeFile(path.join(path.dirname(diff), "retained.json"), '[{"file":"retained.ts"}]');
  return { ...setup, file, root, diff };
}

function rows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(["session", "message", "part", "todo", "session_share", "project"].map((table) =>
      [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  } finally { db.close(); }
}

describe("OpenCode local Trash deletion", () => {
  it("removes selected records and diff, preserves every retained row, and sends original DB backup to Trash", async () => {
    const setup = await openCodeFixture();
    const before = rows(setup.file);
    const discovery = await discoverConversations(["opencode"], { home: setup.home });
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations).toHaveLength(2);
    expect(discovery.conversations.every((item) => item.sizeKnown === false)).toBe(true);
    const selected = discovery.conversations.find((item) => item.id === "selected")!;
    const result = await deleteConversations([selected], setup);
    expect(result.failures).toEqual([]);
    expect(result.deleted).toEqual([selected]);
    const after = rows(setup.file);
    for (const table of ["session", "message", "part", "todo"]) {
      expect(after[table]).toEqual(before[table]!.filter((row) => table === "session" ? row.id !== "selected" : row.session_id !== "selected"));
    }
    expect(after.project).toEqual(before.project);
    expect(after.session_share).toEqual([]);
    await expect(fs.stat(setup.diff)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(path.dirname(setup.diff), "retained.json"), "utf8")).toBe('[{"file":"retained.ts"}]');
    const backup = (await fs.readdir(setup.trashRoot)).find((name) => !name.endsWith(".json"))!;
    expect(rows(path.join(setup.trashRoot, backup, "001-opencode.db"))).toEqual(before);
    expect((await discoverConversations(["opencode"], { home: setup.home })).conversations.map((item) => item.id)).toEqual(["retained"]);
  });

  it("refuses a parent alone but previews and deletes a selected child before its parent", async () => {
    const setup = await openCodeFixture(true);
    const discovery = await discoverConversations(["opencode"], { home: setup.home });
    const selected = discovery.conversations.find((item) => item.id === "selected")!;
    expect(discovery.conversations.find((item) => item.id === "retained")?.parentId).toBe("selected");
    const rejected = await deleteConversations([selected], setup);
    expect(rejected.failures[0]?.error.message).toMatch(/parent conversation still has children/);
    expect(setup.trash).not.toHaveBeenCalled();
    const preview = await deleteConversations(discovery.conversations, { ...setup, dryRun: true });
    expect(preview.failures).toEqual([]);
    expect(preview.previewed).toHaveLength(2);
    expect(rows(setup.file).session).toHaveLength(2);
    const result = await deleteConversations([selected, ...discovery.conversations.filter((item) => item.id !== "selected")], setup);
    expect(result.failures).toEqual([]);
    expect(result.deleted.map((item) => item.id)).toEqual(["retained", "selected"]);
    expect(rows(setup.file).session).toEqual([]);
  });

  it.each(["unknown table", "unknown trigger", "inconsistent ownership"])("refuses %s before any Trash operation", async (kind) => {
    const setup = await openCodeFixture();
    const db = new DatabaseSync(setup.file);
    if (kind === "unknown table") db.exec("CREATE TABLE unknown_session_data(session_id TEXT)");
    if (kind === "unknown trigger") db.exec("CREATE TRIGGER altered AFTER DELETE ON session BEGIN DELETE FROM project; END");
    if (kind === "inconsistent ownership") db.exec("UPDATE part SET session_id='retained' WHERE id='part-selected'");
    db.close();
    const before = await fs.readFile(setup.file);
    const selected = (await discoverConversations(["opencode"], { home: setup.home })).conversations.find((item) => item.id === "selected")!;
    const result = await deleteConversations([selected], setup);
    expect(result.failures).toHaveLength(1);
    expect(setup.trash).not.toHaveBeenCalled();
    expect(await fs.readFile(setup.file)).toEqual(before);
    expect(await fs.readFile(setup.diff, "utf8")).toContain("selected");
  });

  it("refuses changed DB and refuses executing a preview plan", async () => {
    const setup = await openCodeFixture();
    const selected = (await discoverConversations(["opencode"], { home: setup.home })).conversations.find((item) => item.id === "selected")!;
    const preview = await prepareOpenCodeDeletion(selected, setup.home, [selected.id]);
    await expect(preview.execute(setup.trash)).rejects.toThrow("A preview plan cannot execute deletion.");
    const plan = await prepareOpenCodeDeletion(selected, setup.home);
    const db = new DatabaseSync(setup.file);
    db.exec("UPDATE session SET title='new content' WHERE id='retained'");
    db.close();
    await expect(plan.execute(setup.trash)).rejects.toThrow();
    expect(setup.trash).not.toHaveBeenCalled();
    expect(rows(setup.file).session).toHaveLength(2);
  });

  it("refuses a symlinked database", async () => {
    const setup = await openCodeFixture();
    const moved = path.join(setup.home, "outside.db");
    await fs.rename(setup.file, moved);
    await fs.symlink(moved, setup.file);
    const discovery = await discoverConversations(["opencode"], { home: setup.home });
    expect(discovery.conversations).toEqual([]);
    expect(discovery.warnings.join(" ")).toMatch(/Refusing metadata that resolves outside the provider root/);
  });
});

async function grokFixture(parent = false) {
  const setup = await homeFixture();
  const root = path.join(setup.home, ".grok");
  const selected = path.join(root, "sessions", "group", "selected-dir");
  const retained = path.join(root, "sessions", "group", "retained");
  for (const [directory, id] of [[selected, "selected"], [retained, "retained"]]) {
    await fs.mkdir(directory!, { recursive: true });
    await fs.writeFile(path.join(directory!, "summary.json"), JSON.stringify({
      info: { id, cwd: "/fixtures" }, title: id, ...(parent && id === "retained" ? { parent_session_id: "selected" } : {})
    }));
    await fs.writeFile(path.join(directory!, "updates.jsonl"), `${id} exact transcript\n`);
  }
  const active = path.join(root, "active_sessions.json");
  await fs.writeFile(active, JSON.stringify([
    { session_id: "selected", pid: 2147483646, cwd: "/fixtures", opened_at: "2026-09-01" },
    { session_id: "retained", pid: 2147483647, cwd: "/fixtures", opened_at: "2026-09-02" }
  ]));
  const search = path.join(root, "sessions", "session_search.sqlite");
  const db = new DatabaseSync(search);
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO meta VALUES ('version','1');
    CREATE TABLE session_docs(session_id TEXT PRIMARY KEY,cwd TEXT,updated_at INTEGER,title TEXT,content TEXT,content_hash TEXT);
    CREATE VIRTUAL TABLE session_docs_fts USING fts5(title,content,content='session_docs',content_rowid='rowid');
    CREATE TRIGGER session_docs_ai AFTER INSERT ON session_docs BEGIN
      INSERT INTO session_docs_fts(rowid,title,content) VALUES(new.rowid,new.title,new.content); END;
    CREATE TRIGGER session_docs_ad AFTER DELETE ON session_docs BEGIN
      INSERT INTO session_docs_fts(session_docs_fts,rowid,title,content) VALUES('delete',old.rowid,old.title,old.content); END;
    INSERT INTO session_docs VALUES ('selected','/fixtures',1,'Selected','eraseword','one'),('retained','/fixtures',2,'Retained','keepword','two');
  `);
  db.close();
  return { ...setup, root, selected, retained, active, search };
}

describe("Grok local Trash deletion", () => {
  it("moves the selected transcript and backup to Trash, keeps retained session and searchable text", async () => {
    const setup = await grokFixture();
    const retainedSummary = await fs.readFile(path.join(setup.retained, "summary.json"));
    const discovery = await discoverConversations(["grok"], { home: setup.home });
    expect(discovery.warnings).toEqual([]);
    const selected = discovery.conversations.find((item) => item.id === "selected")!;
    const result = await deleteConversations([selected], setup);
    expect(result.failures).toEqual([]);
    expect(result.deleted).toEqual([selected]);
    await expect(fs.stat(setup.selected)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(setup.retained, "summary.json"))).toEqual(retainedSummary);
    expect(await fs.readFile(path.join(setup.retained, "updates.jsonl"), "utf8")).toBe("retained exact transcript\n");
    expect(JSON.parse(await fs.readFile(setup.active, "utf8")).map((row: { session_id: string }) => row.session_id)).toEqual(["retained"]);
    const db = new DatabaseSync(setup.search, { readOnly: true });
    expect(db.prepare("SELECT session_id FROM session_docs").all()).toEqual([{ session_id: "retained" }]);
    expect(db.prepare("SELECT rowid FROM session_docs_fts WHERE session_docs_fts MATCH 'eraseword'").all()).toEqual([]);
    expect(db.prepare("SELECT rowid FROM session_docs_fts WHERE session_docs_fts MATCH 'keepword'").all()).toHaveLength(1);
    db.close();
    const trashItems = await fs.readdir(setup.trashRoot);
    expect(trashItems).toHaveLength(2);
    expect(await fs.readFile(path.join(setup.trashRoot, trashItems.find((name) => name.endsWith("selected-dir"))!, "updates.jsonl"), "utf8"))
      .toBe("selected exact transcript\n");
    const backup = trashItems.find((name) => !name.endsWith("selected-dir"))!;
    const backupFiles = await fs.readdir(path.join(setup.trashRoot, backup));
    expect(backupFiles.some((name) => name.endsWith("session_search.sqlite"))).toBe(true);
    expect(backupFiles.some((name) => name.endsWith("active_sessions.json"))).toBe(true);
  });

  it("preserves parent with unselected child, then deletes both child first", async () => {
    const setup = await grokFixture(true);
    const discovery = await discoverConversations(["grok"], { home: setup.home });
    const selected = discovery.conversations.find((item) => item.id === "selected")!;
    const result = await deleteConversations([selected], setup);
    expect(result.failures[0]?.error.message).toMatch(/parent conversation still has children/);
    expect(setup.trash).not.toHaveBeenCalled();
    const preview = await deleteConversations(discovery.conversations, { ...setup, dryRun: true });
    expect(preview.failures).toEqual([]);
    const all = await deleteConversations([selected, ...discovery.conversations.filter((item) => item.id !== "selected")], setup);
    expect(all.failures).toEqual([]);
    expect(all.deleted.map((item) => item.id)).toEqual(["retained", "selected"]);
  });

  it.each(["unknown search schema", "invalid active index", "active process", "wrong ownership", "symlink"])("refuses %s without moving files", async (kind) => {
    const setup = await grokFixture();
    const selected = (await discoverConversations(["grok"], { home: setup.home })).conversations.find((item) => item.id === "selected")!;
    if (kind === "unknown search schema") {
      const db = new DatabaseSync(setup.search); db.exec("CREATE TABLE unknown (id TEXT)"); db.close();
    }
    if (kind === "invalid active index") await fs.writeFile(setup.active, '{}');
    if (kind === "active process") await fs.writeFile(setup.active, JSON.stringify([{ session_id: "selected", pid: process.pid, cwd: "/fixtures", opened_at: "today" }]));
    if (kind === "wrong ownership") await fs.writeFile(path.join(setup.selected, "summary.json"), '{"info":{"id":"retained"}}');
    if (kind === "symlink") await fs.symlink(setup.retained, path.join(setup.selected, "linked"));
    const result = await deleteConversations([selected], setup);
    expect(result.failures).toHaveLength(1);
    expect(setup.trash).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(setup.selected, "updates.jsonl"), "utf8")).toBe("selected exact transcript\n");
  });

  it("rejects executing a preview plan and retains files on an open-path check failure", async () => {
    const setup = await grokFixture();
    const selected = (await discoverConversations(["grok"], { home: setup.home })).conversations.find((item) => item.id === "selected")!;
    const preview = await prepareGrokDeletion(selected, setup.home, [selected.id]);
    await expect(preview.execute(setup.trash)).rejects.toThrow("A preview plan cannot execute deletion.");
    const result = await deleteConversations([selected], { ...setup, checkOpenPaths: async () => ({ supported: true, openPaths: [setup.search] }) });
    expect(result.failures).toHaveLength(1);
    expect(setup.trash).not.toHaveBeenCalled();
  });
  it("revalidates Grok identity and child dependencies after preparing the plan", async () => {
    const setup = await grokFixture();
    const selected = (await discoverConversations(["grok"], { home: setup.home })).conversations.find((item) => item.id === "selected")!;
    const plan = await prepareGrokDeletion(selected, setup.home);
    const summary = path.join(setup.selected, "summary.json");
    const original = await fs.readFile(summary, "utf8");
    await fs.writeFile(summary, '{"info":{"id":"different"}}');
    await expect(plan.validate()).rejects.toThrow("ID");
    await fs.writeFile(summary, original);
    const child = path.join(setup.retained, "summary.json");
    await fs.writeFile(child, JSON.stringify({ info: { id: "retained" }, parent_session_id: "selected" }));
    await expect(plan.validate()).rejects.toThrow(/parent conversation still has children/);
    await expect(plan.execute(setup.trash)).rejects.toThrow(/parent conversation still has children/);
    expect(setup.trash).not.toHaveBeenCalled();
  });

  it("refuses unverified child trees reached by symlinks", async () => {
    const setup = await grokFixture();
    const selected = (await discoverConversations(["grok"], { home: setup.home })).conversations.find((item) => item.id === "selected")!;
    await fs.symlink(setup.retained, path.join(path.dirname(setup.retained), "linked-child"));
    await expect(prepareGrokDeletion(selected, setup.home)).rejects.toThrow(/symbolic link/);
    expect(setup.trash).not.toHaveBeenCalled();
  });

  it("refuses a pending registry before moving data and rechecks it after plan preparation", async () => {
    const setup = await grokFixture();
    const selected = (await discoverConversations(["grok"], { home: setup.home })).conversations.find((item) => item.id === "selected")!;
    const plan = await prepareGrokDeletion(selected, setup.home);
    const pending = path.join(setup.root, "active_sessions.json.tmp");
    await fs.writeFile(pending, '[{"session_id":"selected"}]');
    await expect(plan.validate()).rejects.toThrow(/unfinished active index write/);
    await expect(plan.execute(setup.trash)).rejects.toThrow(/unfinished active index write/);
    const result = await deleteConversations([selected], setup);
    expect(result.failures[0]?.error.message).toMatch(/unfinished active index write/);
    expect(setup.trash).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(setup.selected, "updates.jsonl"), "utf8")).toBe("selected exact transcript\n");
    expect(await fs.readFile(pending, "utf8")).toBe('[{"session_id":"selected"}]');
  });

});
