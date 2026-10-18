import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { discoverConversations } from "../dist/conversations/discover.js";
import { deleteConversations } from "../dist/conversations/delete.js";
import { prepareClean } from "../dist/cleaners/plan.js";
import { findOpenPaths } from "../dist/fs/open-files.js";
import { moveToSystemTrash } from "../dist/fs/trash.js";
import { snapshotClaimIdentity } from "../dist/fs/claims.js";
import { inspectOperation, listOperations, withOperation, wrapOperationTrash } from "../dist/recovery/operations.js";

const args = process.argv.slice(2);
const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
if (!args.includes("--run")) {
  console.log("node scripts/verify-upstream.mjs --run [--provider=codex,copilot,grok,opencode,antigravity] [--opencode-bin=/absolute/path]\nBy default, verifies installed Codex, Copilot, and Grok CLIs. OpenCode requires an explicit binary path. Run npm run build first. Verification uses a fresh data root and a local mock or no-reply API; it does not use a real account or cloud model.");
  process.exit(args.length ? 2 : 0);
}
assert(args.every((arg) => arg === "--run" || arg.startsWith("--provider=") || arg.startsWith("--opencode-bin=")), "Unsupported verification option.");
assert.equal(new Set(args.map((arg) => arg.split("=")[0])).size, args.length, "An option cannot be specified more than once.");
const targets = (args.find((arg) => arg.startsWith("--provider="))?.slice("--provider=".length) ?? "codex,copilot,grok").split(",");
assert(targets.every((target) => ["codex", "copilot", "grok", "opencode", "antigravity"].includes(target)), "Supported providers: codex, copilot, grok, opencode, antigravity.");
assert.equal(new Set(targets).size, targets.length, "A provider cannot be specified more than once.");
assert.equal(Boolean(args.find((arg) => arg.startsWith("--opencode-bin="))), targets.includes("opencode"), "To verify OpenCode, provide --opencode-bin; this option is only valid when OpenCode is selected.");
assert.equal(process.platform, "darwin");
let root;
let identity;
let base;
const responseText = "UPSTREAM_SYNTHETIC_RESPONSE";
const requests = [];
const children = new Map();
const stopping = new Map();
let cancelled = false;
const report = { evidence: "real-upstream-cli-with-loopback-mock-model", cloudModelVerified: false,
  platform: process.platform, arch: process.arch, node: process.version, cases: [] };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const server = http.createServer(async (request, response) => {
  try {
  let source = "";
  for await (const chunk of request) source += chunk;
  const requestEvidence = { method: request.method, path: request.url };
  requests.push(requestEvidence);
  const input = source ? JSON.parse(source) : {};
  if (/\/v1beta\/models\/.+:streamGenerateContent\?alt=sse$/.test(request.url)) {
    requestEvidence.selectedContext = JSON.stringify(input.contents).includes("UPSTREAM_SYNTHETIC_SELECTED");
    requestEvidence.retainedContext = JSON.stringify(input.contents).includes("UPSTREAM_SYNTHETIC_RETAINED");
    const result = { candidates: [{ content: { role: "model", parts: [{ text: responseText }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, modelVersion: "gemini-3.8-flash" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(result)}\n\n`);
  } else if (request.method === "GET" && request.url.endsWith("/models")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: ["fixture", "gpt-4o", "grok-4.6"].map((id) => ({ id, object: "model" })) }));
  } else if (request.url.endsWith("/responses")) {
    const id = `resp_${randomUUID()}`;
    const item = { id: `msg_${randomUUID()}`, type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: responseText, annotations: [] }] };
    const result = { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: input.model ?? "gpt-5.3-codex",
      output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const events = [
      { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: responseText },
      { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: responseText },
      { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: result }
    ];
    for (const [index, event] of events.entries()) response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`);
    response.end();
  } else if (request.url.endsWith("/chat/completions")) {
    const id = `chatcmpl-${randomUUID()}`;
    const metadata = { id, object: "chat.completion.chunk", model: input.model, created: Math.floor(Date.now() / 1000) };
    if (input.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "stop" }]) {
        response.write(`data: ${JSON.stringify({ ...metadata, choices: [choice], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ...metadata, object: "chat.completion", choices: [{ index: 0,
        message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
  } else {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "fixture endpoint not supported" }));
  }
  } catch {
    if (response.headersSent) response.destroy();
    else { response.writeHead(400, { "Content-Type": "application/json" }); response.end('{"error":"invalid synthetic request"}'); }
  }
});
server.on("connect", (request, socket) => {
  requests.push({ method: "CONNECT", path: request.url, blocked: true });
  socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  cancelled = true;
  for (const child of children.keys()) {
    try { signalGroup(child, "SIGTERM"); } catch {}
  }
  server.closeAllConnections();
});

function environment(home, extra = {}) {
  // 子程序只取得隔離所需的環境，不繼承憑證、代理設定或真實使用者資料根。
  return { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: home, TERM: "dumb", NO_COLOR: "1",
    CODEX_HOME: path.join(home, ".codex"), XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), ...extra };
}

function inside(parent, file) {
  const relative = path.relative(parent, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveBinary(name) {
  // 只採呼叫端 PATH 的絕對目錄，不搜尋目前工作目錄或空白項目。
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory) || path.resolve(directory) === process.cwd()) continue;
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, constants.X_OK);
      const actual = await fs.realpath(candidate);
      if (path.dirname(actual) !== process.cwd() && !inside(projectRoot, actual) && (await fs.lstat(actual)).isFile()) return actual;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error(`Could not find an isolated ${name} binary on PATH.`);
}

function spawnOwned(binary, arguments_, options) {
  const child = spawn(binary, arguments_, { ...options, detached: true });
  let complete;
  const closed = new Promise((resolve) => { complete = resolve; });
  child.once("error", () => {});
  child.once("close", complete);
  children.set(child, closed);
  return child;
}

function signalGroup(child, signal) {
  if (!child.pid) return false;
  try { process.kill(-child.pid, signal); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    error.message = `own process group ${child.pid}, uid ${process.getuid()}, signal ${signal}, main code ${child.exitCode}, main signal ${child.signalCode}: ${error.message}`;
    throw error;
  }
}

async function stopOwned(child) {
  const closed = children.get(child);
  if (!closed) return;
  if (stopping.has(child)) return stopping.get(child);
  const stop = (async () => {
    try {
      if (signalGroup(child, "SIGTERM")) {
        const until = Date.now() + 2000;
        while (Date.now() < until && signalGroup(child, 0)) await new Promise((resolve) => setTimeout(resolve, 50));
        if (signalGroup(child, 0)) signalGroup(child, "SIGKILL");
      }
    } catch (error) {
      // macOS 群組訊號若遭拒，主程序已退出仍需確認群組沒有活躍成員。
      if (error.code !== "EPERM") throw error;
      let timer;
      try {
        await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(error), 2000); })]);
      } finally { clearTimeout(timer); }
      if (child.exitCode === null && child.signalCode === null) throw error;
      const snapshot = await new Promise((resolve, reject) => execFile("/bin/ps", ["-axo", "pgid=,uid=,stat="],
        { env: { PATH: "/usr/bin:/bin" }, timeout: 5000 }, (failure, stdout, stderr) => failure ? reject(failure) :
          stderr.trim() ? reject(new Error("Process group check returned a warning; cleanup could not be confirmed.")) : resolve(stdout)));
      const lines = snapshot.trim().split("\n");
      if (!lines.length || lines.some((line) => !/^\s*\d+\s+\d+\s+\S+\s*$/.test(line))) throw error;
      const members = lines.map((line) => line.trim().split(/\s+/)).filter(([group]) => Number(group) === child.pid);
      if (members.some(([, uid, status]) => Number(uid) !== process.getuid() || !status.startsWith("Z"))) throw error;
      (report.processCleanupChecks ??= []).push({ ownGroup: child.pid, ownUid: process.getuid(), signalError: "EPERM",
        mainExitCode: child.exitCode, mainSignalCode: child.signalCode, activeMembers: 0 });
    }
    await closed;
    children.delete(child);
  })();
  stopping.set(child, stop);
  try { await stop; } finally { stopping.delete(child); }
}

async function run(binary, arguments_, home, timeout = 45_000, extra = {}) {
  assert(!cancelled, "Verification was cancelled.");
  return new Promise((resolve, reject) => {
    const child = spawnOwned(binary, arguments_, { cwd: path.join(home, "workspace"), env: environment(home, extra), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void stopOwned(child).catch(reject); }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      try { await stopOwned(child); resolve({ code: timedOut ? 124 : code, signal, timedOut, stdout, stderr }); }
      catch (error) { reject(error); }
    });
  });
}

function rpc(binary, arguments_, home) {
  assert(!cancelled, "Verification was cancelled.");
  const child = spawnOwned(binary, arguments_, { cwd: path.join(home, "workspace"), env: environment(home), stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let count = 0;
  let stderr = "";
  let closed = false;
  let failure;
  const fail = (error) => {
    failure ??= error;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(failure); }
    pending.clear();
  };
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.once("close", (code, signal) => { closed = true; fail(new Error(`Upstream RPC exited: code=${code}, signal=${signal}`)); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    const call = pending.get(value.id);
    if (call) { pending.delete(value.id); clearTimeout(call.timer); value.error ? call.reject(new Error(JSON.stringify(value.error))) : call.resolve(value.result); }
  });
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      if (failure || closed) return reject(failure ?? new Error("Upstream RPC is closed."));
      const id = ++count;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Upstream RPC ${method} timed out: ${stderr.slice(-1500)}`)); }, 20_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    }),
    notify: (method, params) => {
      if (failure || closed) throw failure ?? new Error("Upstream RPC is closed.");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close: async () => {
      if (!closed && child.exitCode === null && child.signalCode === null) child.stdin.end();
      await stopOwned(child);
    }
  };
}

const codexConfig = () => ["-c", 'model_provider="fixture"', "-c", 'model_providers.fixture.name="synthetic-local"',
  "-c", `model_providers.fixture.base_url="${base}"`, "-c", 'model_providers.fixture.wire_api="responses"',
  "-c", "model_providers.fixture.requires_openai_auth=false", "-c", "model_providers.fixture.supports_websockets=false",
  "-c", "model_providers.fixture.request_max_retries=0", "-c", "model_providers.fixture.stream_max_retries=0",
  "-c", "analytics.enabled=false"];

async function codexRead(binary, home, id) {
  const client = rpc(binary, ["app-server", "--stdio", ...codexConfig()], home);
  try {
    await client.request("initialize", { clientInfo: { name: "ai_cli_cleaner_acceptance", version: "1.0.0" } });
    client.notify("initialized", {});
    return await client.request("thread/read", { threadId: id, includeTurns: true });
  } finally { await client.close(); }
}

async function missingCodexRead(binary, home, id) {
  await assert.rejects(codexRead(binary, home, id), (error) => {
    const reply = JSON.parse(error.message);
    assert.equal(reply.code, -32600);
    assert.equal(reply.message, `thread not loaded: ${id}`);
    return true;
  });
}

async function restore(home, moved, operationId, provider, selectedId) {
  assert(!cancelled, "Verification was cancelled.");
  const recovery = moved.filter((item) => item.source.includes(`${path.sep}.ai-cli-cleaner${path.sep}recovery${path.sep}`));
  assert(recovery.length > 0, "Selected deletion must create a verifiable metadata recovery backup.");
  for (const item of recovery) await fs.rename(item.destination, item.source);
  const inspection = await inspectOperation(operationId, home);
  assert(inspection.operation.target.includes(provider));
  assert.equal(inspection.backups.length, recovery.length);
  assert(inspection.backups.every((item) => item.status === "verified"), "Recovery backups must pass the official inspector.");
  const archived = path.join(home, "after-delete");
  await fs.mkdir(archived, { recursive: true });
  let number = 0;
  for (const backup of inspection.backups) {
    const manifest = JSON.parse(await fs.readFile(backup.manifestPath, "utf8"));
    assert.equal(manifest.providerId, provider);
    assert(manifest.conversationIds.includes(selectedId));
    for (const entry of backup.files) {
      assert(inside(home, entry.originalPath) && inside(home, entry.backupPath));
      assert.equal(hash(await fs.readFile(entry.backupPath)), entry.sha256);
      for (const file of [entry.originalPath, `${entry.originalPath}-wal`, `${entry.originalPath}-shm`, `${entry.originalPath}-journal`]) {
        try { await fs.rename(file, path.join(archived, String(number++))); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await fs.copyFile(entry.backupPath, entry.originalPath);
      await fs.chmod(entry.originalPath, 0o600);
    }
  }
  for (const item of moved.filter((item) => !recovery.includes(item))) {
    await fs.mkdir(path.dirname(item.source), { recursive: true });
    await fs.rename(item.destination, item.source);
  }
}

async function verifyCodex() {
  const home = path.join(root, "codex");
  await fs.mkdir(path.join(home, "workspace"), { recursive: true });
  await fs.mkdir(path.join(home, ".codex"));
  const binary = await resolveBinary("codex");
  const version = await run(binary, ["--version"], home);
  assert.equal(version.code, 0);
  const evidence = { provider: "codex", version: version.stdout.trim(), binarySha256: hash(await fs.readFile(await fs.realpath(binary))), stages: [] };
  report.cases.push(evidence);
  const ids = [];
  for (const label of ["SELECTED", "RETAINED"]) {
    const generated = await run(binary, ["exec", "--skip-git-repo-check", "--json", "-s", "read-only", "-m", "gpt-5.3-codex", ...codexConfig(),
      `Synthetic cleaner acceptance ${label}. Reply only with the synthetic response; do not call tools.`], home);
    assert.equal(generated.code, 0, generated.stderr);
    assert(generated.stdout.includes(responseText), "The real CLI must receive the local mock response.");
    const started = generated.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.type === "thread.started");
    assert(started?.thread_id);
    ids.push(started.thread_id);
  }
  evidence.stages.push({ name: "real-cli-created-two-conversations", passed: true });
  console.error(`Codex ${evidence.version} created two synthetic conversations in the isolated data root.`);
  const discovered = await discoverConversations(["codex"], { home });
  assert.equal(discovered.warnings.length, 0, discovered.warnings.join("\n"));
  const selected = discovered.conversations.find((item) => item.id === ids[0]);
  assert(selected && !selected.disabledReason, selected?.disabledReason ?? "Cleaner could not discover upstream conversations.");
  assert(discovered.conversations.some((item) => item.id === ids[1]));
  for (const id of ids) assert(JSON.stringify(await codexRead(binary, home, id)).includes(responseText));
  const moved = [];
  const trash = wrapOperationTrash(async (files) => {
    for (const source of files) {
      assert(inside(home, source), "Trash sources must stay inside this run's data root.");
      const destination = path.join(home, "sink", `${moved.length}-${path.basename(source)}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(source, destination);
      moved.push({ source, destination });
    }
  });
  const deleted = await withOperation({ home, kind: "conversations", target: ["codex"] }, () =>
    deleteConversations([selected], { home, trash, checkOpenPaths: findOpenPaths }));
  assert.equal(deleted.failures.length, 0, deleted.failures.map((failure) => failure.error.message).join("\n"));
  await missingCodexRead(binary, home, ids[0]);
  assert(JSON.stringify(await codexRead(binary, home, ids[1])).includes(responseText));
  evidence.stages.push({ name: "selected-delete-upstream-readback-retained", passed: true });
  const operation = (await listOperations(home))[0];
  await restore(home, moved, operation.id, "codex", ids[0]);
  assert(JSON.stringify(await codexRead(binary, home, ids[0])).includes(responseText));
  assert(JSON.stringify(await codexRead(binary, home, ids[1])).includes(responseText));
  evidence.stages.push({ name: "inspected-backup-manual-fixture-restore-upstream-readback", passed: true });
  const bulk = await withOperation({ home, kind: "clean", target: ["codex"] }, async () =>
    (await prepareClean(["codex"], { home, trash, checkOpenPaths: findOpenPaths })).execute());
  assert.equal(bulk.failures.length, 0, bulk.failures.map((failure) => failure.message).join("\n"));
  await missingCodexRead(binary, home, ids[0]);
  await missingCodexRead(binary, home, ids[1]);
  evidence.stages.push({ name: "bulk-delete-upstream-readback-absent", passed: true });
}

async function openCodeServer(binary, home) {
  assert(!cancelled, "Verification was cancelled.");
  const config = { model: "openai/gpt-4o-mini", provider: { openai: { options: { baseURL: base, apiKey: "synthetic" } } },
    permission: { "*": "deny" } };
  const env = { ...environment(home), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
  const child = spawnOwned(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--pure"], {
    cwd: path.join(home, "workspace"), env, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let url;
  try { url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenCode server startup timed out: ${output.slice(-2000)}`)), 30_000);
    const update = (chunk) => {
      output += chunk;
      const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    child.stdout.on("data", update);
    child.stderr.on("data", update);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error(`OpenCode server exited before becoming ready: ${output.slice(-2000)}`)); });
  }); } catch (error) { await stopOwned(child); throw error; }
  return {
    request: async (route, data) => {
      const response = await fetch(`${url}${route}`, { method: data ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "x-opencode-directory": path.join(home, "workspace") },
        body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
      return response.json();
    },
    close: async () => {
      await stopOwned(child);
    }
  };
}

