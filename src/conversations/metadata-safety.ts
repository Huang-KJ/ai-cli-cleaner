import { recordMetadata, sha256 } from "../recovery/operations.js";
import { privateDirectory, readPrivateFile, syncDirectory, syncPrivateFile } from "../recovery/storage.js";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, promises as fs } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { containsPath, getCanonicalPath, pathExists } from "../fs/paths.js";
import { createTemporaryDirectory, discardTemporary } from "../fs/temporary.js";
import type { TrashFn } from "../cleaners/clean.js";
import type { DeletionError, DeletionFailureDetails } from "./types.js";
import { sqliteSelectionSnapshot, type SqliteSelection } from "./sqlite.js";
import { claimPaths, snapshotClaimIdentity } from "../fs/claims.js";

type MetadataKind = "sqlite" | "json" | "jsonl";

interface MetadataEntry {
  path: string;
  canonicalPath: string;
  kind: MetadataKind;
  identity?: {
    device: number;
    inode: number;
    modifiedMs: number;
    sizeBytes: number;
    mode: number;
    nlink: number;
  };
  digest?: string;
}

export interface MetadataInventory {
  trustedRoot: string;
  canonicalTrustedRoot: string;
  providerRoot: string;
  canonicalProviderRoot: string;
  entries: MetadataEntry[];
  liveSqlite?: boolean;
  privateCopies?: boolean;
  sqliteRecoveryGuards?: Map<string, SqliteRecoveryGuard>;
}

interface SqliteRecoveryGuard {
  select: SqliteSelection;
  snapshot?: string;
}

export function guardSqliteRecovery(
  inventory: MetadataInventory,
  file: string,
  select: SqliteSelection
): void {
  const guards = inventory.sqliteRecoveryGuards ??= new Map();
  const target = path.resolve(file);
  const original = guards.get(target)?.select;
  guards.set(target, { select: original ? (database: DatabaseSync) => {
    const first = original(database);
    const second = select(database);
    return (table: string, row: Record<string, unknown>) => first(table, row) || second(table, row);
  } : select });
}

export function assertSqliteRecoveryUnchanged(
  database: DatabaseSync,
  file: string,
  inventory?: MetadataInventory
): void {
  const guard = inventory?.sqliteRecoveryGuards?.get(path.resolve(file));
  if (guard?.snapshot !== undefined &&
    sqliteSelectionSnapshot(database, guard.select(database)) !== guard.snapshot) {
    throw new Error(`Selected SQLite data changed after the recovery backup; rescan: ${file}`);
  }
}

interface RecoveryBackup {
  directory: string;
  manifestPath: string;
}

const sqliteSidecar = /\.(?:sqlite|db)-(?:wal|shm|journal)$/i;
const sqliteSharedMemory = /\.(?:sqlite|db)-shm$/i;
const sqliteWriteAheadLog = /\.(?:sqlite|db)-wal$/i;

export function withSqliteSidecars(files: string[]): string[] {
  return files.flatMap((file) => /\.(?:sqlite|db)$/i.test(file)
    ? [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]
    : [file]);
}

