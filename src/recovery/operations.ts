import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { TrashFn } from "../cleaners/clean.js";
import { containsPath, getCanonicalPath } from "../fs/paths.js";
import { isMissing, openPrivateFile, privateDirectory, readPrivateFile, trustedHome, writePrivateSnapshot } from "./storage.js";

export type OperationStatus = "incomplete" | "succeeded" | "failed" | "partial";
export type MetadataStage = "planned" | "preparing" | "backed-up" | "writing" | "written" | "possibly-partial" | "released";
export interface MetadataProgress {
  providerId: string;
  paths: string[];
  stage: MetadataStage;
  recoveryPath?: string;
  manifestSha256?: string;
}
export interface OperationRecord {
  formatVersion: 1;
  id: string;
  kind: "clean" | "conversations";
  target: string[];
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  status: OperationStatus;
  phase: string;
  plannedPaths: string[];
  movedPaths: string[];
  uncertainPaths: string[];
  remainingPaths: string[];
  metadata: MetadataProgress[];
  helperFailed: boolean;
  claims?: Array<{ directory: string; paths: string[]; home?: string }>;
}
export type OperationSummary = Pick<OperationRecord, "id" | "kind" | "target" | "startedAt" | "status">;
interface BackupInspection {
  recoveryPath: string;
  manifestPath: string;
  status: "verified" | "missing" | "incomplete";
  files: Array<{ originalPath: string; backupPath: string; kind: string; sha256: string }>;
}

export interface OperationInspection {
  operation: OperationRecord;
  backups: BackupInspection[];
  instructions: string[];
  claims: Array<{ directory: string; recordPath: string; status: "missing" | "pending" | "recorded"; state?: string; targets?: unknown[] }>;
}
interface OperationContext {
  home: string;
  file: string;
  record: OperationRecord;
  failure?: Error;
  halted?: Error;
  queue: Promise<void>;
}
const context = new AsyncLocalStorage<OperationContext>();
const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const providers = new Set(["codex", "copilot", "antigravity", "opencode", "grok"]);

export async function withOperation<T>(options: {
  home?: string;
  kind: "clean" | "conversations";
  target: string[];
}, execute: () => Promise<T>): Promise<T> {
  if (context.getStore()) throw new Error("Operation journals cannot be nested.");
  const home = path.resolve(options.home ?? homedir());
  await trustedHome(home);
  if (!options.target.length || options.target.some((target) => !providers.has(target))) throw new Error("Unsupported operation target.");
  const id = randomUUID();
  const directory = path.join(home, ".ai-cli-cleaner", "operations", id);
  await privateDirectory(home, directory, true);
  const now = new Date().toISOString();
  const record: OperationRecord = { formatVersion: 1, id, kind: options.kind, target: [...new Set(options.target)],
    startedAt: now, updatedAt: now, status: "incomplete", phase: "started", plannedPaths: [], movedPaths: [],
    uncertainPaths: [], remainingPaths: [], metadata: [], helperFailed: false };
  const operation: OperationContext = { home, file: path.join(directory, "operation.json"), record, queue: Promise.resolve() };
  await persist(operation);
  return context.run(operation, async () => {
    try {
      const result = await execute();
      assertHealthy(operation);
      const hasFailures = typeof result === "object" && result !== null && "failures" in result &&
        Array.isArray(result.failures) && result.failures.length > 0;
      const partial = record.movedPaths.length > 0 || record.metadata.some((item) => ["writing", "written", "possibly-partial", "released"].includes(item.stage));
      const failed = hasFailures || Boolean(operation.halted) || record.helperFailed || record.uncertainPaths.length > 0 || record.remainingPaths.length > 0 ||
        record.metadata.some((item) => ["writing", "possibly-partial", "preparing"].includes(item.stage));
      record.status = failed ? partial ? "partial" : "failed" : "succeeded";
      record.phase = "ended";
      record.endedAt = new Date().toISOString();
      await persist(operation);
      return result;
    } catch (error) {
      if (!operation.failure) {
        record.status = record.movedPaths.length || record.uncertainPaths.length ||
          record.metadata.some((item) => ["writing", "written", "possibly-partial", "released"].includes(item.stage)) ? "partial" : "failed";
        record.phase = "ended";
        record.endedAt = new Date().toISOString();
        await persist(operation);
      }
      throw operation.failure ?? error;
    }
  });
}

