import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { getCodexMetadataPaths } from "../src/conversations/codex-paths.js";
import { prepareCodexThreadsMetadata, prepareLiveCodexThreadsMetadata } from "../src/conversations/codex-metadata.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});

const sources = [
  ["thread_history_1.sqlite", "thread_items"],
  ["thread_history_1.sqlite", "thread_realtime_items"],
  ["thread_history_1.sqlite", "thread_turns"],
  ["thread_history_1.sqlite", "thread_history_projection_state"],
  ["logs_2.sqlite", "logs"],
  ["goals_1.sqlite", "thread_goals"],
  ["goals_1.sqlite", "thread_goal_continuation_deferrals"],
  ["memories_1.sqlite", "stage1_outputs"],
  ["memories_v2_1.sqlite", "stage1_outputs"],
  ["queue_1.sqlite", "queued_items"],
  ["queue_1.sqlite", "queued_thread_revisions"],
  ["sqlite/codex-dev.db", "automation_runs"],
  ["sqlite/codex-dev.db", "inbox_items"]
] as const;

describe("Codex auxiliary metadata-only inventory", () => {
  it.each([false, true])("preserves unreadable memory stores and Markdown by default; preview=%s", async (dryRun) => {
    const home = await makeHome();
    const memory = await seedMemories(home);
    const rollout = path.join(home, ".codex", "sessions", "selected.jsonl");
    await fs.mkdir(path.dirname(rollout));
    await fs.writeFile(rollout, '{"type":"session_meta","payload":{"id":"selected"}}\n');
    const discovered = await discoverConversations(["codex"], { home });
    expect(discovered.warnings).toEqual([]);
    expect(discovered.conversations.map((item) => item.id)).toEqual(["selected"]);
    expect(discovered.conversations[0]?.guardPaths.some((file) => file.includes("/.codex/memories"))).toBe(false);
    const optedIn = await discoverConversations(["codex"], { home, includeMemories: true });
    const selected = optedIn.conversations.find((item) => item.id === "selected")!;
    const move = movingTrash(home);
    for (const file of memory.keys()) await fs.chmod(file, 0o000);
    try {
      const result = await deleteConversations([selected], {
        home, dryRun,
        checkOpenPaths: async (files) => {
          expect(files.some((file) => file.includes("/.codex/memories"))).toBe(false);
          return closed();
        },
        trash: async (files) => {
          expect(files.some((file) => file.includes("/.codex/memories"))).toBe(false);
          await move(files);
        }
      });
      expect(result.failures).toEqual([]);
      expect(dryRun ? result.previewed : result.deleted).toEqual([selected]);
      const remaining = await discoverConversations(["codex"], { home });
      expect(remaining.warnings).toEqual([]);
      expect(remaining.conversations.map((item) => item.id)).toEqual(dryRun ? ["selected"] : []);
    } finally {
      for (const file of memory.keys()) await fs.chmod(file, 0o600);
    }
    for (const [file, bytes] of memory) expect(await fs.readFile(file)).toEqual(bytes);
    await expect(fs.lstat(path.join(home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to report memory-only opt-in candidates deleted when memories are preserved", async () => {
    const home = await makeHome();
    const memory = await seedMemories(home);
    expect((await discoverConversations(["codex"], { home })).conversations).toEqual([]);
    const optedIn = await discoverConversations(["codex"], { home, includeMemories: true });
    const selected = optedIn.conversations.find((item) => item.id === "selected")!;
    expect(selected.dataPaths).toEqual([]);
    for (const file of memory.keys()) await fs.chmod(file, 0o000);
    try {
      const result = await deleteConversations([selected], {
        home, checkOpenPaths: closed, trash: async () => { throw new Error("不得搬移資料"); }
      });
      expect(result.deleted).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error.message).toMatch(/Memory-only conversations are preserved/);
    } finally {
      for (const file of memory.keys()) await fs.chmod(file, 0o600);
    }
    for (const [file, bytes] of memory) expect(await fs.readFile(file)).toEqual(bytes);
    await expect(fs.lstat(path.join(home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["offline", prepareCodexThreadsMetadata], ["preview", prepareLiveCodexThreadsMetadata]
  ] as const)("excludes supplied memory metadata paths from the default %s API", async (label, prepare) => {
    const home = await makeHome();
    const memory = await seedMemories(home);
    const paths = getCodexMetadataPaths(home, { includeMemories: true });
    for (const file of memory.keys()) await fs.chmod(file, 0o000);
    try {
      const plan = await prepare(home, paths, ["selected"], async () => { throw new Error("不得搬移資料"); });
      expect(plan.paths.some((file) => file.includes("/.codex/memories"))).toBe(false);
      expect(plan.operations).toEqual([]);
      await plan.prepareRecovery();
      if (label === "preview") await expect(plan.execute()).rejects.toThrow(/require stopped agents/);
      else await plan.execute();
    } finally {
      for (const file of memory.keys()) await fs.chmod(file, 0o600);
    }
    for (const [file, bytes] of memory) expect(await fs.readFile(file)).toEqual(bytes);
  });

  it.each(["memories_1.sqlite", "memories_v2_1.sqlite"])(
    "discovers stage-1-only jobs and preserves shared jobs when deleting from %s", async (file) => {
      const home = await makeHome();
      const database = await makeDatabase(home, file);
      database.exec(`CREATE TABLE stage1_outputs(thread_id TEXT PRIMARY KEY, raw_memory TEXT);
        CREATE TABLE jobs(kind TEXT, job_key TEXT, last_error TEXT, PRIMARY KEY(kind, job_key));
        CREATE TABLE consolidation_progress(singleton INTEGER PRIMARY KEY, max_thread_count INTEGER);
        INSERT INTO stage1_outputs VALUES('retained', 'synthetic retained memory');
        INSERT INTO jobs VALUES('memory_stage1', 'selected', 'synthetic selected error'),
          ('memory_stage1', 'retained', 'synthetic retained error'),
          ('memory_consolidate_global', 'global', 'synthetic shared error'),
          ('future_kind', 'selected', 'synthetic unrelated error');
        INSERT INTO consolidation_progress VALUES(1, 200)`);
      database.close();
      const discovery = await discoverConversations(["codex"], { home, includeMemories: true });
      expect(discovery.warnings).toEqual([]);
      expect(discovery.conversations.map((item) => item.id).sort()).toEqual(["retained", "selected"]);
      const selected = discovery.conversations.find((item) => item.id === "selected")!;
      const result = await deleteConversations([selected], { home, includeMemories: true, checkOpenPaths: closed, trash: movingTrash(home) });
      expect(result.failures).toEqual([]);
      const retained = new DatabaseSync(path.join(home, ".codex", file), { readOnly: true });
      try {
        expect(retained.prepare("SELECT * FROM stage1_outputs").all()).toEqual([
          { thread_id: "retained", raw_memory: "synthetic retained memory" }
        ]);
        expect(retained.prepare("SELECT * FROM jobs ORDER BY kind").all()).toEqual([
          { kind: "future_kind", job_key: "selected", last_error: "synthetic unrelated error" },
          { kind: "memory_consolidate_global", job_key: "global", last_error: "synthetic shared error" },
          { kind: "memory_stage1", job_key: "retained", last_error: "synthetic retained error" }
        ]);
        expect(retained.prepare("SELECT * FROM consolidation_progress").all()).toEqual([
          { singleton: 1, max_thread_count: 200 }
        ]);
      } finally { retained.close(); }
    }
  );

  it.each(["missing-stage1", "missing-kind", "unsafe-job-key"])(
    "refuses unsupported v2 memory %s before moving conversation files", async (kind) => {
      const home = await makeHome();
      const history = path.join(home, ".codex", "history.jsonl");
      const original = '{"session_id":"valid"}\n';
      await fs.writeFile(history, original);
      const database = await makeDatabase(home, "memories_v2_1.sqlite");
      if (kind !== "missing-stage1") database.exec("CREATE TABLE stage1_outputs(thread_id TEXT)");
      if (kind === "missing-kind") database.exec("CREATE TABLE jobs(job_key TEXT)");
      else {
        database.exec("CREATE TABLE jobs(kind TEXT, job_key TEXT)");
        database.prepare("INSERT INTO jobs VALUES('memory_stage1', ?)")
          .run(kind === "unsafe-job-key" ? "../unsafe" : "selected");
      }
      database.close();
      const before = await fs.readFile(path.join(home, ".codex", "memories_v2_1.sqlite"));
      const discovery = await discoverConversations(["codex"], { home, includeMemories: true });
      expect(discovery.conversations[0]?.disabledReason).toBeTruthy();
      expect(discovery.conversations.every((item) => item.disabledReason)).toBe(true);
      expect(discovery.warnings.join("\n")).toMatch(
        kind === "missing-stage1" ? /Missing required table stage1_outputs/
          : kind === "missing-kind" ? /missing required column kind/ : /Invalid conversation ID/
      );
      const result = await deleteConversations(discovery.conversations, {
        home, includeMemories: true, checkOpenPaths: closed, trash: async () => { throw new Error("不得搬移資料"); }
      });
      expect(result.deleted).toEqual([]);
      expect(result.failures).toHaveLength(discovery.conversations.length);
      expect(await fs.readFile(history, "utf8")).toBe(original);
      expect(await fs.readFile(path.join(home, ".codex", "memories_v2_1.sqlite"))).toEqual(before);
    }
  );

  it.each(sources)("discovers and deletes only the selected residual ID in %s/%s", async (file, table) => {
    const home = await makeHome();
    const includeMemories = file.startsWith("memories");
    const database = await makeDatabase(home, file);
    database.exec(`CREATE TABLE "${table}"(thread_id TEXT, body TEXT);
      INSERT INTO "${table}" VALUES('selected', 'synthetic selected content'), ('retained', 'synthetic retained content')`);
    database.close();
    const discovery = await discoverConversations(["codex"], { home, includeMemories });
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations.map((item) => item.id).sort()).toEqual(["retained", "selected"]);
    expect(discovery.conversations.every((item) => item.dataPaths.length === 0)).toBe(true);
    const selected = discovery.conversations.find((item) => item.id === "selected")!;
    expect(selected.disabledReason).toBeUndefined();
    const result = await deleteConversations([selected], { home, includeMemories, checkOpenPaths: closed, trash: movingTrash(home) });
    expect(result.failures).toEqual([]);
    expect(result.deleted).toEqual([selected]);
    const retained = new DatabaseSync(path.join(home, ".codex", file), { readOnly: true });
    try {
      expect(retained.prepare(`SELECT * FROM "${table}"`).all()).toEqual([
        { thread_id: "retained", body: "synthetic retained content" }
      ]);
    } finally { retained.close(); }
  });

  it.each([
    ["sqlite/codex-thread-summaries-dev.db", "thread_turn_summaries", "host_key"],
    ["sqlite/codex-history-snapshots-dev.db", "app_server_history_snapshots", "host_id"]
  ] as const)("excludes remote-only IDs and preserves remote rows in %s", async (file, table, host) => {
    const home = await makeHome();
    const database = await makeDatabase(home, file);
    database.exec(`CREATE TABLE "${table}"(thread_id TEXT, "${host}" TEXT, body TEXT);
      INSERT INTO "${table}" VALUES('selected', 'local', 'local selected'),
        ('selected', 'ssh:fixture', 'remote selected'), ('nested', 'local:fixture', 'nested local'),
        ('remote-only', 'ssh:fixture', 'remote'), ('unknown', NULL, 'unknown'), ('locality', 'locality', 'unknown')`);
    database.close();
    const discovery = await discoverConversations(["codex"], { home });
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations.map((item) => item.id).sort()).toEqual(["nested", "selected"]);
    const selected = discovery.conversations.find((item) => item.id === "selected")!;
    const result = await deleteConversations([selected], { home, checkOpenPaths: closed, trash: movingTrash(home) });
    expect(result.failures).toEqual([]);
    const retained = new DatabaseSync(path.join(home, ".codex", file), { readOnly: true });
    try {
      expect(retained.prepare(`SELECT body FROM "${table}" ORDER BY body`).all()).toEqual([
        { body: "nested local" }, { body: "remote" }, { body: "remote selected" }, { body: "unknown" }, { body: "unknown" }
      ]);
    } finally { retained.close(); }
  });

  it.each(["local_thread_catalog", "thread_timeline_ledger", "local_thread_catalog_scan_entries", "live_visualization_suggestions"])(
    "supports optional App host columns in %s while preserving remote rows", async (table) => {
      for (const host of [false, true]) {
        const home = await makeHome();
        const database = await makeDatabase(home, "sqlite/codex-dev.db");
        database.exec(`CREATE TABLE "${table}"(thread_id TEXT${host ? ", host_id TEXT" : ""});
          INSERT INTO "${table}" VALUES('selected'${host ? ", 'local:fixture'" : ""}), ('retained'${host ? ", 'local'" : ""})`);
        if (host) database.exec(`INSERT INTO "${table}" VALUES('selected', 'ssh:fixture'), ('remote-only', 'ssh:fixture'), ('unknown', NULL)`);
        database.close();
        const discovery = await discoverConversations(["codex"], { home });
        expect(discovery.warnings).toEqual([]);
        expect(discovery.conversations.map((item) => item.id).sort()).toEqual(["retained", "selected"]);
        const selected = discovery.conversations.find((item) => item.id === "selected")!;
        const result = await deleteConversations([selected], { home, checkOpenPaths: closed, trash: movingTrash(home) });
        expect(result.failures).toEqual([]);
        const retained = new DatabaseSync(path.join(home, ".codex", "sqlite/codex-dev.db"), { readOnly: true });
        try {
          expect(retained.prepare(`SELECT thread_id FROM "${table}" ORDER BY thread_id`).all()).toEqual(
            (host ? ["remote-only", "retained", "selected", "unknown"] : ["retained"]).map((thread_id) => ({ thread_id }))
          );
        } finally { retained.close(); }
      }
    }
  );

  it.each(["thread_history_1.sqlite", "goals_1.sqlite", "queue_1.sqlite", "sqlite/codex-dev.db"])(
    "refuses an unknown table layout in %s without modifying safe inventory", async (file) => {
      const home = await makeHome();
      const history = path.join(home, ".codex", "history.jsonl");
      const original = '{"session_id":"valid"}\n';
      await fs.writeFile(history, original);
      const database = await makeDatabase(home, file);
      database.exec("CREATE TABLE unknown_conversations(thread_id TEXT); INSERT INTO unknown_conversations VALUES('unknown')");
      database.close();
      const discovery = await discoverConversations(["codex"], { home });
      expect(discovery.conversations.map((item) => item.id)).toEqual(["valid"]);
      expect(discovery.conversations[0]?.disabledReason).toMatch(/No recognized conversation table/);
      const result = await deleteConversations(discovery.conversations, {
        home, checkOpenPaths: closed, trash: async () => { throw new Error("不得搬移資料"); }
      });
      expect(result.failures).toHaveLength(1);
      expect(await fs.readFile(history, "utf8")).toBe(original);
    }
  );

  it.each(["thread_attachments", "thread_dynamic_tools", "thread_realtime_items", "thread_turns", "thread_items"])(
    "includes orphan state %s IDs", async (table) => {
      const home = await makeHome();
      const database = await makeDatabase(home, "state_5.sqlite");
      database.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT);
        CREATE TABLE "${table}"(thread_id TEXT, body TEXT);
        INSERT INTO "${table}" VALUES('orphan', 'synthetic orphan')`);
      database.close();
      const discovery = await discoverConversations(["codex"], { home });
      expect(discovery.warnings).toEqual([]);
      expect(discovery.conversations.map((item) => item.id)).toEqual(["orphan"]);
      const result = await deleteConversations(discovery.conversations, { home, checkOpenPaths: closed, trash: movingTrash(home) });
      expect(result.failures).toEqual([]);
      const retained = new DatabaseSync(path.join(home, ".codex", "state_5.sqlite"), { readOnly: true });
      try { expect(retained.prepare(`SELECT * FROM "${table}"`).all()).toEqual([]); }
      finally { retained.close(); }
    }
  );

  it.each(["parent", "child"])("deletes orphan spawn edges selected by %s without inventing rollout IDs", async (id) => {
    const home = await makeHome();
    const database = await makeDatabase(home, "state_5.sqlite");
    database.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT);
      CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);
      CREATE TABLE rollout_migration_skipped_rollouts(rollout_path TEXT);
      INSERT INTO thread_spawn_edges VALUES('parent', 'child'), ('retained-parent', 'retained-child');
      INSERT INTO rollout_migration_skipped_rollouts VALUES('/arbitrary/unknown.jsonl')`);
    database.close();
    const discovery = await discoverConversations(["codex"], { home });
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations.map((item) => item.id).sort()).toEqual(["child", "parent", "retained-child", "retained-parent"]);
    const selected = discovery.conversations.find((item) => item.id === id)!;
    const result = await deleteConversations([selected], { home, checkOpenPaths: closed, trash: movingTrash(home) });
    expect(result.failures).toEqual([]);
    const retained = new DatabaseSync(path.join(home, ".codex", "state_5.sqlite"), { readOnly: true });
    try {
      expect(retained.prepare("SELECT * FROM thread_spawn_edges").all()).toEqual([
        { parent_thread_id: "retained-parent", child_thread_id: "retained-child" }
      ]);
      expect(retained.prepare("SELECT * FROM rollout_migration_skipped_rollouts").all()).toEqual([
        { rollout_path: "/arbitrary/unknown.jsonl" }
      ]);
    } finally { retained.close(); }
  });

  it("removes migration records only through the selected thread rollout path", async () => {
    const home = await makeHome();
    const rollout = path.join(home, ".codex", "sessions", "selected.jsonl");
    await fs.mkdir(path.dirname(rollout));
    await fs.writeFile(rollout, '{"type":"session_meta","payload":{"id":"selected"}}\n');
    const database = await makeDatabase(home, "state_5.sqlite");
    database.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT);
      CREATE TABLE rollout_migration_skipped_rollouts(rollout_path TEXT)`);
    database.prepare("INSERT INTO threads VALUES (?, ?)").run("selected", rollout);
    database.prepare("INSERT INTO rollout_migration_skipped_rollouts VALUES (?)").run(rollout);
    database.prepare("INSERT INTO rollout_migration_skipped_rollouts VALUES (?)").run("selected");
    database.prepare("INSERT INTO rollout_migration_skipped_rollouts VALUES (?)").run("/retained/rollout.jsonl");
    database.close();
    const discovery = await discoverConversations(["codex"], { home });
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations.map((item) => item.id)).toEqual(["selected"]);
    const result = await deleteConversations(discovery.conversations, { home, checkOpenPaths: closed, trash: movingTrash(home) });
    expect(result.failures).toEqual([]);
    const retained = new DatabaseSync(path.join(home, ".codex", "state_5.sqlite"), { readOnly: true });
    try {
      expect(retained.prepare("SELECT * FROM rollout_migration_skipped_rollouts ORDER BY rollout_path").all()).toEqual([
        { rollout_path: "/retained/rollout.jsonl" }, { rollout_path: "selected" }
      ]);
    } finally { retained.close(); }
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "removes migration records for every verified selected rollout; primary=%s alias=%s", async (primary, alias) => {
    const canonicalHome = await makeHome();
    const home = alias ? canonicalHome.replace(/^\/private(?=\/var\/)/, "") : canonicalHome;
    if (alias) expect(home).not.toBe(canonicalHome);
    const root = path.join(home, ".codex");
    const selected = path.join(root, "sessions", "selected.jsonl");
    const archived = path.join(root, "archived_sessions", "copy.jsonl");
    const retained = path.join(root, "sessions", "retained.jsonl");
    await fs.mkdir(path.dirname(selected));
    await fs.mkdir(path.dirname(archived));
    await fs.writeFile(selected, '{"type":"session_meta","payload":{"id":"selected"}}\n');
    await fs.writeFile(archived, '{"type":"session_meta","payload":{"id":"selected"}}\n');
    const retainedContent = '{"type":"session_meta","payload":{"id":"retained"}}\n';
    await fs.writeFile(retained, retainedContent);
    const database = await makeDatabase(home, "state_5.sqlite");
    database.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT);
      CREATE TABLE rollout_migration_skipped_rollouts(rollout_path TEXT)`);
    if (primary) database.prepare("INSERT INTO threads VALUES (?, ?)").run("selected", selected);
    database.prepare("INSERT INTO threads VALUES (?, ?)").run("retained", retained);
    for (const file of [selected, archived, retained, "selected", "/unknown/rollout.jsonl"]) {
      database.prepare("INSERT INTO rollout_migration_skipped_rollouts VALUES (?)").run(file);
    }
    database.close();
    const discovery = await discoverConversations(["codex"], { home });
    expect(discovery.warnings).toEqual([]);
    const conversation = discovery.conversations.find((item) => item.id === "selected")!;
    const result = await deleteConversations([conversation], { home, checkOpenPaths: closed, trash: movingTrash(home) });
    expect(result.failures).toEqual([]);
    expect(result.deleted).toEqual([conversation]);
    const remaining = new DatabaseSync(path.join(root, "state_5.sqlite"), { readOnly: true });
    try {
      expect(remaining.prepare("SELECT * FROM rollout_migration_skipped_rollouts ORDER BY rollout_path").all()).toEqual([
        { rollout_path: retained }, { rollout_path: "/unknown/rollout.jsonl" }, { rollout_path: "selected" }
      ].sort((a, b) => a.rollout_path.localeCompare(b.rollout_path)));
      expect(remaining.prepare("SELECT * FROM threads").all()).toEqual([{ id: "retained", rollout_path: retained }]);
    } finally { remaining.close(); }
    await expect(fs.stat(selected)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(archived)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(retained, "utf8")).toBe(retainedContent);
  });

  it.each(["schema", "unsafe-id", "integer-id"] as const)("shows safe inventory but refuses deletion for malformed auxiliary %s", async (kind) => {
    const home = await makeHome();
    const history = path.join(home, ".codex", "history.jsonl");
    const content = `${JSON.stringify({ session_id: "valid", text: "synthetic history" })}\n`;
    await fs.writeFile(history, content);
    const database = await makeDatabase(home, "logs_2.sqlite");
    if (kind === "schema") database.exec("CREATE TABLE logs(body TEXT)");
    else {
      database.exec("CREATE TABLE logs(thread_id, body TEXT)");
      database.prepare("INSERT INTO logs VALUES(?, ?)").run(kind === "unsafe-id" ? "../unsafe" : 17, "synthetic");
    }
    database.close();
    const discovery = await discoverConversations(["codex"], { home });
    expect(discovery.conversations.map((item) => item.id)).toEqual(["valid"]);
    expect(discovery.warnings.join("\n")).toMatch(/logs|ID/);
    expect(discovery.conversations[0]?.disabledReason).toBeTruthy();
    const result = await deleteConversations(discovery.conversations, {
      home, checkOpenPaths: closed, trash: async () => { throw new Error("不得搬移資料"); }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(await fs.readFile(history, "utf8")).toBe(content);
  });

  it("ignores global NULL thread IDs and unrelated tables", async () => {
    const home = await makeHome();
    const database = await makeDatabase(home, "logs_2.sqlite");
    database.exec(`CREATE TABLE logs(thread_id TEXT, body TEXT);
      INSERT INTO logs VALUES(NULL, 'global log'), ('selected', 'synthetic');
      CREATE TABLE unrelated(thread_id TEXT);
      INSERT INTO unrelated VALUES('not-a-conversation')`);
    database.close();
    const discovery = await discoverConversations(["codex"], { home });
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations.map((item) => item.id)).toEqual(["selected"]);
  });

  it("rejects a NULL primary state ID while keeping safe inventory visible", async () => {
    const home = await makeHome();
    await fs.writeFile(path.join(home, ".codex", "history.jsonl"), `${JSON.stringify({ session_id: "valid" })}\n`);
    const database = await makeDatabase(home, "state_5.sqlite");
    database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT); INSERT INTO threads VALUES(NULL, '')");
    database.close();
    const discovery = await discoverConversations(["codex"], { home });
    expect(discovery.conversations.map((item) => item.id)).toEqual(["valid"]);
    expect(discovery.conversations[0]?.disabledReason).toBeTruthy();
    expect(discovery.warnings.join("\n")).toMatch(/ID/);
  });
});