export async function createMetadataInventory(
  paths: string[],
  providerRoot: string,
  trustedRoot: string,
  options: { liveSqlite?: boolean } = {}
): Promise<MetadataInventory> {
  if (!path.isAbsolute(providerRoot) || !path.isAbsolute(trustedRoot)) {
    throw new Error(`Metadata provider and trusted roots must be absolute paths: ${providerRoot}`);
  }
  const normalizedRoot = path.resolve(providerRoot);
  const canonicalProviderRoot = await getCanonicalPath(normalizedRoot);
  const normalizedTrustedRoot = path.resolve(trustedRoot);
  const canonicalTrustedRoot = await getCanonicalPath(normalizedTrustedRoot);
  const relativeProviderRoot = path.relative(normalizedTrustedRoot, normalizedRoot);
  const expectedProviderRoot = path.resolve(canonicalTrustedRoot, relativeProviderRoot);
  if (
    relativeProviderRoot === "" || relativeProviderRoot === ".." ||
    relativeProviderRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeProviderRoot) ||
    canonicalProviderRoot !== expectedProviderRoot || !containsPath(canonicalTrustedRoot, canonicalProviderRoot)
  ) {
    throw new Error(`Provider root resolves outside the expected location: ${providerRoot}`);
  }
  try {
    if ((await fs.lstat(normalizedRoot)).isSymbolicLink()) {
      throw new Error(`Refusing a symbolic link provider root: ${normalizedRoot}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const candidates = new Set<string>();
  for (const input of paths) {
    if (!path.isAbsolute(input)) throw new Error(`Metadata path must be absolute: ${input}`);
    const file = path.resolve(input);
    if (!containsPath(normalizedRoot, file) || file === normalizedRoot) {
      throw new Error(`Refusing metadata outside the provider root: ${input}`);
    }
    for (const candidate of withSqliteSidecars([file])) candidates.add(candidate);
  }

  const entries: MetadataEntry[] = [];
  for (const file of [...candidates].sort()) {
    const canonicalPath = await getCanonicalPath(file);
    const relativeFile = path.relative(normalizedRoot, file);
    const expectedFile = path.resolve(canonicalProviderRoot, relativeFile);
    if (
      relativeFile === "" || relativeFile === ".." || relativeFile.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeFile) || canonicalPath !== expectedFile ||
      !containsPath(canonicalProviderRoot, canonicalPath) || canonicalPath === canonicalProviderRoot
    ) {
      throw new Error(`Refusing metadata that resolves outside the provider root: ${file}`);
    }
    const kind = metadataKind(file);
    let identity: MetadataEntry["identity"];
    let digest: string | undefined;
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link metadata: ${file}`);
      }
      if (!stat.isFile()) throw new Error(`Metadata must be a regular file: ${file}`);
      if (kind === "sqlite" && stat.nlink !== 1) throw new Error(`Refusing hard-linked SQLite metadata: ${file}`);
      identity = {
        device: stat.dev,
        inode: stat.ino,
        modifiedMs: stat.mtimeMs,
        sizeBytes: stat.size,
        mode: stat.mode,
        nlink: stat.nlink
      };
      await fs.access(file, constants.R_OK | constants.W_OK);
      if (!(options.liveSqlite && kind === "sqlite")) {
        digest = await hashFile(file);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    entries.push({ path: file, canonicalPath, kind, identity, digest });
  }
  return {
    trustedRoot: normalizedTrustedRoot,
    canonicalTrustedRoot,
    providerRoot: normalizedRoot,
    canonicalProviderRoot,
    entries,
    liveSqlite: options.liveSqlite
  };
}