// 日誌一旦無法持久保存，本次 context 的後續搬移與 metadata 更新全部停止。
function assertHealthy(operation: OperationContext): void {
  if (operation.failure) throw operation.failure;
}
function assertMutationAllowed(operation: OperationContext): void {
  assertHealthy(operation);
  if (operation.halted) throw operation.halted;
}
async function persist(operation: OperationContext): Promise<void> {
  assertHealthy(operation);
  const next = operation.queue.then(async () => {
    assertHealthy(operation);
    operation.record.updatedAt = new Date().toISOString();
    try { await writePrivateSnapshot(operation.home, operation.file, operation.record); }
    catch (error) {
      operation.failure = new Error("The operation journal could not be saved safely; further changes stopped.", { cause: error });
      throw operation.failure;
    }
  });
  operation.queue = next.catch(() => undefined);
  await next;
}

export function wrapOperationTrash(trash: TrashFn): TrashFn {
  return async (paths, expected) => {
    const operation = context.getStore();
    if (!operation) return trash(paths, expected);
    assertMutationAllowed(operation);
    const selected = [...new Set(paths)];
    for (const file of selected) {
      await assertHomePath(operation.home, file);
      await fs.lstat(file);
    }
    operation.record.plannedPaths = [...new Set([...operation.record.plannedPaths, ...selected])];
    operation.record.uncertainPaths = [...new Set([...operation.record.uncertainPaths, ...selected])];
    operation.record.phase = "trash-intent";
    await persist(operation);
    let failure: unknown;
    try { await trash(selected, expected); } catch (error) { failure = error; }
    const moved: string[] = [];
    const remaining: string[] = [];
    const uncertain: string[] = [];
    for (const file of selected) {
      try {
        await assertHomePath(operation.home, file);
        await fs.lstat(file);
        remaining.push(file);
      } catch (error) {
        if (isMissing(error)) moved.push(file);
        else uncertain.push(file);
      }
    }
    if (failure) uncertain.push(...moved);
    operation.record.movedPaths = [...new Set([...operation.record.movedPaths, ...moved])];
    operation.record.remainingPaths = [...new Set([...operation.record.remainingPaths.filter((file) => !selected.includes(file)), ...remaining])];
    operation.record.uncertainPaths = [...new Set([...operation.record.uncertainPaths.filter((file) => !selected.includes(file)), ...uncertain])];
    operation.record.helperFailed ||= Boolean(failure);
    operation.record.phase = "trash-observed";
    await persist(operation);
    if (failure || remaining.length || uncertain.length) {
      operation.halted = new Error("The Trash operation failed or could not be confirmed; further changes stopped and the operation record was preserved.", { cause: failure });
      throw failure ?? operation.halted;
    }
  };
}

export function currentOperationHome(): string | undefined { return context.getStore()?.home; }

// 原生首次搬移前先將私有claim目錄連結到持久操作紀錄。
export async function recordPathClaim(directory: string, paths: string[], scopeHome?: string): Promise<void> {
  const operation = context.getStore();
  if (!operation) return;
  assertMutationAllowed(operation);
  const canonicalHome = await trustedHome(operation.home);
  const scope = await trustedHome(scopeHome ?? operation.home);
  if (scope !== canonicalHome && scope !== await fs.realpath(tmpdir())) throw new Error("Claim scope is outside approved home or private temporary storage.");
  const root = path.join(scope, ".ai-cli-cleaner", "recovery");
  if (path.dirname(directory) !== root || !operationIdPattern.test(path.basename(directory))) throw new Error("Claim storage is outside trusted recovery storage.");
  await privateDirectory(scope, directory);
  for (const file of paths) await assertHomePath(scopeHome ?? operation.home, file);
  const claims = operation.record.claims ??= [];
  if (!claims.some((claim) => claim.directory === directory)) claims.push({ directory, paths: [...paths], ...(scope === canonicalHome ? {} : { home: scope }) });
  await persist(operation);
}

