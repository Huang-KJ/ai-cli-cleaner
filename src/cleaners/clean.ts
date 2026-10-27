import path from "node:path";
import { lstat } from "node:fs/promises";
import type { OpenFileCheck } from "../fs/open-files.js";
import {
  getCanonicalPath,
  getPathIdentity,
  getSQLiteBasePath,
  pathExists,
  SQLITE_SIDECAR_SUFFIXES
} from "../fs/paths.js";
import type { CleanResult, ScanEntry } from "./types.js";
import type { ClaimIdentity } from "../fs/claims.js";
import { validatePreservationGuards } from "../fs/preservation.js";

export type TrashFn = (paths: string[], expected?: Map<string, ClaimIdentity>) => Promise<void>;
export type OpenFileCheckFn = (paths: string[]) => Promise<OpenFileCheck>;

export interface CleanOptions {
  dryRun?: boolean;
  batch?: boolean;
  checkOpenPaths?: OpenFileCheckFn;
  trash: TrashFn;
}

export async function validateEntries(entries: ScanEntry[]): Promise<void> {
  for (const group of groupRelatedEntries(entries.filter((entry) => entry.exists && !entry.error))) {
    await validatePreservationGuards(group.flatMap((entry) => entry.preservationGuards ?? []));
    if (group.some((entry) => !path.isAbsolute(entry.path))) throw new Error("Refusing to clean a non-absolute path.");
    const changed = await findChangedEntry(group);
    if (changed) throw new Error(`Path changed after scanning; rerun the command: ${changed.path}`);
    const changedGroup = await findChangedSQLiteGroup(group);
    if (changedGroup) throw new Error(`SQLite sidecar set changed after scanning; rerun the command: ${changedGroup.path}`);
  }
}

