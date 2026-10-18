import { promises as fs, type Dirent, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { ScanPathIdentity } from "../cleaners/types.js";

export const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
export const PATH_WALK_LIMITS = {
  depth: 128, entries: 100_000, bytes: 2 ** 40, pathBytes: 64 * 1024 * 1024, milliseconds: 30_000
} as const;
const sqliteDatabaseExtensionPattern = "(?:sqlite|db)";
const sqliteSidecarPattern = SQLITE_SIDECAR_SUFFIXES.map(escapeRegExp).join("|");
const sqliteBasePathPattern = new RegExp(
  `^(.*\\.${sqliteDatabaseExtensionPattern})(?:${sqliteSidecarPattern})?$`,
  "i"
);
const sqliteWildcardPattern = new RegExp(`^(.*\\.${sqliteDatabaseExtensionPattern})\\*$`, "i");

export function expandHome(input: string, home = homedir()): string {
  if (input === "~") return home;
  return path.normalize(input.startsWith("~/") ? path.join(home, input.slice(2)) : input);
}

export function getSQLiteBasePath(targetPath: string): string | undefined {
  if (targetPath.includes("*")) return undefined;

  return sqliteBasePathPattern.exec(targetPath)?.[1];
}

export async function resolvePattern(pattern: string, home = homedir()): Promise<string[]> {
  const expanded = expandHome(pattern, home);

  if (!path.isAbsolute(expanded)) {
    throw new Error(`Refusing to resolve non-absolute path: ${expanded}`);
  }

  if (!expanded.includes("*")) {
    return [expanded];
  }

  const parent = path.dirname(expanded);
  const basenamePattern = path.basename(expanded);
  const matcher = wildcardToRegExp(basenamePattern);

  try {
    const matches: string[] = [];
    for await (const entry of readDirectoryBounded(parent)) {
      if (matcher.test(entry.name)) matches.push(path.join(parent, entry.name));
    }
    matches.sort();

    return matches.length > 0 ? matches : [expanded];
  } catch (error) {
    if (isMissingPath(error)) {
      return [expanded];
    }

    throw error;
  }
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }

    throw error;
  }
}

export async function getPathIdentity(targetPath: string): Promise<ScanPathIdentity | undefined> {
  return (await getPathSnapshot(targetPath))?.identity;
}

export async function getPathSnapshot(targetPath: string): Promise<{
  identity: ScanPathIdentity;
  sizeBytes: number;
} | undefined> {
  let stat: Stats;
  try {
    stat = await fs.lstat(targetPath);
  } catch (error) {
    if (isMissingPath(error)) {
      return undefined;
    }

    throw error;
  }

  const kind = stat.isDirectory()
    ? "directory"
    : stat.isFile()
      ? "file"
      : stat.isSymbolicLink()
        ? "symlink"
        : "other";

  const tree = kind === "directory"
    ? await walkPath(targetPath, createLimiter(32), "snapshot", stat)
    : undefined;
  return {
    identity: {
      device: stat.dev,
      inode: stat.ino,
      modifiedMs: stat.mtimeMs,
      sizeBytes: stat.size,
      kind,
      treeFingerprint: tree?.fingerprint
    },
    sizeBytes: tree?.sizeBytes ?? stat.size
  };
}

export async function getCanonicalPath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch (error) {
    if (!isMissingPath(error)) {
      throw error;
    }

    const parent = path.dirname(targetPath);
    if (parent === targetPath) {
      return targetPath;
    }

    return path.join(await getCanonicalPath(parent), path.basename(targetPath));
  }
}

export function containsPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

export interface PathSizeOptions {
  concurrency?: number;
  budget?: PathWalkBudget;
}

export async function getPathSize(
  targetPath: string,
  options: PathSizeOptions = {}
): Promise<number> {
  const concurrency = options.concurrency ?? 32;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Path-size concurrency must be a positive integer.");
  }

  const budget = options.budget ?? createPathWalkBudget();
  if (options.budget) consumePathWalkBudget(budget, targetPath);
  return (await walkPath(targetPath, createLimiter(concurrency), "size", undefined, budget)).sizeBytes;
}

type Limit = <T>(operation: () => Promise<T>) => Promise<T>;
type WalkMode = "size" | "snapshot";
export interface PathWalkBudget {
  entries: number;
  bytes: number;
  pathBytes: number;
  deadline: number;
}

export function createPathWalkBudget(): PathWalkBudget {
  return { entries: 1, bytes: 0, pathBytes: 0, deadline: performance.now() + PATH_WALK_LIMITS.milliseconds };
}

