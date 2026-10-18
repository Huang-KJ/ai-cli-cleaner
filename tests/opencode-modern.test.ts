import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";

const homes: string[] = [];
const selectedId = "ses_selected";
const sessionTables = ["message", "part", "todo", "session_share", "session_context_epoch", "session_input", "session_message"];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

async function modernFixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-opencode-modern-")));
  homes.push(home);
  const root = path.join(home, ".local", "share", "opencode");
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "opencode.db");
  const database = new DatabaseSync(file);
  try {
    database.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE project(id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER,
        project_id TEXT REFERENCES project(id));
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE, session_id TEXT NOT NULL, data TEXT);
      CREATE TABLE todo(session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, content TEXT);
      CREATE TABLE session_share(session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, url TEXT);
      CREATE TABLE session_context_epoch(session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
        baseline TEXT NOT NULL, snapshot TEXT NOT NULL, baseline_seq INTEGER NOT NULL);
      CREATE TABLE session_input(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL, delivery TEXT NOT NULL, admitted_seq INTEGER NOT NULL, promoted_seq INTEGER, time_created INTEGER NOT NULL);
      CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT);
      CREATE TABLE event(id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE credential(id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL,
        connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
      CREATE TABLE project_directory(project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        directory TEXT NOT NULL, type TEXT, strategy TEXT, time_created INTEGER NOT NULL, PRIMARY KEY(project_id,directory));
      CREATE TABLE data_migration(name TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
      CREATE TABLE migration(id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
      INSERT INTO project VALUES('project','shared project');
      INSERT INTO credential VALUES('credential',NULL,'synthetic', '{"fixture":"ses_selected"}',NULL,NULL,1,1,1);
      INSERT INTO project_directory VALUES('project','/fixtures','main','synthetic',1);
      INSERT INTO data_migration VALUES('synthetic',1);
      INSERT INTO migration VALUES('synthetic',1);`);
    for (const [index, id] of [selectedId, "ses_selected-longer", "ses_retained"].entries()) {
      database.prepare("INSERT INTO session VALUES(?,NULL,?, '/fixtures',?, 'project')").run(id, id, index);
      database.prepare("INSERT INTO message VALUES(?,?,?)").run(`legacy-${id}`, id, `${id} transcript`);
      database.prepare("INSERT INTO part VALUES(?,?,?,?)").run(`part-${id}`, `legacy-${id}`, id, `${id} part`);
      database.prepare("INSERT INTO todo VALUES(?,?)").run(id, `${id} todo`);
      database.prepare("INSERT INTO session_share VALUES(?,?)").run(id, "https://fixture.invalid/shared");
      database.prepare("INSERT INTO session_context_epoch VALUES(?,?,?,?)").run(id, `${id} baseline`, '{"fixture":"context"}', 1);
      database.prepare("INSERT INTO session_input VALUES(?,?,?,?,?,?,?)").run(`next-${id}`, id, JSON.stringify({ parts: [{ text: `${id} prompt` }] }), "steer", 2, 3, 1);
      database.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?,?)").run(`next-${id}`, id, "user", 3, 1, 1, JSON.stringify({ text: `${id} new message` }));
      database.prepare("INSERT INTO event_sequence VALUES(?,?,?)").run(id, 1, selectedId);
      database.prepare("INSERT INTO event VALUES(?,?,?,?,?)").run(`event-${id}`, id, 1, "session.created.1",
        JSON.stringify({ sessionID: id, info: { id, text: `${id} journal`, mentions: selectedId } }));
    }
    // 非對話 aggregate 可含同名文字，owner_id 不表示對話歸屬。
    database.exec(`INSERT INTO event_sequence VALUES('workspace-retained',1,'ses_selected');
      INSERT INTO event VALUES('event-workspace','workspace-retained',1,'workspace.created.1','{"workspaceID":"workspace-retained","mentions":"ses_selected"}');`);
  } finally { database.close(); }
  const diff = path.join(root, "storage", "session_diff", `${selectedId}.json`);
  await fs.mkdir(path.dirname(diff), { recursive: true });
  await fs.writeFile(diff, '[{"file":"synthetic.ts"}]');
  const moved: string[] = [];
  const sink = path.join(home, "sink");
  await fs.mkdir(sink);
  const trash = vi.fn(async (files: string[]) => {
    for (const source of files) {
      const destination = path.join(sink, `${moved.length}-${path.basename(source)}`);
      await fs.rename(source, destination);
      moved.push(destination);
    }
  });
  const discovery = await discoverConversations(["opencode"], { home });
  expect(discovery.warnings).toEqual([]);
  const selected = discovery.conversations.find(({ id }) => id === selectedId)!;
  return { home, file, selected, diff, moved, trash, checkOpenPaths: async () => ({ supported: true, openPaths: [] }) };
}

function rows(file: string): Record<string, Record<string, unknown>[]> {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
      .all().map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}" ORDER BY rowid`).all()]));
  } finally { database.close(); }
}