async function openCodeRead(binary, home, id) {
  const client = await openCodeServer(binary, home);
  try { return await client.request(`/session/${id}/message`); }
  finally { await client.close(); }
}

async function missingOpenCodeRead(binary, home, id) {
  await assert.rejects(openCodeRead(binary, home, id), (error) => {
    assert(error.message.startsWith("OpenCode HTTP 404: "));
    const reply = JSON.parse(error.message.slice("OpenCode HTTP 404: ".length));
    assert.equal(reply.name, "NotFoundError");
    assert.equal(reply.data.message, `Session not found: ${id}`);
    return true;
  });
}

async function verifyOpenCode() {
  const home = path.join(root, "opencode");
  await fs.mkdir(path.join(home, "workspace"), { recursive: true });
  const binary = args.find((arg) => arg.startsWith("--opencode-bin="))?.slice("--opencode-bin=".length) ?? "/usr/local/bin/opencode";
  assert(path.isAbsolute(binary), "OpenCode binary path must be absolute.");
  const version = await run(binary, ["--version"], home);
  assert.equal(version.code, 0, version.stderr);
  const evidence = { provider: "opencode", version: version.stdout.trim(), binarySha256: hash(await fs.readFile(binary)),
    generation: "real-cli-http-api-noReply-synthetic-message", cloudModelVerified: false, stages: [] };
  report.cases.push(evidence);
  const client = await openCodeServer(binary, home);
  const ids = [];
  try {
    for (const label of ["SELECTED", "RETAINED"]) {
      const session = await client.request("/session", { title: `Synthetic ${label}` });
      ids.push(session.id);
      await client.request(`/session/${session.id}/message`, { noReply: true,
        parts: [{ type: "text", text: `UPSTREAM_SYNTHETIC_${label}` }] });
      assert(JSON.stringify(await client.request(`/session/${session.id}/message`)).includes(`UPSTREAM_SYNTHETIC_${label}`));
    }
  } finally { await client.close(); }
  evidence.stages.push({ name: "real-server-created-two-conversations-with-messages", passed: true });
  console.error(`OpenCode ${evidence.version} created two conversations and messages in the isolated data root.`);
  const discovered = await discoverConversations(["opencode"], { home });
  assert.equal(discovered.warnings.length, 0, discovered.warnings.join("\n"));
  const selected = discovered.conversations.find((item) => item.id === ids[0]);
  assert(selected && !selected.disabledReason, selected?.disabledReason ?? "Cleaner could not discover upstream conversations.");
  const moved = [];
  const trash = wrapOperationTrash(async (files) => {
    for (const source of files) {
      assert(inside(home, source));
      const destination = path.join(home, "sink", `${moved.length}-${path.basename(source)}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(source, destination);
      moved.push({ source, destination });
    }
  });
  const deleted = await withOperation({ home, kind: "conversations", target: ["opencode"] }, () =>
    deleteConversations([selected], { home, trash, checkOpenPaths: findOpenPaths }));
  assert.equal(deleted.failures.length, 0, deleted.failures.map((failure) => failure.error.message).join("\n"));
  await missingOpenCodeRead(binary, home, ids[0]);
  assert(JSON.stringify(await openCodeRead(binary, home, ids[1])).includes("UPSTREAM_SYNTHETIC_RETAINED"));
  const listed = await openCodeServer(binary, home);
  try {
    const sessions = await listed.request("/session");
    assert(!sessions.some((item) => item.id === ids[0]));
    assert(sessions.some((item) => item.id === ids[1]));
  } finally { await listed.close(); }
  evidence.stages.push({ name: "selected-delete-upstream-readback-retained", passed: true });
  const operation = (await listOperations(home))[0];
  await restore(home, moved, operation.id, "opencode", ids[0]);
  assert(JSON.stringify(await openCodeRead(binary, home, ids[0])).includes("UPSTREAM_SYNTHETIC_SELECTED"));
  assert(JSON.stringify(await openCodeRead(binary, home, ids[1])).includes("UPSTREAM_SYNTHETIC_RETAINED"));
  evidence.stages.push({ name: "inspected-backup-manual-fixture-restore-upstream-readback", passed: true });
  const bulk = await withOperation({ home, kind: "clean", target: ["opencode"] }, async () =>
    (await prepareClean(["opencode"], { home, trash, checkOpenPaths: findOpenPaths })).execute());
  assert.equal(bulk.failures.length, 0, bulk.failures.map((failure) => failure.message).join("\n"));
  const reader = await openCodeServer(binary, home);
  try { assert.deepEqual(await reader.request("/session"), []); }
  finally { await reader.close(); }
  evidence.stages.push({ name: "bulk-delete-upstream-list-empty", passed: true });
}

function fixtureTrash(home) {
  const moved = [];
  return { moved, trash: wrapOperationTrash(async (files) => {
    for (const source of files) {
      assert(inside(home, source), "Move sources must stay inside the newly created data root.");
      const destination = path.join(home, "sink", `${moved.length}-${path.basename(source)}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(source, destination);
      moved.push({ source, destination });
    }
  }) };
}

