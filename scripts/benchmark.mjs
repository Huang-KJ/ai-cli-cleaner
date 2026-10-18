import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, promises as fs, createReadStream } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { cpus, release, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { discoverConversations } from "../dist/conversations/discover.js";
import { deleteConversations } from "../dist/conversations/delete.js";
import { getCodexMetadataPaths } from "../dist/conversations/codex-paths.js";
import { getPathSnapshot, getCanonicalPath, containsPath } from "../dist/fs/paths.js";
import { moveToSystemTrash } from "../dist/fs/trash.js";
import { withOperation, wrapOperationTrash, listOperations } from "../dist/recovery/operations.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(import.meta.url);
const stages = ["discover", "preview", "snapshot", "delete"];
const maxBytes = 250_000_000;
const maxRss = 1_000_000_000;
const marker = "ai-cleaner-synthetic-benchmark-v1";

function options(args) {
  const result = { sizes: [100], selected: 10, payload: 512, repeat: 1 };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    const value = args[index + 1];
    if (!value || !["sizes", "selected", "payload", "repeat", "output", "worker", "home"].includes(key)) {
      throw new Error("Accepted options: --sizes, --selected, --payload, --repeat, and --output.");
    }
    result[key] = key === "sizes" ? value.split(",").map(Number)
      : ["selected", "payload", "repeat"].includes(key) ? Number(value) : value;
  }
  assert(result.sizes.every((size) => Number.isInteger(size) && size >= 10 && size <= 10_000));
  assert(Number.isInteger(result.selected) && result.selected >= 1 && result.selected <= 1_000);
  assert(Number.isInteger(result.payload) && result.payload >= 32 && result.payload <= 1_024);
  assert(Number.isInteger(result.repeat) && result.repeat >= 1 && result.repeat <= 3);
  return result;
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inventory(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), "Synthetic data must not contain symlinks.");
    if (entry.isDirectory()) result.push(...await inventory(file));
    else result.push({ file, bytes: (await fs.stat(file)).size });
  }
  return result;
}

