import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { prepareClean } from "../src/cleaners/plan.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await fixtureTrash(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-opencode-bulk-")));
  homes.push(home);
  const root = path.join(home, ".local", "share", "opencode");
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "opencode.db");
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE session(id TEXT PRIMARY KEY); INSERT INTO session VALUES('selected')");
  database.close();
  const moved: string[] = [];
  const trash = vi.fn(async (files: string[]) => {
    for (const source of files) {
      await fs.rename(source, path.join(home, `trash-${moved.length}`));
      moved.push(source);
    }
  });
  const options = { home, trash, checkOpenPaths: async () => ({ supported: true, openPaths: [] }) };
  return { home, root, file, moved, options };
}
function change(file: string, sql: string) {
  const database = new DatabaseSync(file);
  try { database.exec(sql); } finally { database.close(); }
}

describe("OpenCode bulk protected data", () => {
  it.each(["credential", "account", "account_state", "control_account", "permission"])(
    "clears conversations while preserving populated %s rows", async (table) => {
      const item = await fixture();
      change(item.file, `CREATE TABLE ${table}(value TEXT); INSERT INTO ${table} VALUES('synthetic protected value')`);
      const copilot = path.join(item.home, ".copilot", "session-state", "selected");
      await fs.mkdir(copilot, { recursive: true });
      await fs.writeFile(path.join(copilot, "events.jsonl"), "selected artifact");
      const plan = await prepareClean(["copilot", "opencode"], item.options);
      expect(plan.entries.map((entry) => entry.path)).not.toContain(item.file);
      expect(plan.operations.join(" ")).toMatch(/OpenCode.*conversation.*preserv/i);
      expect(await plan.execute()).toMatchObject({ failures: [] });
      await expect(fs.lstat(copilot)).rejects.toMatchObject({ code: "ENOENT" });
      const checked = new DatabaseSync(item.file, { readOnly: true });
      try {
        expect(checked.prepare(`SELECT value FROM ${table}`).get()).toEqual({ value: "synthetic protected value" });
        expect(checked.prepare("SELECT * FROM session").all()).toEqual([]);
      }
      finally { checked.close(); }
    });

  it("keeps existing bulk behavior when the credential table is empty", async () => {
    const item = await fixture();
    change(item.file, "CREATE TABLE credential(value TEXT)");
    const plan = await prepareClean(["opencode"], item.options);
    expect(plan.entries.map((entry) => entry.path)).toContain(item.file);
    expect(await plan.execute()).toMatchObject({ failures: [] });
    expect(item.moved).toContain(item.file);
  });

  it("keeps the no-database legacy cleanup path", async () => {
    const item = await fixture();
    await fs.rename(item.file, path.join(item.home, "retained-fixture-db"));
    const storage = path.join(item.root, "storage", "session");
    await fs.mkdir(storage, { recursive: true });
    await fs.writeFile(path.join(storage, "selected.json"), "synthetic legacy conversation");
    const plan = await prepareClean(["opencode"], item.options);
    expect(await plan.execute()).toMatchObject({ failures: [] });
    expect(item.moved).toEqual([storage]);
  });

  it("blocks all targets if protected data is added after the preview", async () => {
    const item = await fixture();
    change(item.file, "CREATE TABLE credential(value TEXT)");
    const copilot = path.join(item.home, ".copilot", "session-state");
    await fs.mkdir(copilot, { recursive: true });
    await fs.writeFile(path.join(copilot, "selected.jsonl"), "selected artifact");
    const plan = await prepareClean(["copilot", "opencode"], item.options);
    change(item.file, "INSERT INTO credential VALUES('new synthetic credential')");
    await expect(plan.execute()).rejects.toThrow(/after preflight|conversation diffs/i);
    expect(item.moved).toEqual([]);
    expect(await fs.readFile(path.join(copilot, "selected.jsonl"), "utf8")).toBe("selected artifact");
  });

  it("preserves protected values committed only to a WAL", async () => {
    const item = await fixture();
    const writer = new DatabaseSync(item.file);
    try {
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE credential(value TEXT); INSERT INTO credential VALUES('WAL credential')");
      const plan = await prepareClean(["opencode"], item.options);
      expect(plan.entries.map((entry) => entry.path)).not.toContain(item.file);
      expect(plan.operations.join(" ")).toMatch(/OpenCode.*conversation/i);
      expect(item.moved).toEqual([]);
    } finally { writer.close(); }
  });

  it("rechecks contents after occupancy checks even when file size and timestamp are retained", async () => {
    const item = await fixture();
    change(item.file, "CREATE TABLE credential(value TEXT)");
    const timestamp = new Date("2026-01-01T00:00:00Z");
    await fs.utimes(item.file, timestamp, timestamp);
    const size = (await fs.stat(item.file)).size;
    let checks = 0;
    const plan = await prepareClean(["opencode"], { ...item.options, checkOpenPaths: async () => {
      if (++checks === 2) {
        change(item.file, "INSERT INTO credential VALUES('new credential')");
        await fs.utimes(item.file, timestamp, timestamp);
      }
      return { supported: true, openPaths: [] };
    } });
    await expect(plan.execute()).rejects.toThrow(/Metadata contents changed after preflight/);
    expect((await fs.stat(item.file)).size).toBe(size);
    expect(item.moved).toEqual([]);
  });

  it("refuses unknown tables instead of treating their data as conversations", async () => {
    const item = await fixture();
    change(item.file, "CREATE TABLE future_login_state(secret TEXT); INSERT INTO future_login_state VALUES('synthetic')");
    await expect(prepareClean(["opencode"], item.options)).rejects.toThrow(/OpenCode has unknown tables/);
    expect(item.moved).toEqual([]);
  });

  it("guards a database-only metadata plan against open files", async () => {
    const item = await fixture();
    change(item.file, "CREATE TABLE credential(value TEXT); INSERT INTO credential VALUES('retained')");
    const checks: string[][] = [];
    const plan = await prepareClean(["opencode"], { ...item.options, checkOpenPaths: async (files) => {
      checks.push(files);
      return { supported: true, openPaths: checks.length > 1 ? [item.file] : [] };
    } });
    await expect(plan.execute()).rejects.toThrow(/Open files/);
    expect(checks.every((files) => files.includes(item.file))).toBe(true);
    expect(item.moved).toEqual([]);
    const database = new DatabaseSync(item.file, { readOnly: true });
    try { expect(database.prepare("SELECT * FROM session").all()).toEqual([{ id: "selected" }]); }
    finally { database.close(); }
  });

  it.each([
    ["trigger", "CREATE TRIGGER change_permissions AFTER DELETE ON session BEGIN DELETE FROM credential; END"],
    ["foreign key", "ALTER TABLE credential ADD COLUMN session_id TEXT REFERENCES session(id) ON DELETE CASCADE"],
    ["unknown schema", "CREATE TABLE message(id TEXT, unknown_owner TEXT)"],
    ["incomplete event schema", "CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT)"]
  ])("refuses %s before any provider movement", async (_label, sql) => {
    const item = await fixture();
    change(item.file, "CREATE TABLE credential(value TEXT); INSERT INTO credential VALUES('retained')");
    change(item.file, sql!);
    const before = await fs.readFile(item.file);
    await expect(prepareClean(["copilot", "opencode"], item.options)).rejects.toThrow(/OpenCode/);
    expect(await fs.readFile(item.file)).toEqual(before);
    expect(item.moved).toEqual([]);
  });

  it("rejects orphaned database sidecars before moving other providers", async () => {
    const item = await fixture();
    await fs.rename(item.file, `${item.home}/retained-fixture-db`);
    await fs.writeFile(`${item.file}-wal`, "synthetic sidecar");
    await expect(prepareClean(["copilot", "opencode"], item.options)).rejects.toThrow(/database is missing/);
    expect(item.moved).toEqual([]);
  });

  it("keeps the database if credentials appear while an earlier provider is moved", async () => {
    const item = await fixture();
    change(item.file, "CREATE TABLE credential(value TEXT)");
    const timestamp = new Date("2026-01-01T00:00:00Z");
    await fs.utimes(item.file, timestamp, timestamp);
    const copilot = path.join(item.home, ".copilot", "session-state");
    await fs.mkdir(copilot, { recursive: true });
    await fs.writeFile(path.join(copilot, "selected.jsonl"), "selected artifact");
    const plan = await prepareClean(["copilot", "opencode"], { ...item.options, trash: async (files) => {
      await item.options.trash(files);
      if (files.includes(copilot)) {
        change(item.file, "INSERT INTO credential VALUES('credential during earlier provider movement')");
        await fs.utimes(item.file, timestamp, timestamp);
      }
    } });
    const result = await plan.execute();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.providerId).toBe("opencode");
    expect(item.moved).toEqual([copilot]);
    const checked = new DatabaseSync(item.file, { readOnly: true });
    try { expect(checked.prepare("SELECT value FROM credential").get()).toEqual({ value: "credential during earlier provider movement" }); }
    finally { checked.close(); }
  });
});