async function verifyAntigravity() {
  const home = path.join(root, "antigravity");
  await fs.mkdir(path.join(home, "workspace"), { recursive: true, mode: 0o700 });
  const binary = await resolveBinary("agy");
  const bytes = await fs.readFile(binary);
  assert.equal(hash(bytes), "cf09a8a34554d3c6d4d950362596acbdef8cd98af8c75b3d4a6def50c1a560a7",
    "Antigravity verification is pinned to binary 1.3.5; re-verify authentication isolation before testing a different binary.");
  // 舊版本若不認得隔離 API 模式，必須在啟動前停止，避免回落至共用 keyring。
  for (const literal of ["modelProvider", "GOOGLE_GEMINI_BASE_URL", "GEMINI_API_KEY"]) {
    assert(bytes.includes(Buffer.from(literal)), `This agy binary does not contain the isolation setting ${literal}.`);
  }
  const profile = path.join(home, ".gemini", "antigravity-cli");
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(profile, "settings.json"), JSON.stringify({ modelProvider: "gemini" }), { mode: 0o600, flag: "wx" });
  const endpoint = new URL(base).origin;
  const extra = { GEMINI_API_KEY: "synthetic-no-credential", GOOGLE_GEMINI_BASE_URL: endpoint,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true", HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint,
    NO_PROXY: "127.0.0.1,localhost" };
  const cli = (parameters) => run(binary, parameters, home, 30_000, extra);
  const version = await cli(["--version"]);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), "1.3.5", "Unknown Antigravity version; re-verify the isolation settings.");
  const evidence = { provider: "antigravity", version: version.stdout.trim(), binarySha256: hash(bytes),
    authentication: "isolated-gemini-provider-with-synthetic-placeholder-key", cloudModelVerified: false, stages: [] };
  report.cases.push(evidence);
  const prompt = (marker) => ["--print", `Synthetic cleaner acceptance ${marker}. Reply only with the synthetic response; do not use tools.`,
    "--output-format", "json", "--model", "gemini-3.8-flash-low", "--print-timeout", "20s"];
  const parse = (result) => {
    assert.equal(result.code, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.status, "SUCCESS");
    assert.equal(value.response.trim(), responseText);
    assert(value.conversation_id);
    return value;
  };
  const ids = [];
  for (const marker of ["UPSTREAM_SYNTHETIC_SELECTED", "UPSTREAM_SYNTHETIC_RETAINED"]) {
    const before = requests.length;
    ids.push(parse(await cli(prompt(marker))).conversation_id);
    assert(requests.slice(before).some((item) => item.path.includes("/gemini-3.8-flash:streamGenerateContent")), "The CLI must call the local model.");
  }
  evidence.stages.push({ name: "real-cli-created-two-conversations", passed: true });
  const discovered = await discoverConversations(["antigravity"], { home });
  const selected = discovered.conversations.find((item) => item.id === ids[0]);
  assert.match(selected?.disabledReason ?? "", /shared protobuf indexes/i, "Unsupported shared protobuf formats must disable selective deletion.");
  assert(discovered.conversations.some((item) => item.id === ids[1]));
  const summaryProto = path.join(profile, "jetbox_summaries_proto.pb");
  const originalProto = await fs.readFile(summaryProto);
  assert(originalProto.includes(Buffer.from(ids[0])) && originalProto.includes(Buffer.from(ids[1])));
  assert(originalProto.includes(Buffer.from(responseText)), "The real shared index must contain a synthetic title copy.");
  const read = async (id, marker, absent = false) => {
    const before = requests.length;
    const result = await cli(["--conversation", id, ...prompt("UPSTREAM_SYNTHETIC_READBACK")]);
    const value = parse(result);
    const calls = requests.slice(before).filter((item) => item.path.includes("/gemini-3.8-flash:streamGenerateContent"));
    assert(calls.length > 0);
    const field = marker === "SELECTED" ? "selectedContext" : "retainedContext";
    if (absent) {
      // 上游會為不存在的 ID 建立新對話，不能只用 exit0 判定舊資料仍在。
      assert.notEqual(value.conversation_id, id);
      assert.equal(value.num_turns, 1);
      assert(result.stderr.includes(`warning: conversation "${id}" not found`));
      assert(calls.every((item) => item[field] === false), "Deleted content must not be sent to a new conversation.");
    } else {
      assert.equal(value.conversation_id, id);
      assert(value.num_turns >= 2);
      assert(calls.some((item) => item[field] === true), "Resume must read back the original synthetic content.");
    }
  };
  const { moved, trash } = fixtureTrash(home);
  // 即使呼叫端移除 UI 停用狀態，execution guard 仍須在任何搬移前拒絕。
  const rejected = await deleteConversations([{ ...selected, disabledReason: undefined }], { home, trash, checkOpenPaths: findOpenPaths });
  assert.equal(rejected.failures.length, 1);
  assert.match(rejected.failures[0].error.message, /shared protobuf indexes/i);
  assert.deepEqual(moved, []);
  assert.deepEqual(await fs.readFile(summaryProto), originalProto);
  await read(ids[0], "SELECTED");
  await read(ids[1], "RETAINED");
  evidence.stages.push({ name: "unsupported-selected-format-refused-before-trash-both-contexts-retained", passed: true });
  const preserved = ["settings.json", "installation_id"];
  const preservedHashes = new Map();
  for (const name of preserved) preservedHashes.set(name, hash(await fs.readFile(path.join(profile, name))));
  const hashes = new Map();
  const snapshot = async (directory) => {
    if ((await fs.lstat(directory)).isFile()) {
      hashes.set(directory, hash(await fs.readFile(directory)));
      return;
    }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert(inside(home, file));
      if (entry.isDirectory()) await snapshot(file);
      else if (entry.isFile()) hashes.set(file, hash(await fs.readFile(file)));
      else assert.fail("Owned fixtures must not contain symlinks or special files.");
    }
  };
  const bulk = await withOperation({ home, kind: "clean", target: ["antigravity"] }, async () => {
    const plan = await prepareClean(["antigravity"], { home, trash, checkOpenPaths: findOpenPaths });
    for (const entry of plan.entries) await snapshot(entry.path);
    return plan.execute();
  });
  assert.equal(bulk.failures.length, 0, bulk.failures.map((failure) => failure.message).join("\n"));
  assert(moved.some((item) => item.source === summaryProto));
  assert(moved.some((item) => item.source === path.join(profile, "annotations")));
  await assert.rejects(fs.lstat(summaryProto), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(profile, "annotations")), { code: "ENOENT" });
  for (const [name, digest] of preservedHashes) assert.equal(hash(await fs.readFile(path.join(profile, name))), digest);
  const inspection = await inspectOperation((await listOperations(home))[0].id, home);
  assert.equal(inspection.operation.kind, "clean");
  assert.equal(inspection.operation.status, "succeeded");
  assert.deepEqual(inspection.operation.movedPaths.sort(), moved.map((item) => item.source).sort());
  assert.deepEqual(inspection.backups, [], "A whole-batch move must not be reported as metadata recovery backups.");
  await read(ids[0], "SELECTED", true);
  await read(ids[1], "RETAINED", true);
  evidence.stages.push({ name: "bulk-trash-complete-known-copies-journal-verified-old-context-absent", passed: true });
  const archived = path.join(home, "after-bulk");
  await fs.mkdir(archived);
  for (const [index, item] of moved.entries()) {
    assert(inside(home, item.source) && inside(home, item.destination));
    try { await fs.rename(item.source, path.join(archived, String(index))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.rename(item.destination, item.source);
  }
  for (const [file, digest] of hashes) {
    if (moved.some((item) => item.source === file || inside(item.source, file))) {
      assert.equal(hash(await fs.readFile(file)), digest, "Manual restoration must preserve all original bytes.");
    }
  }
  await read(ids[0], "SELECTED");
  await read(ids[1], "RETAINED");
  evidence.stages.push({ name: "journal-inspected-whole-file-trash-manual-restore-original-contexts", passed: true });
  evidence.selectedDeletionSupported = false;
  evidence.selectedDeletionLimitation = "nonempty shared jetbox protobuf index has no verified selective schema";

}

async function verifyCopilot() {
  const home = path.join(root, "copilot");
  await fs.mkdir(path.join(home, "workspace"), { recursive: true });
  const binary = await resolveBinary("copilot");
  const extra = { COPILOT_HOME: path.join(home, ".copilot"), COPILOT_CACHE_HOME: path.join(home, ".cache", "copilot"),
    COPILOT_OFFLINE: "true", COPILOT_PROVIDER_BASE_URL: base, COPILOT_PROVIDER_TYPE: "openai",
    COPILOT_PROVIDER_WIRE_API: "completions", COPILOT_MODEL: "gpt-4o" };
  const cli = (parameters) => run(binary, ["--no-auto-update", "--no-custom-instructions", "--disable-builtin-mcps", "--no-remote-export",
    "--log-level", "none", ...parameters], home, 45_000, extra);
  const version = await cli(["--version"]);
  assert.equal(version.code, 0, version.stderr);
  const evidence = { provider: "copilot", version: version.stdout.split("\n")[0], binarySha256: hash(await fs.readFile(await fs.realpath(binary))), stages: [] };
  report.cases.push(evidence);
  const ids = [randomUUID(), randomUUID()];
  const prompt = ["-p", "Synthetic cleaner acceptance. Do not use tools. Reply with the synthetic fixture response.", "--allow-all-tools"];
  for (const id of ids) {
    const created = await cli(["--session-id", id, ...prompt]);
    assert.equal(created.code, 0, created.stderr);
    assert(created.stdout.includes(responseText));
  }
  evidence.stages.push({ name: "real-cli-created-two-conversations", passed: true });
  console.error(`Copilot ${evidence.version} created two conversations in isolated BYOK/offline mode.`);
  const discovery = await discoverConversations(["copilot"], { home });
  assert.equal(discovery.warnings.length, 0, discovery.warnings.join("\n"));
  assert.equal(discovery.conversations.length, 2, "The shared operation-lock directory must not be discovered as a conversation.");
  const selected = discovery.conversations.find((item) => item.id === ids[0]);
  assert(selected && !selected.disabledReason);
  const { moved, trash } = fixtureTrash(home);
  const deleted = await withOperation({ home, kind: "conversations", target: ["copilot"] }, () =>
    deleteConversations([selected], { home, trash, checkOpenPaths: findOpenPaths }));
  assert.equal(deleted.failures.length, 0, deleted.failures.map((failure) => failure.error.message).join("\n"));
  const missing = await cli(["--resume", ids[0], ...prompt]);
  assert.equal(missing.code, 1, "The upstream CLI must refuse to resume a deleted conversation.");
  assert.match(missing.stdout + missing.stderr, /No session, task, or name matched|No session found/i);
  assert.deepEqual((await discoverConversations(["copilot"], { home })).conversations.map((item) => item.id), [ids[1]]);
  evidence.stages.push({ name: "selected-delete-upstream-resume-rejected-retained-inventory", passed: true });
  // Copilot resume 會新增 turn，因此必須在整份備份復原後才做正向重開。
  await restore(home, moved, (await listOperations(home))[0].id, "copilot", ids[0]);
  for (const id of ids) {
    const reopened = await cli(["--resume", id, ...prompt]);
    assert.equal(reopened.code, 0, reopened.stderr);
    assert(reopened.stdout.includes(responseText));
  }
  evidence.stages.push({ name: "inspected-backup-manual-fixture-restore-upstream-resume", passed: true });
  const bulk = await withOperation({ home, kind: "clean", target: ["copilot"] }, async () =>
    (await prepareClean(["copilot"], { home, trash, checkOpenPaths: findOpenPaths })).execute());
  assert.equal(bulk.failures.length, 0, bulk.failures.map((failure) => failure.message).join("\n"));
  for (const id of ids) {
    const absent = await cli(["--resume", id, ...prompt]);
    assert.equal(absent.code, 1);
    assert.match(absent.stdout + absent.stderr, /No session, task, or name matched|No session found/i);
  }
  evidence.stages.push({ name: "bulk-delete-upstream-resume-rejected", passed: true });
}

async function verifyGrok() {
  const home = path.join(root, "grok");
  await fs.mkdir(path.join(home, "workspace"), { recursive: true });
  await fs.mkdir(path.join(home, ".grok"));
  await fs.writeFile(path.join(home, ".grok", "config.toml"), `[cli]\nauto_update=false\nuse_leader=false\n[features]\ntelemetry=false\n[models]\ndefault="fixture"\n[model.fixture]\nmodel="fixture"\nbase_url="${base}"\nname="Synthetic fixture"\napi_backend="chat_completions"\ncontext_window=8192\nmax_completion_tokens=128\napi_key="synthetic"\n`, { mode: 0o600 });
  const binary = await resolveBinary("grok");
  const extra = { GROK_HOME: path.join(home, ".grok"), GROK_DISABLE_AUTOUPDATER: "1", GROK_MODELS_BASE_URL: base,
    XAI_API_KEY: "synthetic", GROK_MEMORY: "0", GROK_AGENT_DASHBOARD: "0" };
  const cli = (parameters) => run(binary, ["--no-auto-update", "--leader-socket", path.join(home, "fixture.sock"), ...parameters], home, 45_000, extra);
  const version = await cli(["--version"]);
  assert.equal(version.code, 0, version.stderr);
  const evidence = { provider: "grok", version: version.stdout.trim(), binarySha256: hash(await fs.readFile(await fs.realpath(binary))), stages: [] };
  report.cases.push(evidence);
  const ids = [randomUUID(), randomUUID()];
  const prompt = ["-p", "Synthetic cleaner acceptance. Do not use any tools. Reply with the synthetic response.", "-m", "fixture",
    "--tools", "", "--disable-web-search", "--no-subagents", "--output-format", "json"];
  for (const id of ids) {
    const created = await cli(["--session-id", id, ...prompt]);
    assert.equal(created.code, 0, created.stderr);
    assert(created.stdout.includes(responseText));
  }
  evidence.stages.push({ name: "real-cli-created-two-conversations", passed: true });
  console.error(`Grok ${evidence.version} created two conversations in a new GROK_HOME with an isolated socket.`);
  const discovery = await discoverConversations(["grok"], { home });
  assert.equal(discovery.warnings.length, 0, discovery.warnings.join("\n"));
  assert.equal(discovery.conversations.length, 2);
  const selected = discovery.conversations.find((item) => item.id === ids[0]);
  assert(selected && !selected.disabledReason);
  const { moved, trash } = fixtureTrash(home);
  const deleted = await withOperation({ home, kind: "conversations", target: ["grok"] }, () =>
    deleteConversations([selected], { home, trash, checkOpenPaths: findOpenPaths }));
  assert.equal(deleted.failures.length, 0, deleted.failures.map((failure) => failure.error.message).join("\n"));
  const missing = await cli(["export", ids[0]]);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout + missing.stderr, /not found|does not exist|no session/i);
  const retained = await cli(["export", ids[1]]);
  assert.equal(retained.code, 0, retained.stderr);
  assert(retained.stdout.includes(responseText));
  evidence.stages.push({ name: "selected-delete-upstream-export-retained", passed: true });
  await restore(home, moved, (await listOperations(home))[0].id, "grok", ids[0]);
  for (const id of ids) {
    const restored = await cli(["export", id]);
    assert.equal(restored.code, 0, restored.stderr);
    assert(restored.stdout.includes(responseText));
  }
  evidence.stages.push({ name: "inspected-backup-manual-fixture-restore-upstream-export", passed: true });
  const bulk = await withOperation({ home, kind: "clean", target: ["grok"] }, async () =>
    (await prepareClean(["grok"], { home, trash, checkOpenPaths: findOpenPaths })).execute());
  assert.equal(bulk.failures.length, 0, bulk.failures.map((failure) => failure.message).join("\n"));
  for (const id of ids) {
    const absent = await cli(["export", id]);
    assert.equal(absent.code, 1);
    assert.match(absent.stdout + absent.stderr, /not found|does not exist|no session/i);
  }
  evidence.stages.push({ name: "bulk-delete-upstream-export-absent", passed: true });
}