export async function cleanEntries(entries: ScanEntry[], options: CleanOptions): Promise<CleanResult> {
  const result: CleanResult = {
    deleted: [],
    scanErrors: entries.filter((entry) => entry.error),
    openFileCheckUnsupported: false, failures: []
  };
  if (options.dryRun) return result;
  const groups = groupRelatedEntries(entries.filter((entry) => entry.exists && !entry.error));
  for (const group of options.batch ? batchEntryGroups(groups) : groups) {
    let attempted = false;
    const classified = new Set<ScanEntry>();
    try {
      if (options.checkOpenPaths) {
        const check = await options.checkOpenPaths(group.map((entry) => entry.path));
        if (!check.supported) {
          result.openFileCheckUnsupported = true;
          throw new Error("Cannot check open-file status; ensure lsof is available, then retry.");
        }
        if (check.openPaths.length) throw new Error(`Refusing to clean open file(s): ${check.openPaths.join(", ")}`);
      }
      await validateEntries(group);
      attempted = true;
      await options.trash(group.map((entry) => entry.path), new Map(group.map((entry) => {
        if (!entry.identity) throw new Error(`A cleanup target has no approved filesystem identity: ${entry.path}`);
        return [entry.path, entry.identity];
      })));
      for (const entry of group) {
        if (await pathExists(entry.path)) {
          result.failures.push({ entry, error: new Error(`Original path still exists after the Trash operation: ${entry.path}`) });
        } else {
          result.deleted.push(entry);
        }
        classified.add(entry);
      }
    } catch (error) {
      for (const entry of group) {
        if (classified.has(entry)) continue;
        try {
          if (attempted && !(error instanceof Error && "unconfirmedTrash" in error && error.unconfirmedTrash) && !(await pathExists(entry.path))) {
            result.deleted.push(entry);
            continue;
          }
        } catch {
          // 保留最初的搬移錯誤。
        }
        result.failures.push({ entry, error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
  }
  return result;
}

// 同一 SQLite 群組不可拆開；其他資料合併搬移，減少 helper 與占用檢查次數。
function batchEntryGroups(groups: ScanEntry[][]): ScanEntry[][] {
  const batches: ScanEntry[][] = [];
  let batch: ScanEntry[] = [];
  for (const group of groups) {
    if (batch.length && batch.length + group.length > 64) {
      batches.push(batch);
      batch = [];
    }
    batch.push(...group);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function groupRelatedEntries(entries: ScanEntry[]): ScanEntry[][] {
  const groups = new Map<string, ScanEntry[]>();

  for (const entry of entries) {
    const basePath = getSQLiteBasePath(entry.path);
    const key = `${entry.providerId}\0${basePath ?? entry.path}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return [...groups.values()];
}

async function findChangedEntry(
  entries: ScanEntry[]
): Promise<ScanEntry | undefined> {
  for (const entry of entries) {
    if (!entry.identity) {
      continue;
    }

    let currentIdentity;
    let currentCanonicalPath;
    try {
      currentIdentity = await getPathIdentity(entry.path);
      currentCanonicalPath = entry.identity.canonicalPath === undefined
        ? undefined
        : await getCanonicalPath(entry.path);
    } catch {
      return entry;
    }

    if (!currentIdentity) {
      return entry;
    }

    const canonicalPathChanged =
      entry.identity.canonicalPath !== undefined &&
      currentCanonicalPath !== entry.identity.canonicalPath;
    if (canonicalPathChanged) {
      return entry;
    }

    const identityChanged =
      currentIdentity.device !== entry.identity.device ||
      currentIdentity.inode !== entry.identity.inode ||
      currentIdentity.kind !== entry.identity.kind;
    if (identityChanged) return entry;
    // SHM 的讀取記帳可改變 mtime；僅容許完整群組內同一個、同長度且無硬連結的一般檔案。
    const base = getSQLiteBasePath(entry.path);
    if (entry.path.toLowerCase().endsWith("-shm") && base &&
        entry.identity.kind === "file" && currentIdentity.kind === "file") {
      try {
        const info = await lstat(entry.path);
        if (!info.isFile() || info.nlink !== 1 || info.dev !== entry.identity.device ||
            info.ino !== entry.identity.inode || info.size !== entry.identity.sizeBytes) return entry;
      } catch {
        return entry;
      }
      if (currentIdentity.sizeBytes === entry.identity.sizeBytes &&
          currentIdentity.modifiedMs !== entry.identity.modifiedMs &&
          entry.sqliteGroup?.complete && entry.sqliteGroup.members.includes(base) &&
          entries.some((member) => member.path === base && member.identity?.kind === "file")) continue;
    }
    const contentChanged =
      currentIdentity.modifiedMs !== entry.identity.modifiedMs ||
      currentIdentity.sizeBytes !== entry.identity.sizeBytes ||
      currentIdentity.treeFingerprint !== entry.identity.treeFingerprint;

    if (contentChanged) {
      return entry;
    }
  }

  return undefined;
}

async function findChangedSQLiteGroup(entries: ScanEntry[]): Promise<ScanEntry | undefined> {
  const group = entries.find((entry) => entry.sqliteGroup)?.sqliteGroup;
  if (!group) return undefined;

  const inconsistentEntry = entries.find((entry) => {
    const other = entry.sqliteGroup;
    return !other || other.basePath !== group.basePath ||
      other.complete !== group.complete ||
      !samePaths(other.members, group.members) ||
      getSQLiteBasePath(entry.path) !== group.basePath ||
      !group.members.includes(entry.path) ||
      group.members.some((member) => getSQLiteBasePath(member) !== group.basePath);
  });
  if (inconsistentEntry) return inconsistentEntry;

  if (!group.complete) return entries[0];

  const expectedSidecars = group.members
    .filter((member) => member !== group.basePath)
    .sort();
  const currentSidecars: string[] = [];
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${group.basePath}${suffix}`;
    try {
      if (await pathExists(sidecarPath)) currentSidecars.push(sidecarPath);
    } catch {
      return entries[0];
    }
  }

  currentSidecars.sort();
  return samePaths(currentSidecars, expectedSidecars) ? undefined : entries[0];
}

function samePaths(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((item, index) => item === second[index]);
}