export class PathResourceLimitError extends Error {
  constructor(targetPath: string) {
    super(`Filesystem traversal resource limit exceeded; cleanup stopped: ${targetPath}`);
    this.name = "PathResourceLimitError";
  }
}

export function consumePathWalkBudget(budget: PathWalkBudget, targetPath: string): void {
  budget.entries++;
  budget.pathBytes += Buffer.byteLength(targetPath);
  assertWalkBudget(budget, targetPath, 0);
}

function assertWalkBudget(budget: PathWalkBudget, targetPath: string, depth: number): void {
  if (depth > PATH_WALK_LIMITS.depth || budget.entries > PATH_WALK_LIMITS.entries ||
      budget.bytes > PATH_WALK_LIMITS.bytes || budget.pathBytes > PATH_WALK_LIMITS.pathBytes ||
      performance.now() > budget.deadline) {
    throw new PathResourceLimitError(targetPath);
  }
}

export async function* readDirectoryBounded(
  targetPath: string,
  budget = createPathWalkBudget(),
  depth = 0
): AsyncGenerator<Dirent> {
  assertWalkBudget(budget, targetPath, depth);
  const directory = await fs.opendir(targetPath);
  for await (const entry of directory) {
    budget.entries++;
    budget.pathBytes += Buffer.byteLength(path.join(targetPath, entry.name));
    assertWalkBudget(budget, targetPath, depth);
    yield entry;
  }
  assertWalkBudget(budget, targetPath, depth);
}

async function walkPath(
  targetPath: string,
  limit: Limit,
  mode: WalkMode,
  knownStat?: Stats,
  budget = createPathWalkBudget(),
  depth = 0
): Promise<{ fingerprint?: string; sizeBytes: number }> {
  assertWalkBudget(budget, targetPath, depth);
  let stat: Stats;
  try {
    stat = knownStat ?? await limit(() => fs.lstat(targetPath));
  } catch (error) {
    if (mode === "size" && isMissingPath(error)) return { sizeBytes: 0 };
    throw error;
  }

  const kind = stat.isDirectory()
    ? "directory"
    : stat.isFile()
      ? "file"
      : stat.isSymbolicLink()
        ? "symlink"
        : "other";
  const hash = mode === "snapshot" ? createHash("sha256") : undefined;
  hash?.update(JSON.stringify([
    kind,
    stat.dev,
    stat.ino,
    stat.mode,
    stat.mtimeMs,
    stat.size
  ]));

  let sizeBytes = stat.size;
  if (kind === "directory") {
    const children: string[] = [];
    try {
      for await (const entry of readDirectoryBounded(targetPath, budget, depth)) children.push(entry.name);
    } catch (error) {
      if (mode === "size" && isMissingPath(error)) return { sizeBytes: 0 };
      throw error;
    }
    if (mode === "snapshot") children.sort();
    sizeBytes = 0;
    // 分批建立工作，避免大型單層目錄一次配置所有 Promise 與等待佇列。
    for (let offset = 0; offset < children.length; offset += 64) {
      const childResults = await Promise.all(
        children.slice(offset, offset + 64).map(async (child) => [
          child,
          await walkPath(path.join(targetPath, child), limit, mode, undefined, budget, depth + 1)
        ] as const)
      );
      for (const [child, result] of childResults) {
        if (hash) {
          hash.update(child);
          hash.update("\0");
          hash.update(result.fingerprint!);
        }
        sizeBytes += result.sizeBytes;
      }
    }
  } else {
    budget.bytes += stat.size;
    assertWalkBudget(budget, targetPath, depth);
  }

  return { fingerprint: hash?.digest("hex"), sizeBytes };
}

function createLimiter(concurrency: number): Limit {
  let active = 0;
  const queue: Array<() => void> = [];

  return async <T>(operation: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1;
        operation()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            queue.shift()?.();
          });
      };

      if (active < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
}

function wildcardToRegExp(pattern: string): RegExp {
  const databaseArtifactPattern = sqliteWildcardPattern.exec(pattern);
  if (databaseArtifactPattern) {
    const databasePath = databaseArtifactPattern[1];
    if (databasePath === undefined) {
      throw new Error(`Invalid database artifact pattern: ${pattern}`);
    }

    return new RegExp(`^${escapeRegExp(databasePath)}(?:${sqliteSidecarPattern})?$`);
  }

  const escaped = pattern
    .split("*")
    .map(escapeRegExp)
    .join(".*");

  return new RegExp(`^${escaped}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