export function haltOperation(error: unknown): void {
  const operation = context.getStore();
  if (operation) operation.halted ??= new Error("The operation failed or could not be confirmed; further changes stopped.", { cause: error });
}

export async function recordMetadata(progress: MetadataProgress): Promise<void> {
  const operation = context.getStore();
  if (!operation) return;
  if (["planned", "preparing", "backed-up", "writing"].includes(progress.stage)) assertMutationAllowed(operation);
  else assertHealthy(operation);
  if (!providers.has(progress.providerId) || !operation.record.target.includes(progress.providerId)) throw new Error("Metadata does not match the operation target.");
  for (const file of progress.paths) await assertHomePath(operation.home, file);
  if (progress.recoveryPath) {
    const root = path.join(operation.home, ".ai-cli-cleaner", "recovery");
    if (path.dirname(progress.recoveryPath) !== root || !operationIdPattern.test(path.basename(progress.recoveryPath))) throw new Error("Recovery backup path is not trusted.");
    await assertHomePath(operation.home, progress.recoveryPath);
  }
  const key = [...progress.paths].sort().join("\0");
  const prior = operation.record.metadata.find((item) => item.providerId === progress.providerId && [...item.paths].sort().join("\0") === key);
  if (prior) Object.assign(prior, Object.fromEntries(Object.entries(progress).filter(([, value]) => value !== undefined)));
  else operation.record.metadata.push({ ...progress, paths: [...progress.paths] });
  operation.record.phase = `metadata-${progress.stage}`;
  await persist(operation);
  if (progress.stage === "possibly-partial") haltOperation(new Error("Metadata writes may have completed partially."));
}

async function assertHomePath(home: string, file: string): Promise<void> {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || !containsPath(home, file) || file === home) throw new Error("Operation path is outside the home directory.");
  const canonical = await trustedHome(home);
  const expected = path.join(canonical, path.relative(home, file));
  if (await getCanonicalPath(file) !== expected) throw new Error("Operation path was redirected by a symbolic link.");
}

export async function listOperations(home = homedir()): Promise<OperationSummary[]> {
  const root = path.join(path.resolve(home), ".ai-cli-cleaner", "operations");
  try { await privateDirectory(home, root); } catch (error) { if (isMissing(error)) return []; throw error; }
  const result: OperationSummary[] = [];
  for (const id of await fs.readdir(root)) {
    if (!operationIdPattern.test(id)) throw new Error("Operation directory contains an unrecognized record.");
    const record = await readOperation(id, home);
    result.push({ id, kind: record.kind, target: record.target, startedAt: record.startedAt, status: record.status });
  }
  return result.sort((first, second) => second.startedAt.localeCompare(first.startedAt));
}
export async function inspectOperation(id: string, home = homedir()): Promise<OperationInspection> {
  const operation = await readOperation(id, home);
  const backups = await inspectBackups(operation, home);
  const claims = await inspectClaims(operation, home);
  return { operation, backups, claims, instructions: [
    "Close the selected agents and CLIs, then manually inspect the sources and system Trash. A missing source does not confirm its destination in Trash.",
    "incomplete indicates an interrupted process or unfinished journal. Neither uncertainPaths nor possibly-partial indicates success.",
    "Keep current data and backups. Manually select backups to restore only after confirming that the sources still match the state left by this cleanup; merge newer data first.",
    "Before restoring SQLite, fully archive the current database and its -wal, -shm, and -journal sidecars. Close all connections first; do not combine backups with old sidecars.",
    "Inspect each linked claim.json and its original directory before restoration. A held or partial claim may retain original sources or unexpected concurrent objects. Never overwrite newer source objects; keep the complete database and sidecar group together.",
    "This inspection does not modify sources, journals, or backups, and does not restore data automatically."
  ] };
}

