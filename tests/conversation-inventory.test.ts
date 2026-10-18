import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { prepareOpenCodeDeletion } from "../src/conversations/opencode.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});

const closed = async () => ({ supported: true, openPaths: [] as string[] });

async function makeHome(): Promise<string> {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-inventory-")));
  homes.push(home);
  return home;
}

async function rollout(file: string, id = "selected") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ payload: { id } })}\n`);
}

function movingTrash(home: string) {
  let moved = 0;
  return vi.fn(async (files: string[]) => {
    const directory = path.join(home, "mock-trash");
    await fs.mkdir(directory, { recursive: true });
    for (const file of files) await fs.rename(file, path.join(directory, String(moved++)));
  });
}

async function codexFixture() {
  const home = await makeHome();
  const root = path.join(home, ".codex");
  const first = path.join(root, "sessions", "first.jsonl");
  await rollout(first);
  const file = path.join(root, "state_5.sqlite");
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)");
  database.prepare("INSERT INTO threads VALUES (?, ?)").run("selected", first);
  database.close();
  const selected = (await discoverConversations(["codex"], { home })).conversations[0]!;
  return { home, root, first, file, selected };
}

describe("selected conversation storage inventory", () => {
  it.each(["rollout", "artifact"] as const)("rejects an added Codex %s before moving source data", async (kind) => {
    const fixture = await codexFixture();
    const added = kind === "rollout" ? path.join(fixture.root, "archived_sessions", "copy.jsonl")
      : path.join(fixture.root, "visualizations", "2026", "10", "05", "selected");
    if (kind === "rollout") await rollout(added);
    else await fs.mkdir(added, { recursive: true });
    const before = await fs.readFile(fixture.file);
    const trash = movingTrash(fixture.home);
    const result = await deleteConversations([fixture.selected], { home: fixture.home, trash, checkOpenPaths: closed });
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]?.error.message).toMatch(/added or removed after discovery/);
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(fixture.file)).toEqual(before);
    await expect(fs.lstat(fixture.first)).resolves.toBeDefined();
  });

  it("rejects a missing Codex rollout before removing its metadata", async () => {
    const fixture = await codexFixture();
    await fs.rename(fixture.first, path.join(fixture.home, "relocated.jsonl"));
    const trash = movingTrash(fixture.home);
    const result = await deleteConversations([fixture.selected], { home: fixture.home, trash, checkOpenPaths: closed });
    expect(result.failures[0]?.error.message).toMatch(/added or removed after discovery/);
    expect(trash).not.toHaveBeenCalled();
  });

  it("rejects a redirected Codex rollout subtree instead of overlooking copies", async () => {
    const fixture = await codexFixture();
    const external = path.join(fixture.home, "redirected");
    await rollout(path.join(external, "copy.jsonl"));
    await fs.mkdir(path.join(fixture.root, "archived_sessions"));
    await fs.symlink(external, path.join(fixture.root, "archived_sessions", "linked"));
    const trash = movingTrash(fixture.home);
    const result = await deleteConversations([fixture.selected], { home: fixture.home, trash, checkOpenPaths: closed });
    expect(result.failures[0]?.error.message).toMatch(/symbolic link.*complete conversation scope/);
    expect(trash).not.toHaveBeenCalled();
  });

  it("retains Codex metadata and recovery when a selected copy appears during trashing", async () => {
    const fixture = await codexFixture();
    const added = path.join(fixture.root, "archived_sessions", "copy.jsonl");
    const move = movingTrash(fixture.home);
    const result = await deleteConversations([fixture.selected], {
      home: fixture.home, checkOpenPaths: closed,
      trash: async (files) => {
        if (files.includes(fixture.first)) await rollout(added);
        await move(files);
      }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]?.error.message).toMatch(/added or removed after discovery/);
    expect(result.failures[0]?.deletedPaths).toEqual([fixture.first]);
    expect(result.failures[0]?.recoveryPath).toBeTruthy();
    const database = new DatabaseSync(fixture.file, { readOnly: true });
    try { expect(database.prepare("SELECT id FROM threads").all()).toEqual([{ id: "selected" }]); }
    finally { database.close(); }
    await expect(fs.lstat(added)).resolves.toBeDefined();
  });

  it("permits an unrelated Codex rollout added after discovery", async () => {
    const fixture = await codexFixture();
    const retained = path.join(fixture.root, "sessions", "other.jsonl");
    await rollout(retained, "retained");
    const result = await deleteConversations([fixture.selected], {
      home: fixture.home, trash: movingTrash(fixture.home), checkOpenPaths: closed
    });
    expect(result.failures).toEqual([]);
    expect(result.deleted).toEqual([fixture.selected]);
    expect(await fs.readFile(retained, "utf8")).toContain("retained");
  });

  it("rejects a Codex copy added during the final metadata open-file check", async () => {
    const fixture = await codexFixture();
    const added = path.join(fixture.root, "archived_sessions", "copy.jsonl");
    let checks = 0;
    const result = await deleteConversations([fixture.selected], {
      home: fixture.home, trash: movingTrash(fixture.home),
      checkOpenPaths: async () => {
        if (++checks === 4) await rollout(added);
        return closed();
      }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]?.error.message).toMatch(/added or removed after discovery/);
    expect(result.failures[0]?.recoveryPath).toBeTruthy();
    const database = new DatabaseSync(fixture.file, { readOnly: true });
    try { expect(database.prepare("SELECT id FROM threads").all()).toEqual([{ id: "selected" }]); }
    finally { database.close(); }
  });

  it("rejects a Copilot directory added to an index-only selected session", async () => {
    const home = await makeHome();
    const root = path.join(home, ".copilot");
    await fs.mkdir(root);
    const file = path.join(root, "session-store.db");
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('selected')");
    database.close();
    const selected = (await discoverConversations(["copilot"], { home })).conversations[0]!;
    await fs.mkdir(path.join(root, "session-state", "selected"), { recursive: true });
    const trash = movingTrash(home);
    const result = await deleteConversations([selected], { home, trash, checkOpenPaths: closed });
    expect(result.failures[0]?.error.message).toMatch(/added or removed after discovery/);
    expect(trash).not.toHaveBeenCalled();
  });

  it("rejects a Grok session recreated at its original path after trashing", async () => {
    const home = await makeHome();
    const directory = path.join(home, ".grok", "sessions", "group", "selected");
    const summary = path.join(directory, "summary.json");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(summary, JSON.stringify({ info: { id: "selected" } }));
    const selected = (await discoverConversations(["grok"], { home })).conversations[0]!;
    const move = movingTrash(home);
    let checks = 0;
    const result = await deleteConversations([selected], {
      home, trash: move,
      checkOpenPaths: async () => {
        if (++checks === 3) {
          await fs.mkdir(directory);
          await fs.writeFile(summary, JSON.stringify({ info: { id: "selected" } }));
        }
        return closed();
      }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]?.error.message).toMatch(/reappeared after being moved/);
    expect(result.failures[0]?.deletedPaths).toEqual([directory]);
    await expect(fs.lstat(summary)).resolves.toBeDefined();
  });

  it.each(["added", "missing"] as const)("rejects an OpenCode diff %s after preflight", async (change) => {
    const fixture = await openCodeFixture();
    if (change === "missing") await fs.writeFile(fixture.diff, "fixture diff");
    const plan = await prepareOpenCodeDeletion(fixture.selected, fixture.home);
    if (change === "added") await fs.writeFile(fixture.diff, "fixture diff");
    else await fs.rename(fixture.diff, path.join(fixture.home, "relocated-diff.json"));
    await expect(plan.validate()).rejects.toThrow(/added or removed after preflight/);
  });

  it("rejects an OpenCode part with NULL ownership linked to a selected message", async () => {
    const fixture = await openCodeFixture();
    const database = new DatabaseSync(fixture.file);
    database.exec(`INSERT INTO message VALUES('message-selected', 'selected');
      INSERT INTO part VALUES('part-selected', 'message-selected', NULL)`);
    database.close();
    const before = await fs.readFile(fixture.file);
    const trash = movingTrash(fixture.home);
    const result = await deleteConversations([fixture.selected], { home: fixture.home, trash, checkOpenPaths: closed });
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]?.error.message).toMatch(/inconsistent session ownership/);
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(fixture.file)).toEqual(before);
  });

  it("rejects an OpenCode diff added immediately before metadata update", async () => {
    const fixture = await openCodeFixture();
    let checks = 0;
    const result = await deleteConversations([fixture.selected], {
      home: fixture.home, trash: movingTrash(fixture.home),
      checkOpenPaths: async () => {
        if (++checks === 2) await fs.writeFile(fixture.diff, "fixture diff");
        return closed();
      }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]?.error.message).toMatch(/added or removed after preflight/);
    expect(result.failures[0]?.recoveryPath).toBeTruthy();
    const database = new DatabaseSync(fixture.file, { readOnly: true });
    try { expect(database.prepare("SELECT id FROM session").all()).toEqual([{ id: "selected" }]); }
    finally { database.close(); }
  });
});

async function openCodeFixture() {
  const home = await makeHome();
  const root = path.join(home, ".local", "share", "opencode");
  const diff = path.join(root, "storage", "session_diff", "selected.json");
  await fs.mkdir(path.dirname(diff), { recursive: true });
  const file = path.join(root, "opencode.db");
  const database = new DatabaseSync(file);
  database.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT);
    INSERT INTO session VALUES('selected', NULL, 'fixture', '/fixture', 1)`);
  database.close();
  const selected = (await discoverConversations(["opencode"], { home })).conversations[0]!;
  return { home, diff, file, selected };
}