export async function assertMetadataInventoryUnchanged(
  inventory: MetadataInventory
): Promise<void> {
  const canonicalTrustedRoot = await getCanonicalPath(inventory.trustedRoot);
  if (canonicalTrustedRoot !== inventory.canonicalTrustedRoot) {
    throw new Error(`Metadata trusted root changed; rescan: ${inventory.trustedRoot}`);
  }
  const currentRoot = await getCanonicalPath(inventory.providerRoot);
  const expectedRoot = path.resolve(
    canonicalTrustedRoot,
    path.relative(inventory.trustedRoot, inventory.providerRoot)
  );
  let rootStat;
  try {
    rootStat = await fs.lstat(inventory.providerRoot);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (
    currentRoot !== inventory.canonicalProviderRoot || currentRoot !== expectedRoot ||
    rootStat?.isSymbolicLink()
  ) {
    throw new Error(`Metadata provider root changed; rescan: ${inventory.providerRoot}`);
  }
  for (const entry of inventory.entries) {
    await assertEntryUnchanged(inventory, entry);
  }
}

export async function assertMetadataTargetUnchanged(
  file: string,
  inventory?: MetadataInventory
): Promise<void> {
  const entry = inventory?.entries.find((candidate) => candidate.path === path.resolve(file));
  if (inventory && !entry) throw new Error(`Metadata is not in the preflight inventory: ${file}`);
  if (!inventory || !entry) return;
  const related = inventory.entries.filter((candidate) =>
    candidate.path === entry.path || candidate.path.startsWith(`${entry.path}-`)
  );
  for (const target of related) await assertEntryUnchanged(inventory, target);
}

export async function rehearseMetadata(
  inventory: MetadataInventory,
  exercise: (copies: Map<string, string>) => Promise<void>
): Promise<string[]> {
  await assertMetadataInventoryUnchanged(inventory);
  const directory = await createTemporaryDirectory(path.join(tmpdir(), "ai-cleaner-preflight-"));
  await fs.chmod(directory, 0o700);
  try {
    const copies = await copyMetadataInventory(inventory, directory);
    await checkpointMetadataCopies(inventory, copies);
    const before = new Map<string, string | undefined>();
    for (const [original, copy] of copies) {
      if (sqliteSidecar.test(original)) continue;
      before.set(original, await pathExists(copy) ? await hashFile(copy) : undefined);
    }
    await exercise(copies);
    const changed: string[] = [];
    await checkpointMetadataCopies(inventory, copies);
    for (const [original, copy] of copies) {
      if (sqliteSidecar.test(original)) continue;
      const after = await pathExists(copy) ? await hashFile(copy) : undefined;
      if (before.get(original) !== after) changed.push(original);
    }
    await assertMetadataInventoryUnchanged(inventory);
    return changed;
  } finally {
    await discardTemporary([directory]);
  }
}

async function copyMetadataInventory(
  inventory: MetadataInventory,
  directory: string,
  sources?: Map<string, string>
): Promise<Map<string, string>> {
  const copies = new Map<string, string>();
  for (const entry of inventory.entries.filter((entry) => !sqliteSidecar.test(entry.path))) {
    copies.set(entry.path, path.join(directory, `${String(copies.size).padStart(3, "0")}-${path.basename(entry.path)}`));
  }
  for (const entry of inventory.entries.filter((entry) => sqliteSidecar.test(entry.path))) {
    const base = entry.path.replace(/-(?:wal|shm|journal)$/i, "");
    const target = copies.get(base);
    if (!target) throw new Error(`SQLite sidecar is missing its database inventory: ${entry.path}`);
    copies.set(entry.path, `${target}${entry.path.slice(base.length)}`);
  }
  for (const entry of inventory.entries) {
    if (!entry.identity) continue;
    const source = sources?.get(entry.path) ?? entry.path;
    const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const initial = await input.stat();
      const expected = entry.identity;
      if (!initial.isFile() || initial.dev !== expected.device || initial.ino !== expected.inode ||
        initial.nlink !== expected.nlink || initial.size !== expected.sizeBytes || initial.mtimeMs !== expected.modifiedMs) {
        throw new Error(`Metadata changed while preparing a private copy: ${entry.path}`);
      }
      const output = await fs.open(copies.get(entry.path)!, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const digest = createHash("sha256");
      try {
        const chunk = Buffer.alloc(64 * 1024);
        while (true) {
          const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
          if (!bytesRead) break;
          const bytes = chunk.subarray(0, bytesRead);
          digest.update(bytes);
          await output.writeFile(bytes);
        }
        await output.sync();
      } finally { await output.close(); }
      const final = await input.stat();
      if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.nlink !== initial.nlink ||
        (entry.digest !== undefined && digest.digest("hex") !== entry.digest)) {
        throw new Error(`Metadata contents changed while preparing a private copy: ${entry.path}`);
      }
    } finally { await input.close(); }
  }
  return copies;
}

async function checkpointMetadataCopies(inventory: MetadataInventory, copies: Map<string, string>): Promise<void> {
  for (const entry of inventory.entries) {
    if (entry.kind !== "sqlite" || sqliteSidecar.test(entry.path) || !entry.identity) continue;
    const file = copies.get(entry.path)!;
    const database = new DatabaseSync(file);
    try {
      const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (checkpoint && checkpoint.busy !== 0) throw new Error("Private metadata WAL could not be checkpointed.");
    } finally { database.close(); }
  }
}