async function makeHome() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-codex-aux-")));
  homes.push(home);
  await fs.mkdir(path.join(home, ".codex"));
  return home;
}

async function makeDatabase(home: string, file: string) {
  const target = path.join(home, ".codex", file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  return new DatabaseSync(target);
}

async function seedMemories(home: string): Promise<Map<string, Buffer>> {
  const files: string[] = [];
  for (const name of ["memories_1.sqlite", "memories_v2_1.sqlite"]) {
    const file = path.join(home, ".codex", name);
    const database = new DatabaseSync(file);
    database.exec(`CREATE TABLE stage1_outputs(thread_id TEXT PRIMARY KEY, raw_memory TEXT);
      INSERT INTO stage1_outputs VALUES('selected', 'synthetic selected memory'), ('memory-only', 'synthetic retained memory')`);
    database.close();
    files.push(file);
  }
  const markdown = path.join(home, ".codex", "memories", "MEMORY.md");
  await fs.mkdir(path.dirname(markdown));
  await fs.writeFile(markdown, "合成長期記憶\n");
  files.push(markdown);
  return new Map(await Promise.all(files.map(async (file) => [file, await fs.readFile(file)] as const)));
}

const closed = async () => ({ supported: true, openPaths: [] as string[] });
function movingTrash(home: string) {
  let moved = 0;
  return async (files: string[]) => {
    const directory = path.join(home, "fixture-trash");
    await fs.mkdir(directory, { recursive: true });
    for (const source of files) await fs.rename(source, path.join(directory, String(moved++)));
  };
}