async function inspectClaims(operation: OperationRecord, home: string): Promise<OperationInspection["claims"]> {
  const result: OperationInspection["claims"] = [];
  const canonicalHome = await trustedHome(home);
  for (const claim of operation.claims ?? []) {
    const scope = claim.home ?? canonicalHome;
    if (scope !== canonicalHome && scope !== await fs.realpath(tmpdir())) throw new Error("Claim scope is outside approved private storage.");
    const root = path.join(scope, ".ai-cli-cleaner", "recovery");
    if (path.dirname(claim.directory) !== root || !operationIdPattern.test(path.basename(claim.directory))) throw new Error("Claim recovery path is outside trusted storage.");
    const recordPath = path.join(claim.directory, "claim.json");
    try { await privateDirectory(scope, claim.directory); }
    catch (error) { if (!isMissing(error)) throw error; result.push({ directory: claim.directory, recordPath, status: "missing" }); continue; }
    let contents: Buffer;
    try { contents = await readPrivateFile(scope, recordPath); }
    catch (error) { if (!isMissing(error)) throw error; result.push({ directory: claim.directory, recordPath, status: "pending" }); continue; }
    const record: unknown = JSON.parse(contents.toString("utf8"));
    if (!isRecord(record) || record.formatVersion !== 1 || record.directory !== claim.directory || typeof record.state !== "string" || !Array.isArray(record.targets)) throw new Error("Claim recovery record is invalid.");
    for (const target of record.targets) {
      if (!isRecord(target) || typeof target.source !== "string" || typeof target.slot !== "string" || !/^[0-9]{3,}-[^/]+$/.test(target.slot) || !containsPath(scope, target.source)) throw new Error("Claim recovery source is outside approved private storage.");
    }
    result.push({ directory: claim.directory, recordPath, status: "recorded", state: record.state, targets: record.targets });
  }
  return result;
}
async function readOperation(id: string, home: string): Promise<OperationRecord> {
  if (!operationIdPattern.test(id)) throw new Error("Operation ID must be a UUID.");
  const file = path.join(path.resolve(home), ".ai-cli-cleaner", "operations", id, "operation.json");
  const value: unknown = JSON.parse((await readPrivateFile(home, file)).toString("utf8"));
  if (!isRecord(value) || value.formatVersion !== 1 || value.id !== id || !["clean", "conversations"].includes(String(value.kind)) ||
    !["incomplete", "succeeded", "failed", "partial"].includes(String(value.status)) || typeof value.startedAt !== "string" ||
    typeof value.updatedAt !== "string" || typeof value.phase !== "string" || typeof value.helperFailed !== "boolean" ||
    !stringArray(value.target) || !value.target.length || value.target.some((target) => !providers.has(target)) ||
    !Array.isArray(value.metadata)) throw new Error("Operation record format is invalid or has been modified.");
  for (const key of ["plannedPaths", "movedPaths", "uncertainPaths", "remainingPaths"]) {
    if (!stringArray(value[key])) throw new Error("Invalid operation path record format.");
    for (const target of value[key]) {
      if (!path.isAbsolute(target) || path.resolve(target) !== target || !containsPath(path.resolve(home), target) || target === path.resolve(home)) throw new Error("Operation record path is outside the allowed scope.");
    }
  }
  for (const item of value.metadata) {
    if (!isRecord(item) || typeof item.providerId !== "string" || !value.target.includes(item.providerId) || !stringArray(item.paths) ||
      !["planned", "preparing", "backed-up", "writing", "written", "possibly-partial", "released"].includes(String(item.stage)) ||
      (item.recoveryPath !== undefined && typeof item.recoveryPath !== "string") ||
      (item.manifestSha256 !== undefined && (typeof item.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.manifestSha256)))) throw new Error("Invalid metadata operation record format.");
    for (const target of item.paths) {
      if (!path.isAbsolute(target) || path.resolve(target) !== target || !containsPath(path.resolve(home), target) || target === path.resolve(home)) throw new Error("Metadata operation record path is outside the allowed scope.");
    }
  }
  if (value.claims !== undefined && (!Array.isArray(value.claims) || value.claims.some((claim) => !isRecord(claim) || typeof claim.directory !== "string" || !stringArray(claim.paths) || (claim.home !== undefined && typeof claim.home !== "string")))) throw new Error("Invalid operation claim links.");
  return value as unknown as OperationRecord;
}
export function sha256(contents: Buffer): string { return createHash("sha256").update(contents).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }

const providerRoots: Record<string, string[]> = {
  codex: [".codex"], copilot: [".copilot"], antigravity: [".gemini"],
  opencode: [".local", "share", "opencode"], grok: [".grok"]
};

async function inspectBackups(operation: OperationRecord, home: string): Promise<BackupInspection[]> {
  const output: BackupInspection[] = [];
  const root = path.join(path.resolve(home), ".ai-cli-cleaner", "recovery");
  for (const metadata of operation.metadata) {
    if (!metadata.recoveryPath) continue;
    const directory = metadata.recoveryPath;
    if (path.dirname(directory) !== root || !operationIdPattern.test(path.basename(directory))) throw new Error("Manifest backup directory is outside the allowed scope.");
    const manifestPath = path.join(directory, "manifest.json");
    const result: BackupInspection = { recoveryPath: directory, manifestPath, status: "verified", files: [] };
    try { await privateDirectory(home, directory); } catch (error) {
      if (!isMissing(error)) throw error;
      // 被移到系統垃圾桶後不猜測目的位置，也不沿用外部路徑讀取備份。
      result.status = "missing";
      output.push(result);
      continue;
    }
    let contents: Buffer;
    try { contents = await readPrivateFile(home, manifestPath); } catch (error) {
      if (!isMissing(error) || metadata.manifestSha256) throw error;
      result.status = "incomplete";
      output.push(result);
      continue;
    }
    if (!metadata.manifestSha256 || sha256(contents) !== metadata.manifestSha256) throw new Error("Manifest SHA-256 does not match or was not fully saved.");
    const manifest: unknown = JSON.parse(contents.toString("utf8"));
    if (!isRecord(manifest) || manifest.formatVersion !== 1 || manifest.providerId !== metadata.providerId ||
      manifest.recoveryDirectory !== directory || typeof manifest.createdAt !== "string" || !stringArray(manifest.conversationIds) ||
      !Array.isArray(manifest.files) || !stringArray(manifest.recoveryInstructions)) throw new Error("Manifest format is invalid or has been modified.");
    const seen = new Set<string>();
    for (const entry of manifest.files) {
      if (!isRecord(entry) || typeof entry.originalPath !== "string" || typeof entry.backupPath !== "string" ||
        !["json", "jsonl", "sqlite"].includes(String(entry.kind)) || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        seen.has(entry.backupPath)) throw new Error("Invalid manifest backup entry.");
      seen.add(entry.backupPath);
      const provider = providerRoots[metadata.providerId];
      if (!provider) throw new Error("Unsupported manifest provider.");
      const providerRoot = path.join(path.resolve(home), ...provider);
      if (!path.isAbsolute(entry.originalPath) || path.resolve(entry.originalPath) !== entry.originalPath ||
        !containsPath(providerRoot, entry.originalPath) || entry.originalPath === providerRoot ||
        !metadata.paths.includes(entry.originalPath)) throw new Error("Manifest source path is outside the allowed scope or does not match the operation.");
      if (path.dirname(entry.backupPath) !== directory || entry.backupPath === manifestPath ||
        !/^\d{3,}-[^/]+$/.test(path.basename(entry.backupPath))) throw new Error("Manifest backup path is outside the allowed scope.");
      const expected = path.join(await getCanonicalPath(home), path.relative(home, entry.backupPath));
      if (await getCanonicalPath(entry.backupPath) !== expected) throw new Error("Manifest backup path was redirected.");
      const handle = await openPrivateFile(home, entry.backupPath);
      try {
        const hash = createHash("sha256");
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
        if (hash.digest("hex") !== entry.sha256) throw new Error("Backup SHA-256 does not match.");
      } finally { await handle.close(); }
      result.files.push({ originalPath: entry.originalPath, backupPath: entry.backupPath, kind: String(entry.kind), sha256: entry.sha256 });
    }
    if (!result.files.length) throw new Error("Manifest contains no verifiable backups.");
    output.push(result);
  }
  return output;
}