function change(file: string, sql: string): void {
  const database = new DatabaseSync(file);
  try { database.exec(sql); } finally { database.close(); }
}

describe("OpenCode 1.19.0 session projections and event history", () => {
  it("deletes populated projections and journal exactly, preserving prefixes, unrelated owners, credentials and migrations", async () => {
    const item = await modernFixture();
    const before = rows(item.file);
    const result = await deleteConversations([item.selected], item);
    expect(result.failures).toEqual([]);
    expect(result.deleted).toEqual([item.selected]);
    const after = rows(item.file);
    expect(after.session?.map(({ id }) => id)).toEqual(["ses_selected-longer", "ses_retained"]);
    for (const table of sessionTables) expect(after[table]).toEqual(before[table]!.filter((row) => row.session_id !== selectedId));
    for (const table of ["event", "event_sequence"]) expect(after[table]).toEqual(before[table]!.filter((row) => row.aggregate_id !== selectedId));
    for (const table of ["credential", "project", "project_directory", "data_migration", "migration"]) expect(after[table]).toEqual(before[table]);
    await expect(fs.lstat(item.diff)).rejects.toMatchObject({ code: "ENOENT" });
    const backup = item.moved.find((file) => !file.endsWith(".json"))!;
    expect(rows(path.join(backup, "001-opencode.db"))).toEqual(before);
  });

  it("previews every new selected table without modifying any source or creating recovery", async () => {
    const item = await modernFixture();
    const before = await fs.readFile(item.file);
    const result = await deleteConversations([item.selected], { ...item, dryRun: true });
    expect(result.failures).toEqual([]);
    expect(result.previewed).toEqual([item.selected]);
    expect(await fs.readFile(item.file)).toEqual(before);
    expect(item.trash).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(item.home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["selected payload owner", `UPDATE event SET data='{"sessionID":"ses_retained"}' WHERE aggregate_id='ses_selected'`],
    ["selected payload missing owner", `UPDATE event SET data='{}' WHERE aggregate_id='ses_selected'`],
    ["malformed payload", `UPDATE event SET data='not-json' WHERE aggregate_id='ses_selected'`],
    ["selected history under retained aggregate", `UPDATE event SET data='{"sessionID":"ses_selected"}' WHERE aggregate_id='ses_retained'`],
    ["input and message owner conflict", `UPDATE session_input SET session_id='ses_retained' WHERE id='next-ses_selected'`],
    ["incomplete journal schema", "DROP TABLE event"],
    ["unknown projection schema", "ALTER TABLE session_context_epoch RENAME COLUMN snapshot TO unknown_snapshot"],
    ["unknown table", "CREATE TABLE future_session_copy(session_id TEXT, text TEXT)"],
    ["unknown trigger", "CREATE TRIGGER erase_credential AFTER DELETE ON session BEGIN DELETE FROM credential; END"]
  ])("rejects %s before moving data", async (_name, sql) => {
    const item = await modernFixture();
    change(item.file, sql!);
    const before = await fs.readFile(item.file);
    const result = await deleteConversations([item.selected], item);
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(item.trash).not.toHaveBeenCalled();
    expect(await fs.readFile(item.file)).toEqual(before);
    await expect(fs.readFile(item.diff, "utf8")).resolves.toContain("synthetic.ts");
  });

  it("rolls back a cascade into preserved credentials during preflight", async () => {
    const item = await modernFixture();
    change(item.file, `ALTER TABLE credential ADD COLUMN session_id TEXT REFERENCES session(id) ON DELETE CASCADE;
      UPDATE credential SET session_id='ses_selected';`);
    const before = rows(item.file);
    const result = await deleteConversations([item.selected], item);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(/Unselected data in .* changed/);
    expect(rows(item.file)).toEqual(before);
    expect(item.trash).not.toHaveBeenCalled();
  });
});