try {
  const temporary = await fs.realpath(tmpdir());
  root = await fs.mkdtemp(path.join(temporary, "ai-cleaner-upstream-"));
  identity = await fs.lstat(root);
  report.ownedRoot = root;
  console.error(`Upstream verification fixture root: ${root}`);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}/v1`;
  for (const target of targets) {
    assert(!cancelled, "Verification was cancelled.");
    if (target === "codex") await verifyCodex();
    else if (target === "copilot") await verifyCopilot();
    else if (target === "grok") await verifyGrok();
    else if (target === "opencode") await verifyOpenCode();
    else if (target === "antigravity") await verifyAntigravity();
  }
} catch (error) {
  report.error = error.message.replaceAll(root ?? "$UNCREATED", "$FIXTURE");
  process.exitCode = 1;
  // 只輸出合成資料庫的結構，保留相容性失敗證據而不另寫報告檔。
  for (const database of root ? [path.join(root, "codex", ".codex", "state_5.sqlite"),
    path.join(root, "opencode", ".local", "share", "opencode", "opencode.db")] : []) {
    try {
      const db = new DatabaseSync(database, { readOnly: true });
      try { (report.schemas ??= []).push({ database: path.relative(root, database),
        tables: db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'").all() }); }
      finally { db.close(); }
    } catch {}
  }
} finally {
  const stopped = await Promise.allSettled([...children.keys()].map(stopOwned));
  const failures = stopped.filter((item) => item.status === "rejected");
  if (failures.length) {
    report.processCleanupErrors = failures.map((item) => item.reason.message);
    process.exitCode = 1;
  }
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  report.mockRequests = requests;
  try {
    if (root) {
      assert.equal(failures.length, 0, "Could not confirm that owned processes have exited; preserving the synthetic fixture root for recovery.");
      const current = await fs.lstat(root);
      assert(identity && current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino);
      await moveToSystemTrash([root], new Map([[root, snapshotClaimIdentity(root)]]));
      await assert.rejects(fs.lstat(root), { code: "ENOENT" });
      report.fixtureMovedToSystemTrash = true;
    }
  }
  catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  console.log(JSON.stringify(report, null, 2));
}