export async function writeStagedMetadata(
  home: string,
  inventory: MetadataInventory,
  recovery: RecoveryBackup,
  write: (copies: Map<string, string>, inventory: MetadataInventory) => Promise<void>,
  publishing: () => void
): Promise<() => Promise<void>> {
  await assertMetadataInventoryUnchanged(inventory);
  const claim = await claimPaths(home, inventory.entries.map((entry) => ({ path: entry.path, identity: entry.identity })),
    { directory: recovery.directory });
  let publishStarted = false;
  try {
    const directory = path.join(claim.directory, "work");
    await fs.mkdir(directory, { mode: 0o700 });
    const copies = await copyMetadataInventory(inventory, directory, claim.files);
    await checkpointMetadataCopies(inventory, copies);
    const mapped = await createMetadataInventory([...copies.values()].filter((file) => !sqliteSidecar.test(file)), directory,
      await getCanonicalPath(home));
    mapped.privateCopies = true;
    await write(copies, mapped);
    await checkpointMetadataCopies(inventory, copies);
    const completed = await createMetadataInventory([...copies.values()].filter((file) => !sqliteSidecar.test(file)), directory,
      await getCanonicalPath(home));
    const published: MetadataInventory = { ...inventory, liveSqlite: false, privateCopies: false,
      sqliteRecoveryGuards: undefined,
      entries: inventory.entries.map((entry) => {
        const copy = completed.entries.find((candidate) => candidate.path === copies.get(entry.path));
        if (!copy) throw new Error(`Published metadata mapping is incomplete: ${entry.path}`);
        return { ...entry, identity: copy.identity, digest: copy.digest };
      }) };
    const replacements = new Map<string, string>();
    for (const [original, copy] of copies) {
      if (await pathExists(copy)) replacements.set(original, copy);
    }
    publishStarted = true;
    publishing();
    await claim.publish(replacements);
    return () => assertMetadataInventoryUnchanged(published);
  } catch (error) {
    if (!publishStarted) {
      try { await claim.rollback(); }
      catch (rollbackError) { throw attachMetadataFailure(rollbackError, { metadataChanged: true, recoveryPath: recovery.directory }); }
      // 私有副本的寫入不代表原始 metadata 已變動。
      throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
    }
    throw error;
  }
}

export async function withPrivateReadDatabase<T>(
  home: string,
  providerRoot: string,
  file: string,
  read: (database: DatabaseSync) => T | Promise<T>
): Promise<T> {
  const trusted = await getCanonicalPath(home);
  const root = path.resolve(trusted, path.relative(path.resolve(home), path.resolve(providerRoot)));
  const target = containsPath(path.resolve(providerRoot), path.resolve(file))
    ? path.resolve(root, path.relative(providerRoot, file)) : path.resolve(file);
  const inventory = await createMetadataInventory([target], root, trusted);
  let result!: T;
  await rehearseMetadata(inventory, async (copies) => {
    const database = new DatabaseSync(copies.get(target)!, { readOnly: true });
    try { result = await read(database); }
    finally { database.close(); }
  });
  return result;
}

