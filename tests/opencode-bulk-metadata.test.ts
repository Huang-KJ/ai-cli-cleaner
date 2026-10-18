import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { prepareClean } from "../src/cleaners/plan.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await fixtureTrash(home, { recursive: true, force: true });
});

async function fixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-opencode-bulk-metadata-")));
  homes.push(home);
  const root = path.join(home, ".local", "share", "opencode");
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "opencode.db");
  const database = new DatabaseSync(file);
  try {
    database.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE project(id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE workspace(id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE permission(project_id TEXT REFERENCES project(id), value TEXT);
      CREATE TABLE credential(value TEXT);
      CREATE TABLE project_directory(project_id TEXT REFERENCES project(id), directory TEXT);
      CREATE TABLE migration(id TEXT PRIMARY KEY);
      CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES session(id), project_id TEXT REFERENCES project(id));
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id) ON DELETE CASCADE, data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT REFERENCES message(id) ON DELETE CASCADE, session_id TEXT, data TEXT);
      CREATE TABLE todo(session_id TEXT REFERENCES session(id) ON DELETE CASCADE, content TEXT);
      CREATE TABLE session_share(session_id TEXT REFERENCES session(id) ON DELETE CASCADE, url TEXT);
      CREATE TABLE session_context_epoch(session_id TEXT REFERENCES session(id), baseline TEXT, snapshot TEXT, baseline_seq INTEGER);
      CREATE TABLE session_input(id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id), prompt TEXT, delivery TEXT,
        admitted_seq INTEGER, promoted_seq INTEGER, time_created INTEGER);
      CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id), type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT);
      CREATE TABLE event(id TEXT PRIMARY KEY, aggregate_id TEXT REFERENCES event_sequence(aggregate_id), seq INTEGER, type TEXT, data TEXT);
      INSERT INTO project VALUES('project','permanent project');
      INSERT INTO workspace VALUES('workspace','permanent workspace');
      INSERT INTO permission VALUES('project','permanent permission');
      INSERT INTO credential VALUES('permanent credential');
      INSERT INTO project_directory VALUES('project','/fixtures');
      INSERT INTO migration VALUES('permanent migration');
      INSERT INTO session VALUES('ses_parent',NULL,'project'),('ses_child','ses_parent','project');
      INSERT INTO message VALUES('message','ses_parent','private transcript');
      INSERT INTO part VALUES('part','message','ses_parent','private part');
      INSERT INTO todo VALUES('ses_child','private todo');
      INSERT INTO session_share VALUES('ses_parent','https://fixture.invalid/shared');
      INSERT INTO session_context_epoch VALUES('ses_child','private baseline','private snapshot',1);
      INSERT INTO session_input VALUES('input','ses_child','private prompt','steer',1,2,1);
      INSERT INTO session_message VALUES('input','ses_child','user',1,1,1,'private message');
      INSERT INTO event_sequence VALUES('ses_parent',1,'workspace'),('ses_orphan',1,'workspace'),('workspace',1,'ses_parent');
      INSERT INTO event VALUES('event-session','ses_parent',1,'session.created.1','{"sessionID":"ses_parent"}'),
        ('event-orphan','ses_orphan',1,'session.deleted.1','{"sessionID":"ses_orphan"}'),
        ('event-workspace','workspace',1,'workspace.created.1','{"workspaceID":"workspace","mentions":"ses_parent"}');`);
  } finally { database.close(); }
  const moved: { source: string; destination: string }[] = [];
  const options = {
    home,
    trash: async (files: string[]) => {
      for (const source of files) {
        const destination = path.join(home, `trash-${moved.length}`);
        await fs.rename(source, destination);
        moved.push({ source, destination });
      }
    },
    checkOpenPaths: async () => ({ supported: true, openPaths: [] })
  };
  return { home, root, file, moved, options };
}

function rows(file: string): Record<string, Record<string, unknown>[]> {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'")
      .all().map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}" ORDER BY rowid`).all()]));
  } finally { database.close(); }
}

function change(file: string, sql: string) {
  const database = new DatabaseSync(file);
  try { database.exec(sql); } finally { database.close(); }
}