describe("Codex metadata-only discovery", () => {
  it("preserves authoritative state titles and timestamps when history also exists", async () => {
    const fixture = await codexFixture();
    const database = new DatabaseSync(fixture.file);
    database.exec(`ALTER TABLE threads ADD COLUMN title TEXT;
      ALTER TABLE threads ADD COLUMN updated_at INTEGER;
      UPDATE threads SET title = 'Current title', updated_at = 1791158400`);
    database.close();
    await fs.writeFile(path.join(fixture.root, "history.jsonl"), `${JSON.stringify({ session_id: "selected", text: "Earlier input", timestamp: 1 })}\n`);
    const discovery = await discoverConversations(["codex"], { home: fixture.home });
    expect(discovery.conversations[0]).toMatchObject({ title: "Current title", updatedAt: "2026-10-05T00:00:00.000Z" });
  });

  it("includes history and known App local catalogs while excluding remote and unknown hosts", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(path.join(root, "sqlite"), { recursive: true });
    await fs.writeFile(path.join(root, "history.jsonl"), `${JSON.stringify({ session_id: "history-only", text: "fixture input" })}\n`);
    const database = new DatabaseSync(path.join(root, "sqlite", "codex-dev.db"));
    database.exec(`CREATE TABLE local_thread_catalog(thread_id TEXT, host_id TEXT);
      INSERT INTO local_thread_catalog VALUES('app-only', 'local'), ('nested-local', 'local:fixture'),
        ('remote-only', 'ssh:fixture'), ('unknown-only', NULL), ('locality-only', 'locality')`);
    database.close();
    const discovery = await discoverConversations(["codex"], { home });
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations.map((item) => item.id).sort()).toEqual(["app-only", "history-only", "nested-local"]);
    expect(discovery.conversations.every((item) => item.dataPaths.length === 0)).toBe(true);
    const result = await deleteConversations(discovery.conversations, { home, trash: movingTrash(home), checkOpenPaths: closed });
    expect(result.failures).toEqual([]);
    expect(result.deleted).toHaveLength(3);
    expect(await fs.readFile(path.join(root, "history.jsonl"), "utf8")).toBe("");
    const retained = new DatabaseSync(path.join(root, "sqlite", "codex-dev.db"), { readOnly: true });
    try { expect(retained.prepare("SELECT thread_id FROM local_thread_catalog ORDER BY thread_id").all())
      .toEqual([{ thread_id: "locality-only" }, { thread_id: "remote-only" }, { thread_id: "unknown-only" }]); }
    finally { retained.close(); }
  });
});