export async function createRecoveryBackup(
  home: string,
  inventory: MetadataInventory,
  files: string[],
  providerId: string,
  conversationIds: string[]
): Promise<RecoveryBackup | undefined> {
  const selected = [...new Set(files)].filter((file) =>
    inventory.entries.some((entry) => entry.path === file && entry.identity && !sqliteSidecar.test(entry.path))
  );
  if (selected.length === 0) return undefined;
  await assertMetadataInventoryUnchanged(inventory);

  const recoveryRoot = path.join(path.resolve(home), ".ai-cli-cleaner", "recovery");
  const cleanerRoot = path.dirname(recoveryRoot);
  await privateDirectory(home, cleanerRoot, true);
  await privateDirectory(home, recoveryRoot, true);

  const directory = path.join(recoveryRoot, randomUUID());
  await recordMetadata({ providerId, paths: files, stage: "preparing", recoveryPath: directory });
  await privateDirectory(home, directory, true);
  let staging: string | undefined;
  try {
    staging = await createTemporaryDirectory(path.join(tmpdir(), "ai-cleaner-recovery-copy-"));
    await fs.chmod(staging, 0o700);
    const copies = await copyMetadataInventory(inventory, staging);
    const backupEntries: Array<{ originalPath: string; backupPath: string; kind: MetadataKind; sha256: string }> = [];
    for (const [index, originalPath] of selected.entries()) {
      const entry = inventory.entries.find((candidate) => candidate.path === originalPath);
      if (!entry?.identity) continue;
      const backupPath = path.join(directory, `${String(index + 1).padStart(3, "0")}-${path.basename(originalPath)}`);
      if (entry.kind === "sqlite") {
        const source = new DatabaseSync(copies.get(originalPath)!, { readOnly: true });
        try {
          await backup(source, backupPath);
        } finally {
          source.close();
        }
      } else {
        await fs.copyFile(copies.get(originalPath)!, backupPath);
      }
      await fs.chmod(backupPath, 0o600);
      await syncPrivateFile(home, backupPath);
      const guard = inventory.sqliteRecoveryGuards?.get(originalPath);
      if (guard) {
        const database = new DatabaseSync(backupPath, { readOnly: true });
        try {
          guard.snapshot = sqliteSelectionSnapshot(database, guard.select(database));
        } finally {
          database.close();
        }
      }
      backupEntries.push({
        originalPath,
        backupPath,
        kind: entry.kind,
        sha256: await hashFile(backupPath)
      });
    }
    await assertMetadataInventoryUnchanged(inventory);
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      providerId,
      conversationIds,
      recoveryDirectory: directory,
      files: backupEntries,
      recoveryInstructions: [
        "Close agents and CLIs that use this metadata first.",
        "Keep the current originals and this backup. Check the original paths, backup paths, and SHA-256 hashes in the manifest.",
        "Manually select backups to restore only after confirming that the originals still match the state left by this cleanup.",
        "If the originals contain newer data, merge it manually first; do not overwrite new data.",
        "SQLite backups use the online backup API and include WAL contents committed at the time of backup.",
        "Before restoring, fully archive the current database and its -wal, -shm, and -journal sidecars.",
        "Close all database connections before restoring. Do not combine a backup database with existing sidecars."
      ]
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fs.chmod(manifestPath, 0o600);
    await syncPrivateFile(home, manifestPath);
    await syncDirectory(directory);
    await recordMetadata({ providerId, paths: files, stage: "backed-up", recoveryPath: directory,
      manifestSha256: sha256(await readPrivateFile(home, manifestPath)) });
    return { directory, manifestPath };
  } catch (error) {
    throw attachMetadataFailure(error, { metadataChanged: false, recoveryPath: directory });
  } finally {
    if (staging) await discardTemporary([staging]);
  }
}

export async function removeRecoveryBackup(recovery: RecoveryBackup | undefined, trash: TrashFn): Promise<void> {
  if (!recovery) return;
  await trash([recovery.directory], new Map([[recovery.directory, snapshotClaimIdentity(recovery.directory)]]));
  if (await pathExists(recovery.directory)) {
    throw new Error(`Recovery backup remains at its original path; the Trash operation did not complete: ${recovery.directory}`);
  }
}

