import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { moveToSystemTrash } from "../dist/fs/trash.js";
import { snapshotClaimIdentity } from "../dist/fs/claims.js";

if (process.argv.length !== 3 || process.argv[2] !== "--run") {
  console.error("Run node tests/verify-trash.mjs --run. The test moves only files it creates, verifies their file identity, restores them, then moves its fixture directory to the system Trash.");
  process.exit(2);
}
assert.equal(process.platform, "darwin", "This verification supports macOS only.");
const trashRoot = path.join(homedir(), ".Trash");
// 先確認能定位與復原測試檔，避免搬移後才發現垃圾桶不可讀。
assert.equal((await fs.lstat(trashRoot)).isSymbolicLink(), false);
await fs.readdir(trashRoot);
const root = await fs.mkdtemp(path.join(tmpdir(), "ai-cleaner-trash-check-"));
const rootStat = await fs.lstat(root);
const canonicalRoot = await fs.realpath(root);
const token = `ai-cleaner-check-${randomUUID()}`;
const tracked = [];
const report = { platform: process.platform, arch: process.arch, node: process.version, cases: [] };
const errors = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let interrupted = false;
const stop = () => { interrupted = true; };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function move(paths) {
  assert(!interrupted, "Verification was interrupted.");
  await moveToSystemTrash(paths, new Map(paths.map((file) => [file, snapshotClaimIdentity(file)])));
  assert(!interrupted, "Verification was interrupted.");
}

async function track(file) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink());
  tracked.push({ file, dev: stat.dev, ino: stat.ino, hash: digest(await fs.readFile(file)) });
}

async function locate(item) {
  for (const name of (await fs.readdir(trashRoot)).filter((name) => name.includes(token))) {
    const candidate = path.join(trashRoot, name);
    const stat = await fs.lstat(candidate);
    if (stat.dev === item.dev && stat.ino === item.ino && stat.isFile() && !stat.isSymbolicLink()) {
      assert.equal(digest(await fs.readFile(candidate)), item.hash, "Test file contents changed after being moved.");
      return candidate;
    }
  }
}

async function restore(items) {
  for (const item of items) {
    const from = await locate(item);
    assert(from, `Could not find this test's file: ${path.basename(item.file)}`);
    assert.equal(await fs.lstat(item.file).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }), false, "Restore destination must be empty.");
    await fs.rename(from, item.file);
    assert.equal(digest(await fs.readFile(item.file)), item.hash);
  }
}

try {
  assert.equal((await fs.stat(root)).dev, (await fs.stat(trashRoot)).dev,
    "Automatic verification currently supports same-volume moves only; cross-volume behavior requires separate testing.");
  const file = path.join(root, `${token}-中文 [literal]*.jsonl`);
  await fs.writeFile(file, "synthetic fixture\n", { mode: 0o600 });
  await track(file);
  await move([file]);
  await restore(tracked.slice(-1));
  report.cases.push({ name: "literal-path-roundtrip", passed: true });

  const duplicates = [];
  for (const name of ["a", "b"]) {
    const parent = path.join(root, name);
    await fs.mkdir(parent);
    const duplicate = path.join(parent, `${token}-same-name.txt`);
    await fs.writeFile(duplicate, `fixture ${name}`);
    await track(duplicate);
    duplicates.push(duplicate);
  }
  await move(duplicates);
  await restore(tracked.slice(-2));
  report.cases.push({ name: "duplicate-basename-roundtrip", passed: true });

  const databasePath = path.join(root, `${token}-state.sqlite`);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture (id INTEGER); INSERT INTO fixture VALUES (1); INSERT INTO fixture VALUES (2)');
    process.kill(process.pid, 'SIGKILL');
  `, databasePath], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  const members = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  for (const member of members) await track(member);
  await move(members);
  await restore(tracked.slice(-3));
  const db = new DatabaseSync(databasePath);
  try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fixture").get().count, 2); }
  finally { db.close(); }
  report.cases.push({ name: "committed-wal-roundtrip", passed: true });

  const partial = path.join(root, `${token}-partial.txt`);
  await fs.writeFile(partial, "partial fixture");
  await track(partial);
  let failed = false;
  try { await move([partial, path.join(root, `${token}-missing.txt`)]); }
  catch { failed = true; }
  assert.equal(failed, true, "A missing member must cause the operation to fail.");
  const moved = Boolean(await locate(tracked.at(-1)));
  if (moved) await restore(tracked.slice(-1));
  else {
    const stat = await fs.lstat(partial);
    assert.equal(stat.dev, tracked.at(-1).dev);
    assert.equal(stat.ino, tracked.at(-1).ino);
    assert.equal(digest(await fs.readFile(partial)), tracked.at(-1).hash);
  }
  report.cases.push({ name: "missing-member-failure", passed: true, validMemberMoved: moved });
  assert(!interrupted, "Verification was interrupted.");
} catch (error) {
  errors.push(error);
} finally {
  // 保留已搬入但未復原的測試檔；只核對與回報，不永久移除垃圾桶內容。
  report.cleanup = { fixtureRoot: root, status: "pending", retainedFiles: [] };
  for (const item of tracked) {
    try {
      const remaining = await locate(item);
      if (remaining) report.cleanup.retainedFiles.push(remaining);
    } catch (error) { errors.push(error); }
  }
  try {
    const stat = await fs.lstat(root);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), "The fixture directory must be a real directory.");
    assert.equal(stat.dev, rootStat.dev, "The fixture directory's device changed.");
    assert.equal(stat.ino, rootStat.ino, "The fixture directory's identity changed.");
    assert.equal(await fs.realpath(root), canonicalRoot, "The fixture directory's path changed.");
    await moveToSystemTrash([root], new Map([[root, snapshotClaimIdentity(root)]]));
    assert.equal(await fs.lstat(root).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }), false, "The fixture directory still exists after the Trash operation.");
    const basename = path.basename(root);
    const candidates = (await fs.readdir(trashRoot))
      .filter((name) => name.startsWith(basename) || name.startsWith(`000-${basename}`));
    for (const name of candidates) {
      const target = path.join(trashRoot, name);
      const trashed = await fs.lstat(target);
      if (trashed.dev === rootStat.dev && trashed.ino === rootStat.ino &&
          trashed.isDirectory() && !trashed.isSymbolicLink()) {
        report.cleanup.trashPath = target;
        break;
      }
    }
    assert(report.cleanup.trashPath, "Could not verify this fixture directory in the system Trash.");
    report.cleanup.status = "trashed";
  } catch (error) {
    report.cleanup.status = "failed";
    errors.push(error);
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
report.passed = errors.length === 0;
if (errors.length) report.errors = errors.map((error) => error instanceof Error ? error.message : String(error));
console.log(JSON.stringify(report));
if (errors.length) throw new AggregateError(errors, `Trash verification or fixture move failed for run ${token}.`);
