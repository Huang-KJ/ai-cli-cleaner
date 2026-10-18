import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { prepareClean } from "../src/cleaners/plan.js";
import { prepareCodexConversationMetadata } from "../src/conversations/codex-metadata.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});
const closed = async () => ({ supported: true, openPaths: [] as string[] });

describe("Codex bulk residual inventory", () => {
  it.each(["Alex Mac", "測試使用者"])(
    "moves complete dated storage trees only from the selected home %s",
    async (name) => {
      const fixture = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-codex-dates-")));
      homes.push(fixture);
      const home = path.join(fixture, "Users", name);
      const root = path.join(home, ".codex");
      const workspace = path.join(home, "Documents", "Codex");
      const directories = ["sessions", "archived_sessions", "generated_images", "visualizations", "attachments", "shell_snapshots"];
      const payloads = [
        ["2023/01/02/rollout.jsonl", Buffer.from('{"type":"session_meta","payload":{"id":"dated-session"}}\n')],
        ["2025/12/31/project/output/deeper/artifact.bin", Buffer.from([0, 1, 127, 128, 255])],
        ["2026/10/15/nested/another/level/result.txt", Buffer.from("合成對話產物\n")]
      ] as const;
      const empty = "2024/06/03/empty";
      const trees = [
        ...directories.map((directory) => ({ source: path.join(root, directory), payloads, empty })),
        ...["2024-02-29", "2026-10-15"].map((date) => ({
          source: path.join(workspace, date),
          payloads: [["nested/another/level/payload.bin", Buffer.from([0, 128, 255, 10])]] as const,
          empty: "emptydir"
        }))
      ];
      for (const tree of trees) {
        await fs.mkdir(path.join(tree.source, tree.empty), { recursive: true });
        for (const [relative, bytes] of tree.payloads) {
          const file = path.join(tree.source, relative);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, bytes);
        }
      }
      const retained = [
        [path.join(root, "auth.json"), '{"token":"synthetic-credential"}\n'],
        [path.join(root, "config.toml"), 'model = "synthetic-model"\n'],
        [path.join(root, "plugins", "installed", "plugin.json"), '{"enabled":true}\n'],
        [path.join(root, "skills", "custom", "SKILL.md"), "合成技能設定\n"],
        [path.join(home, "Desktop", "2026", "10", "15", "notes.txt"), "selected home outside Codex\n"],
        [path.join(workspace, "project", "nested", "source.txt"), "nondate project\n"],
        [path.join(workspace, "2026-10-14"), "date-named regular file\n"],
        [path.join(fixture, "Users", "Neighbor", ".codex", "sessions", "2023", "01", "02", "rollout.jsonl"), "neighbor conversation\n"],
        [path.join(fixture, "Users", "Neighbor", "Documents", "Codex", "2026-10-15", "nested", "payload.bin"), "neighbor workspace\n"]
      ] as const;
      for (const [file, text] of retained) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text);
      }
      const trash = path.join(fixture, "fixture-trash");
      await fs.mkdir(trash);
      const destinations = new Map<string, string>();
      const move = async (files: string[]) => {
        for (const source of files) {
          const destination = path.join(trash, String(destinations.size));
          await fs.rename(source, destination);
          destinations.set(source, destination);
        }
      };

      const plan = await prepareClean(["codex"], { home, checkOpenPaths: closed, trash: move });
      const result = await plan.execute();

      expect(result.failures).toEqual([]);
      expect(new Set(result.deleted.map((entry) => entry.path))).toEqual(
        new Set(trees.map((tree) => tree.source))
      );
      for (const tree of trees) {
        await expect(fs.stat(tree.source)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(path.join(tree.source, tree.empty))).rejects.toMatchObject({ code: "ENOENT" });
        const destination = destinations.get(tree.source);
        expect(destination).toBeDefined();
        expect((await fs.stat(path.join(destination!, tree.empty))).isDirectory()).toBe(true);
        for (const [relative, bytes] of tree.payloads) {
          expect(await fs.readFile(path.join(destination!, relative))).toEqual(bytes);
        }
      }
      expect((await fs.stat(workspace)).isDirectory()).toBe(true);
      for (const [file, text] of retained) expect(await fs.readFile(file)).toEqual(Buffer.from(text));
      expect((await prepareClean(["codex"], { home, checkOpenPaths: closed, trash: move })).entries).toEqual([]);
    }
  );

  it.each([
    ["sqlite/codex-thread-summaries-dev.db", "thread_turn_summaries", "host_key"],
    ["sqlite/codex-history-snapshots-dev.db", "app_server_history_snapshots", "host_id"]
  ] as const)("removes orphan local %s rows and keeps remote rows/settings", async (file, table, host) => {
    const fixture = await makeFixture();
    const target = path.join(fixture.root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const database = new DatabaseSync(target);
    database.exec(`CREATE TABLE "${table}"(thread_id TEXT, "${host}" TEXT, body TEXT);
      INSERT INTO "${table}" VALUES('selected', 'local', 'local content'), ('selected', 'ssh:fixture', 'remote same ID'),
        ('nested', 'local:fixture', 'nested local'), ('remote-only', 'ssh:fixture', 'remote content'),
        ('unknown', NULL, 'unknown content')`);
    database.close();
    const result = await (await prepareClean(["codex"], {
      home: fixture.home, checkOpenPaths: closed, trash: fixture.move
    })).execute();
    expect(result.failures).toEqual([]);
    const retained = new DatabaseSync(target, { readOnly: true });
    try {
      expect(retained.prepare(`SELECT body FROM "${table}" ORDER BY body`).all()).toEqual([
        { body: "remote content" }, { body: "remote same ID" }, { body: "unknown content" }
      ]);
    } finally { retained.close(); }
    expect(JSON.parse(await fs.readFile(fixture.global, "utf8"))).toEqual({
      "pinned-thread-ids": ["remote-only"], theme: "dark"
    });
  });

  it.each(["automation_runs", "inbox_items"])("removes %s-only local residual references", async (table) => {
    const fixture = await makeFixture();
    const target = path.join(fixture.root, "sqlite", "codex-dev.db");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const database = new DatabaseSync(target);
    database.exec(`CREATE TABLE "${table}"(thread_id TEXT, body TEXT);
      INSERT INTO "${table}" VALUES('selected', 'selected residual'), ('nested', 'nested residual');
      CREATE TABLE local_thread_catalog(thread_id TEXT, host_id TEXT);
      INSERT INTO local_thread_catalog VALUES('remote-only', 'ssh:fixture')`);
    database.close();
    const result = await (await prepareClean(["codex"], {
      home: fixture.home, checkOpenPaths: closed, trash: fixture.move
    })).execute();
    expect(result.failures).toEqual([]);
    const retained = new DatabaseSync(target, { readOnly: true });
    try {
      expect(retained.prepare(`SELECT * FROM "${table}"`).all()).toEqual([]);
      expect(retained.prepare("SELECT * FROM local_thread_catalog").all()).toEqual([
        { thread_id: "remote-only", host_id: "ssh:fixture" }
      ]);
    } finally { retained.close(); }
    expect(JSON.parse(await fs.readFile(fixture.global, "utf8"))).toEqual({
      "pinned-thread-ids": ["remote-only"], theme: "dark"
    });
  });

  it("guards auxiliary source bytes before any provider data is moved", async () => {
    const fixture = await makeFixture();
    const file = path.join(fixture.root, "logs_2.sqlite");
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE logs(thread_id TEXT, body TEXT); INSERT INTO logs VALUES('selected', 'synthetic')");
    database.close();
    const plan = await prepareCodexConversationMetadata(fixture.home, fixture.move);
    const writer = new DatabaseSync(file);
    writer.exec("INSERT INTO logs VALUES('new-id', 'concurrent synthetic')");
    writer.close();
    await expect(plan.validate()).rejects.toThrow(/Metadata changed after preflight/);
    expect(JSON.parse(await fs.readFile(fixture.global, "utf8"))["pinned-thread-ids"]).toEqual([
      "selected", "nested", "remote-only"
    ]);
  });

  it("refuses malformed auxiliary IDs before changing bulk data", async () => {
    const fixture = await makeFixture();
    const file = path.join(fixture.root, "logs_2.sqlite");
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE logs(thread_id TEXT); INSERT INTO logs VALUES('../unsafe')");
    database.close();
    const before = await fs.readFile(file);
    await expect(prepareClean(["codex"], {
      home: fixture.home, checkOpenPaths: closed, trash: fixture.move
    })).rejects.toThrow(/Invalid conversation ID/);
    expect(await fs.readFile(file)).toEqual(before);
    expect(JSON.parse(await fs.readFile(fixture.global, "utf8"))["pinned-thread-ids"]).toContain("selected");
  });
});

async function makeFixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-codex-bulk-inventory-")));
  homes.push(home);
  const root = path.join(home, ".codex");
  await fs.mkdir(root);
  const global = path.join(root, ".codex-global-state.json");
  await fs.writeFile(global, JSON.stringify({ "pinned-thread-ids": ["selected", "nested", "remote-only"], theme: "dark" }));
  let moved = 0;
  const move = async (files: string[]) => {
    const trash = path.join(home, "fixture-trash");
    await fs.mkdir(trash, { recursive: true });
    for (const source of files) await fs.rename(source, path.join(trash, String(moved++)));
  };
  return { home, root, global, move };
}