describe("OpenCode bulk metadata publication", () => {
  it("clears every conversation projection and orphaned session event while preserving shared state and recovery contents", async () => {
    const item = await fixture();
    const before = rows(item.file);
    const bytes = await fs.readFile(item.file);
    const plan = await prepareClean(["opencode"], item.options);
    expect(plan.entries).toEqual([]);
    expect(plan.operations).toHaveLength(1);
    expect(await fs.readFile(item.file)).toEqual(bytes);
    await expect(fs.lstat(path.join(item.home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await plan.execute()).toEqual({ deleted: [], failures: [] });
    const after = rows(item.file);
    for (const table of ["session", "message", "part", "todo", "session_share", "session_context_epoch", "session_input", "session_message"]) {
      expect(after[table]).toEqual([]);
    }
    for (const table of ["project", "workspace", "permission", "credential", "project_directory", "migration"]) {
      expect(after[table]).toEqual(before[table]);
    }
    expect(after.event).toEqual([{ id: "event-workspace", aggregate_id: "workspace", seq: 1,
      type: "workspace.created.1", data: '{"workspaceID":"workspace","mentions":"ses_parent"}' }]);
    expect(after.event_sequence).toEqual([{ aggregate_id: "workspace", seq: 1, owner_id: "ses_parent" }]);
    expect(item.moved).toHaveLength(1);
    const backup = item.moved[0]!.destination;
    const name = (await fs.readdir(backup)).find((name) => name.endsWith("opencode.db"))!;
    expect(rows(path.join(backup, name))).toEqual(before);
  });

  it.each([
    ["unclassified orphaned sequence", "INSERT INTO event_sequence VALUES('unclassified',1,NULL)"],
    ["session event with missing ownership", `INSERT INTO event_sequence VALUES('ses_unknown',1,NULL);
      INSERT INTO event VALUES('unknown','ses_unknown',1,'session.deleted.1','{}')`],
    ["unknown event ownership", `INSERT INTO event_sequence VALUES('unknown',1,NULL);
      INSERT INTO event VALUES('unknown','unknown',1,'future.created.1','{}')`],
    ["shared event owner mismatch", `UPDATE event SET data='{"workspaceID":"another-workspace"}' WHERE id='event-workspace'`],
    ["workspace event mixing session ownership", `UPDATE event SET data='{"workspaceID":"workspace","sessionID":"workspace"}' WHERE id='event-workspace'`],
    ["project event mixing session ownership", `INSERT INTO event_sequence VALUES('project',1,NULL);
      INSERT INTO event VALUES('mixed-project','project',1,'project.created.1','{"projectID":"project","sessionID":"project"}')`],
    ["workspace event hiding mismatched scope behind session ownership", `UPDATE event SET data='{"workspaceID":"another-workspace","sessionID":"workspace"}' WHERE id='event-workspace'`],
    ["workspace event mixing project ownership", `UPDATE event SET data='{"workspaceID":"workspace","projectID":"project"}' WHERE id='event-workspace'`],
    ["session event mixing workspace ownership", `UPDATE event SET data='{"sessionID":"ses_parent","workspaceID":"workspace"}' WHERE id='event-session'`],
    ["mixed aggregate ownership", `INSERT INTO event VALUES('mixed','ses_orphan',2,'workspace.created.1','{"workspaceID":"workspace"}')`]
  ])("refuses %s before any source changes", async (_label, sql) => {
    const item = await fixture();
    change(item.file, sql!);
    const before = await fs.readFile(item.file);
    await expect(prepareClean(["opencode"], item.options)).rejects.toThrow(/OpenCode.*ownership/);
    expect(await fs.readFile(item.file)).toEqual(before);
    expect(item.moved).toEqual([]);
  });

  it("rejects metadata added after preview before moving any other provider", async () => {
    const item = await fixture();
    const copilot = path.join(item.home, ".copilot", "session-state");
    await fs.mkdir(copilot, { recursive: true });
    await fs.writeFile(path.join(copilot, "selected.jsonl"), "synthetic other provider");
    const plan = await prepareClean(["copilot", "opencode"], item.options);
    change(item.file, "INSERT INTO todo VALUES('ses_parent','new private todo')");
    await expect(plan.execute()).rejects.toThrow(/after preflight/);
    expect(item.moved).toEqual([]);
    expect(await fs.readFile(path.join(copilot, "selected.jsonl"), "utf8")).toBe("synthetic other provider");
  });

  it("retains recovery details if moving the completed backup to Trash fails", async () => {
    const item = await fixture();
    const before = rows(item.file);
    const plan = await prepareClean(["opencode"], { ...item.options, trash: async () => {
      throw new Error("synthetic backup Trash failure");
    } });
    const result = await plan.execute();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.providerId).toBe("opencode");
    expect(result.failures[0]?.message).toContain("synthetic backup Trash failure");
    const backup = result.failures[0]!.recoveryPath!;
    expect(backup).toBeTruthy();
    const name = (await fs.readdir(backup)).find((name) => name.endsWith("opencode.db"))!;
    expect(rows(path.join(backup, name))).toEqual(before);
    expect(rows(item.file).credential).toEqual(before.credential);
    expect(rows(item.file).session).toEqual([]);
  });
});