export function attachMetadataFailure(
  error: unknown,
  details: DeletionFailureDetails = {}
): DeletionError {
  const output = error instanceof Error ? error : new Error(String(error));
  const annotated = output as DeletionError;
  if (details.deletedPaths?.length) {
    annotated.deletedPaths = [...new Set([...(annotated.deletedPaths ?? []), ...details.deletedPaths])];
  }
  if (details.metadataChanged !== undefined && annotated.metadataChanged !== true) {
    annotated.metadataChanged = details.metadataChanged;
  }
  annotated.recoveryPath ??= details.recoveryPath;
  return annotated;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function metadataKind(file: string): MetadataKind {
  if (/\.(?:sqlite|db)(?:-(?:wal|shm|journal))?$/i.test(file)) return "sqlite";
  if (/\.jsonl$/i.test(file)) return "jsonl";
  if (/\.json(?:\.bak)?$/i.test(file)) return "json";
  throw new Error(`Unsupported metadata file format: ${file}`);
}

export async function atomicRewrite(
  file: string,
  contents: string | AsyncIterable<string>,
  inventory?: MetadataInventory
): Promise<void> {
  const temporary = `${file}.ai-cleaner-${randomUUID()}.tmp`;
  let created = false;
  let metadataChanged = false;
  try {
    const handle = await fs.open(temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      (await fs.stat(file)).mode & 0o777);
    created = true;
    try {
      if (typeof contents === "string") await handle.writeFile(contents);
      else for await (const chunk of contents) await handle.writeFile(chunk);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertMetadataTargetUnchanged(file, inventory);
    await fs.rename(temporary, file);
    metadataChanged = true;
    await syncDirectory(path.dirname(file));
  } catch (error) {
    throw attachMetadataFailure(error, { metadataChanged });
  } finally {
    // 只清理本次成功建立且尚未搬移的暫存檔；碰撞檔案不屬於本次操作。
    if (created && !metadataChanged) await discardTemporary([temporary]);
  }
}

async function assertEntryUnchanged(
  inventory: MetadataInventory,
  entry: MetadataEntry
): Promise<void> {
  const canonicalPath = await getCanonicalPath(entry.path);
  const expectedPath = path.resolve(
    inventory.canonicalProviderRoot,
    path.relative(inventory.providerRoot, entry.path)
  );
  if (
    canonicalPath !== entry.canonicalPath ||
    canonicalPath !== expectedPath ||
    !containsPath(inventory.canonicalProviderRoot, canonicalPath)
  ) {
    throw new Error(`Metadata path changed or escaped its allowed scope; rescan: ${entry.path}`);
  }
  let stat;
  try {
    stat = await fs.lstat(entry.path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (entry.kind === "sqlite" && stat && (stat.nlink !== 1 ||
      (entry.identity && stat.nlink !== entry.identity.nlink))) {
    throw new Error(`SQLite metadata link count changed or is hard-linked; rescan: ${entry.path}`);
  }
  if (inventory.liveSqlite && entry.kind === "sqlite") {
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
      throw new Error(`Metadata changed after preflight; rescan: ${entry.path}`);
    }
    if (!sqliteSidecar.test(entry.path)) {
      if (Boolean(entry.identity) !== Boolean(stat) ||
        (entry.identity && stat && (stat.dev !== entry.identity.device || stat.ino !== entry.identity.inode))) {
        throw new Error(`SQLite database identity changed; rescan: ${entry.path}`);
      }
      if (inventory.sqliteRecoveryGuards?.get(entry.path)?.snapshot !== undefined) {
        await withPrivateReadDatabase(inventory.trustedRoot, inventory.providerRoot, entry.path, (database) => {
          // 同一個讀取交易避免把並行提交的不同狀態混成快照。
          database.exec("BEGIN");
          assertSqliteRecoveryUnchanged(database, entry.path, inventory);
        });
      }
    }
    return;
  }
  // 唯讀連線可重建 SHM，但仍拒絕符號連結與非一般檔案。
  if ((inventory.liveSqlite || inventory.privateCopies) && sqliteSharedMemory.test(entry.path)) {
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
      throw new Error(`Metadata changed after preflight; rescan: ${entry.path}`);
    }
    return;
  }
  // 唯讀連線可能新增空 WAL；已有提交內容的 WAL 仍須完整驗證。
  if ((inventory.liveSqlite || inventory.privateCopies) && !entry.identity && stat?.isFile() && stat.size === 0 &&
    sqliteWriteAheadLog.test(entry.path)) return;
  if (!entry.identity && stat) {
    throw new Error(`Metadata appeared after preflight; rescan: ${entry.path}`);
  }
  if (entry.identity && !stat) {
    throw new Error(`Metadata disappeared after preflight; rescan: ${entry.path}`);
  }
  if (entry.identity && stat) {
    const changed = stat.isSymbolicLink() || !stat.isFile() ||
      stat.dev !== entry.identity.device || stat.ino !== entry.identity.inode ||
      stat.mtimeMs !== entry.identity.modifiedMs || stat.size !== entry.identity.sizeBytes;
    if (changed) throw new Error(`Metadata changed after preflight; rescan: ${entry.path}`);
    if (entry.digest !== undefined && await hashFile(entry.path) !== entry.digest) {
      throw new Error(`Metadata contents changed after preflight; rescan: ${entry.path}`);
    }
  }
}


function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