export async function fixture(config, count) {
  const created = await fs.mkdtemp(path.join(tmpdir(), "ai-cleaner-benchmark-"));
  let database;
  let logs;
  try {
    const home = await fs.realpath(created);
    const paths = getCodexMetadataPaths(home);
    await fs.mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
    const ids = Array.from({ length: count }, (_, index) => `bench-${String(index).padStart(6, "0")}`);
    ids[count - 1] = `${ids[0]}-extended`;
    const selected = Math.min(config.selected, count - 2);
    const payload = "x".repeat(config.payload);
    database = new DatabaseSync(paths.stateDatabase);
    logs = new DatabaseSync(paths.logsDatabase);
    database.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, updated_at INTEGER);
      CREATE TABLE thread_items(thread_id TEXT, contents TEXT);
      CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);
      BEGIN`);
    logs.exec("CREATE TABLE logs(thread_id TEXT, message TEXT); BEGIN");
    const thread = database.prepare("INSERT INTO threads VALUES(?, ?, ?, ?)");
    const item = database.prepare("INSERT INTO thread_items VALUES(?, ?)");
    const edge = database.prepare("INSERT INTO thread_spawn_edges VALUES(?, ?)");
    const log = logs.prepare("INSERT INTO logs VALUES(?, ?)");
    const conversations = [];
    for (const [index, id] of ids.entries()) {
      const file = path.join(home, ".codex", "sessions", `${id}.jsonl`);
      const lines = [JSON.stringify({ type: "session_meta", payload: { id, timestamp: "2026-10-14T00:00:00Z" } })];
      for (let message = 0; message < 4; message++) {
        lines.push(JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `${id}:${message}:${payload}` } }));
        item.run(id, `${id}:${message}:${payload}`);
      }
      await fs.writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
      thread.run(id, file, `Synthetic ${id}`, 1_792_022_400);
      if (index % 10 && index < selected) edge.run(ids[index - index % 10], id);
      log.run(id, `${id}:${payload}`);
      if (index < selected) conversations.push({ key: `codex:${id}`, providerId: "codex", providerName: "Codex",
        id, title: `Synthetic ${id}`, sizeBytes: 0, dataPaths: [file], guardPaths: [paths.stateDatabase],
        deleteStrategy: { kind: "local", metadata: { kind: "codex", ...paths } }, warnings: [] });
    }
    database.exec("COMMIT");
    logs.exec("COMMIT");
    database.close();
    database = undefined;
    logs.close();
    logs = undefined;
    await fs.writeFile(paths.sessionIndex, `${ids.map((id) => JSON.stringify({ id, thread_name: `Synthetic ${id}` })).join("\n")}\n`);
    await fs.writeFile(paths.historyFile, `${ids.map((session_id) => JSON.stringify({ session_id, text: `${session_id}:${payload}` })).join("\n")}\n`);
    await fs.writeFile(paths.globalStateFiles[0], JSON.stringify({ "pinned-thread-ids": ids,
      "thread-project-assignments": Object.fromEntries(ids.map((id) => [id, "synthetic-project"])),
      "electron-thread-read-state-v1": { local: Object.fromEntries(ids.map((id) => [id, true])), remote: { [ids[0]]: true } },
      customSetting: "synthetic-untouched" }));
    await fs.writeFile(path.join(home, ".codex", "auth.json"), '{"fixture":"synthetic-no-credential"}\n');
    const files = await inventory(path.join(home, ".codex"));
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    assert(bytes < maxBytes, "Synthetic source data exceeds 250 MB.");
    const spec = { marker, count, selected, payload: config.payload, ids, conversations, paths,
      bytes, files: files.length, sqliteBytes: files.filter(({ file }) => file.endsWith(".sqlite")).reduce((sum, file) => sum + file.bytes, 0),
      jsonlBytes: files.filter(({ file }) => file.endsWith(".jsonl")).reduce((sum, file) => sum + file.bytes, 0) };
    await fs.writeFile(path.join(home, "benchmark.json"), JSON.stringify(spec), { mode: 0o600 });
    return { home, spec };
  } catch (error) {
    const errors = [error];
    for (const handle of [database, logs]) {
      try { handle?.close(); } catch (closeError) { errors.push(closeError); }
    }
    try { await moveToSystemTrash([created]); } catch (cleanupError) { errors.push(cleanupError); }
    if (errors.length > 1) throw new AggregateError(errors, `Synthetic fixture setup failed; check cleanup status: ${created}`);
    throw error;
  }
}
async function validatedHome(input) {
  assert(path.isAbsolute(input));
  const home = await fs.realpath(input);
  const temporary = await fs.realpath(tmpdir());
  const stat = await fs.lstat(input);
  assert(!stat.isSymbolicLink() && stat.isDirectory() && stat.uid === process.getuid());
  assert(path.dirname(home) === temporary && path.basename(home).startsWith("ai-cleaner-benchmark-"));
  const spec = JSON.parse(await fs.readFile(path.join(home, "benchmark.json"), "utf8"));
  assert.equal(spec.marker, marker);
  assert(spec.bytes < maxBytes && spec.count <= 10_000);
  for (const file of Object.values(spec.paths).flat()) {
    assert(typeof file === "string" && containsPath(path.join(home, ".codex"), file));
  }
  return { home, spec };
}

function rowDigest(file, tables, selected = new Set()) {
  const database = new DatabaseSync(file, { readOnly: true });
  const hash = createHash("sha256");
  let rows = 0;
  try {
    for (const [table, key] of tables) {
      for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) {
        if (selected.has(row[key])) continue;
        hash.update(`${table}:${JSON.stringify(row)}\n`);
        rows++;
      }
    }
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { database.close(); }
  return { digest: hash.digest("hex"), rows };
}

async function worker(config) {
  assert(stages.includes(config.worker));
  const { home, spec } = await validatedHome(config.home);
  const isolated = process.env.HOME === home && ["NODE_OPTIONS", "NODE_PATH", "NPM_TOKEN", "CODEX_HOME", "COPILOT_HOME",
    "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].every((key) => process.env[key] === undefined);
  assert(isolated, "The worker must be launched by an isolated controller.");
  const selected = new Set(spec.conversations.map(({ id }) => id));
  const before = new Map();
  for (const { file } of await inventory(path.join(home, ".codex"))) before.set(file, await digest(file));
  const stateTables = [["threads", "id"], ["thread_items", "thread_id"]];
  const stateBefore = rowDigest(spec.paths.stateDatabase, stateTables, selected);
  const logsBefore = rowDigest(spec.paths.logsDatabase, [["logs", "thread_id"]], selected);
  let moved = 0;
  const movedBackups = [];
  const trash = async (files) => {
    const directory = path.join(home, "fixture-trash");
    await fs.mkdir(directory, { mode: 0o700, recursive: true });
    for (const file of files) {
      assert(containsPath(home, file) && file !== home);
      assert(containsPath(home, await fs.realpath(file)));
      const destination = path.join(directory, `${moved++}-${path.basename(file)}`);
      await fs.rename(file, destination);
      if (file.includes(`${path.sep}recovery${path.sep}`)) movedBackups.push(destination);
    }
  };
  const closed = async () => ({ supported: true, openPaths: [] });
  const start = process.hrtime.bigint();
  let result;
  if (config.worker === "discover") result = await discoverConversations(["codex"], { home });
  else if (config.worker === "snapshot") result = await getPathSnapshot(path.join(home, ".codex", "sessions"));
  else {
    const execute = () => deleteConversations(spec.conversations, { home, dryRun: config.worker === "preview",
      checkOpenPaths: closed, trash: wrapOperationTrash(trash) });
    result = config.worker === "delete"
      ? await withOperation({ home, kind: "conversations", target: ["codex"] }, execute) : await execute();
  }
  const wallSeconds = Number(process.hrtime.bigint() - start) / 1e9;
  if (config.worker === "discover") {
    assert.equal(result.conversations.length, spec.count);
    assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings));
    assert(result.conversations.every((item) => !item.disabledReason && item.dataPaths.length === 1));
    assert.deepEqual(new Set(result.conversations.map(({ id }) => id)), new Set(spec.ids));
  } else if (config.worker === "snapshot") {
    assert.equal(result.identity.kind, "directory");
    assert.match(result.identity.treeFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(result.sizeBytes, (await inventory(path.join(home, ".codex", "sessions"))).reduce((sum, item) => sum + item.bytes, 0));
  } else {
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures.map(({ error }) => error.message)));
    assert.equal((config.worker === "preview" ? result.previewed : result.deleted).length, spec.selected);
  }
  if (config.worker !== "delete") {
    for (const [file, hash] of before) assert.equal(await digest(file), hash, `Source file changed: ${path.basename(file)}`);
    assert.equal(moved, 0);
    assert.equal((await listOperations(home)).length, 0);
  } else {
    assert.deepEqual(rowDigest(spec.paths.stateDatabase, stateTables), stateBefore);
    assert.deepEqual(rowDigest(spec.paths.logsDatabase, [["logs", "thread_id"]]), logsBefore);
    for (const id of spec.ids) {
      const file = path.join(home, ".codex", "sessions", `${id}.jsonl`);
      if (selected.has(id)) await assert.rejects(fs.lstat(file), { code: "ENOENT" });
      else assert.equal(await digest(file), before.get(file));
    }
    for (const [file, key] of [[spec.paths.sessionIndex, "id"], [spec.paths.historyFile, "session_id"]]) {
      const rows = (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(rows.map((row) => row[key]), spec.ids.filter((id) => !selected.has(id)));
    }
    const global = JSON.parse(await fs.readFile(spec.paths.globalStateFiles[0], "utf8"));
    assert.deepEqual(global["pinned-thread-ids"], spec.ids.filter((id) => !selected.has(id)));
    assert.equal(global.customSetting, "synthetic-untouched");
    assert.equal(global["electron-thread-read-state-v1"].remote[spec.ids[0]], true);
    assert.equal(await digest(path.join(home, ".codex", "auth.json")), before.get(path.join(home, ".codex", "auth.json")));
    assert.equal(movedBackups.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(movedBackups[0], "manifest.json"), "utf8"));
    assert.deepEqual(new Set(manifest.conversationIds), selected);
    for (const file of manifest.files) assert.equal(await digest(path.join(movedBackups[0], path.basename(file.backupPath))), file.sha256);
    const records = await listOperations(home);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "succeeded");
  }
  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  console.log(JSON.stringify({ stage: config.worker, wallSeconds, maxRssBytes,
    isolated, count: spec.count, selected: spec.selected, bytes: spec.bytes, sqliteBytes: spec.sqliteBytes,
    jsonlBytes: spec.jsonlBytes, files: spec.files, correctness: "passed",
    checks: config.worker === "delete" ? "selected removed; all retained rollout/SQLite rows unchanged; JSON indices; remote/custom/auth retained; backup hash; journal succeeded"
      : "complete result and original source hashes unchanged; no operation journal", withinRssLimit: maxRssBytes < maxRss }));
}

export async function runChild(binary, args, cwd, env, timeout = 300_000, grace = 5_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let forced;
    let failure;
    const signal = (kind) => {
      if (!child.pid) return;
      // detached 建立本輪獨立程序群組，訊號不影響其他 Agent。
      try { process.kill(-child.pid, kind); }
      catch (error) { if (error.code !== "ESRCH") failure ??= error; }
    };
    const stop = (error) => {
      failure ??= error;
      signal("SIGTERM");
      forced ??= setTimeout(() => signal("SIGKILL"), grace);
    };
    const interrupt = () => stop(new Error("Synthetic child-process verification was interrupted."));
    const deadline = setTimeout(() => stop(new Error("Synthetic child-process verification timed out.")), timeout);
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(forced);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      // 主程序已退出也收束其殘留子程序，再讓 controller 回收資料。
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") failure ??= error; }
      if (failure) reject(failure);
      else resolve({ code, signal, stdout, stderr });
    });
  });
}

export async function runStage(home, stage) {
  const result = await runChild(process.execPath, ["--max-old-space-size=512", script, "--worker", stage, "--home", home],
    root, { HOME: home, TMPDIR: tmpdir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", LANG: "C", TZ: "UTC" });
  if (result.code !== 0) throw new Error(`Synthetic ${stage} failed, exit=${result.code}, signal=${result.signal}: ${result.stderr.slice(-4_000)}`);
  return JSON.parse(result.stdout.trim());
}

export async function validateOutput(output) {
  assert(containsPath(root, output), "Output must be inside the project.");
  const expected = path.join(await fs.realpath(root), path.relative(root, output));
  assert.equal(await getCanonicalPath(output), expected, "Output path must not resolve through a symlink.");
  try { await fs.lstat(output); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("The output file already exists; choose a new name to avoid overwriting data.");
}

async function main(config) {
  if (config.worker) return worker(config);
  assert.equal(process.platform, "darwin", "This benchmark supports macOS only.");
  const output = config.output ? path.resolve(root, config.output) : undefined;
  if (output) await validateOutput(output);
  const sources = {};
  for (const file of ["conversations/discover.js", "conversations/delete-codex.js", "conversations/codex-metadata.js", "conversations/sqlite.js", "fs/paths.js"]) {
    sources[file] = await digest(path.join(root, "dist", file));
  }
  const report = { formatVersion: 1, createdAt: new Date().toISOString(), command: [process.execPath, script, ...process.argv.slice(2)],
    environment: { node: process.version, macOS: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
      kernel: release(), arch: process.arch, cpu: cpus()[0].model, cores: cpus().length, totalMemoryBytes: totalmem() },
    configuration: { ...config, maxSourceBytes: maxBytes, maxRssBytes: maxRss, heapLimitMiB: 512,
      generation: "fixed bench-000000 IDs, final prefix-overlap ID; x payload; 4 rollout messages and 4 SQLite items per thread; one log/history/index row; selected parent-child groups of ten; no random data",
      timings: "production stage only; fixture generation and correctness checks excluded from wall; process peak RSS includes imports and correctness checks; OS cache not flushed",
      substitutions: "closed open-file check and registered fixture rename Trash for chosen source/backup; production temporary cleanup uses native system Trash; no ps/lsof/network" },
    compiledSources: sources, results: [], cleanup: [], status: "running" };
  if (output) await fs.mkdir(path.dirname(output), { recursive: true });
  const save = async () => {
    if (!output) return;
    await validateOutput(output);
    const handle = await fs.open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); }
    finally { await handle.close(); }
  };
  try {
    for (const count of config.sizes) {
      for (let repetition = 1; repetition <= config.repeat; repetition++) {
        const { home } = await fixture(config, count);
        try {
          for (const stage of stages) {
            console.log(`start count=${count} repetition=${repetition} stage=${stage}`);
            const result = await runStage(home, stage);
            report.results.push({ repetition, ...result });
            console.log(`done count=${count} stage=${stage} wall=${result.wallSeconds.toFixed(3)}s peakRSS=${(result.maxRssBytes / 1e6).toFixed(1)}MB correctness=${result.correctness}`);
            assert(result.withinRssLimit, "Peak RSS exceeded 1 GB; stopping before the next size.");
          }
        } finally {
          try {
            await moveToSystemTrash([home]);
            await assert.rejects(fs.lstat(home), { code: "ENOENT" });
            report.cleanup.push({ count, repetition, status: "system-trash" });
          } catch (error) {
            report.cleanup.push({ count, repetition, status: "retained", path: home });
            throw error;
          }
        }
      }
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    throw error;
  } finally { await save(); }
  console.log(output ? `report=${path.relative(root, output)}` : JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  main(options(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
