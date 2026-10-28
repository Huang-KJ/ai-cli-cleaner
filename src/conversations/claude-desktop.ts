import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { ScanEntry } from "../cleaners/types.js";
import { assertDefaultDataRoots } from "../cleaners/manifests.js";
import { createPathWalkBudget } from "../fs/paths.js";
import { discoverClaudeConversations } from "./claude.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_DIRECTORY_ENTRIES = 20_000;

interface SessionRecord {
  sessionId: string;
  createdAt: number;
  lastActivityAt: number;
  cliSessionId?: string;
  unarchivedCliSessionId?: string;
  priorCliSessionIds?: string[];
  [key: string]: unknown;
}

interface DirectorySnapshot {
  path: string;
  device: number;
  inode: number;
  mode: number;
}

interface MissingDirectory {
  path: string;
  missing: true;
}

type DirectoryState = DirectorySnapshot | MissingDirectory;

interface FileSnapshot {
  path: string;
  canonicalPath: string;
  sessionId: string;
  record: SessionRecord;
  device: number;
  inode: number;
  modifiedMs: number;
  sizeBytes: number;
  mode: number;
  nlink: number;
  digest: string;
}

interface StoreSnapshot {
  directories: Map<string, DirectoryState>;
  files: Map<string, FileSnapshot>;
}

interface DesktopStore {
  name: "Claude" | "Claude-3p";
  userData: string;
  root: string;
}

function storesFor(home: string): DesktopStore[] {
  const configured = process.env.CLAUDE_USER_DATA_DIR;
  const names = configured ? [path.basename(path.resolve(configured))] : ["Claude", "Claude-3p"];
  return names.map((name) => {
    if (name !== "Claude" && name !== "Claude-3p") {
      throw new Error("Unsupported Claude Desktop data directory; cleanup stopped.");
    }
    const userData = path.join(home, "Library", "Application Support", name);
    return { name, userData, root: path.join(userData, "claude-code-sessions") };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRecord(value: unknown, filenameId: string, file: string): SessionRecord {
  if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId !== filenameId ||
      !value.sessionId || value.sessionId.length > 256 || /[/\\\x00-\x1f\x7f]/.test(value.sessionId) ||
      typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt < 0 ||
      typeof value.lastActivityAt !== "number" || !Number.isFinite(value.lastActivityAt) || value.lastActivityAt < 0) {
    throw new Error(`Unknown Claude Desktop session metadata format; cleanup stopped: ${file}`);
  }
  for (const key of ["cliSessionId", "unarchivedCliSessionId"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`Invalid Claude Desktop session reference; cleanup stopped: ${file}`);
    }
  }
  for (const key of ["cwd", "originCwd"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`Invalid Claude Desktop working directory; cleanup stopped: ${file}`);
    }
  }
  if (value.priorCliSessionIds !== undefined && (!Array.isArray(value.priorCliSessionIds) ||
      value.priorCliSessionIds.some((id) => typeof id !== "string"))) {
    throw new Error(`Invalid Claude Desktop session references; cleanup stopped: ${file}`);
  }
  return value as SessionRecord;
}

function preserveRemoteOrStaged(record: SessionRecord): boolean {
  // 只依 SSH／WSL／遠端 backend 判執行位置；Git anchor、MCP 與 Remote Control 狀態是本機中繼資料。
  if (Object.hasOwn(record, "sshConfig") || Object.hasOwn(record, "wslConfig") ||
      Object.hasOwn(record, "remoteTarget") || Object.hasOwn(record, "stagedTranscriptPath")) return true;
  if (isRecord(record.backend) && (Object.hasOwn(record.backend, "remoteTarget") ||
      ["ssh", "wsl", "remote"].includes(String(record.backend.kind ?? "").toLowerCase()))) return true;
  const known = new Set(["sessionId", "createdAt", "lastActivityAt", "cliSessionId", "unarchivedCliSessionId",
    "priorCliSessionIds", "sessionType", "cwd", "originCwd", "title", "worktreePath", "worktreeName",
    "folderWorktrees", "startedWithWorktree", "lazyWorktree", "lazyWorktreePath", "worktreeLazy",
    "remoteSessionId", "bridgeSessionId", "gitAnchorsFolderRealpath", "gitAnchors", "gitAnchorsLookupOnly",
    "remoteMcpServersConfig", "remoteControlAutoEligible", "remoteControlUserEnabled", "steeredByRemoteClient"]);
  if (Object.keys(record).some((key) => !known.has(key) &&
      /remote|ssh|wsl|storage|stage|workspace|working.?dir|backend|host|path|cwd|dir|folder|config/i.test(key))) return true;
  return false;
}

function hasWorktree(record: SessionRecord): boolean {
  return (typeof record.worktreePath === "string" && record.worktreePath.length > 0) ||
      (typeof record.lazyWorktreePath === "string" && record.lazyWorktreePath.length > 0) ||
      (typeof record.worktreeName === "string" && record.worktreeName.length > 0) ||
      record.startedWithWorktree === true || record.lazyWorktree === true || record.worktreeLazy === true ||
      (Array.isArray(record.folderWorktrees) && record.folderWorktrees.length > 0);
}

function isLocalCwd(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value &&
    !/[\x00-\x1f\x7f]/.test(value);
}

function refersToLocalSession(record: SessionRecord, transcriptIds: Set<string>): boolean {
  if (record.sessionType !== undefined && record.sessionType !== "code") return false;
  const id = record.cliSessionId;
  if (typeof id !== "string" || !UUID.test(id)) return false;
  if (transcriptIds.has(id)) return true;
  // 幽靈記錄須有有效 CLI UUID 與本機絕對路徑，且不得指向 worktree。
  return !hasWorktree(record) && isLocalCwd(record.cwd);
}

function directoryPaths(home: string, store: DesktopStore, accountId?: string, orgId?: string): string[] {
  return [
    home,
    path.join(home, "Library"),
    path.join(home, "Library", "Application Support"),
    store.userData,
    store.root,
    ...(accountId ? [path.join(store.root, accountId)] : []),
    ...(accountId && orgId ? [path.join(store.root, accountId, orgId)] : []),
    ...(accountId && orgId ? [path.join(store.root, accountId, orgId, "imported-staging")] : [])
  ];
}

async function inspectDirectory(
  home: string,
  canonicalHome: string,
  target: string,
  snapshots: Map<string, DirectoryState>,
  parentMissing: boolean
): Promise<boolean> {
  if (parentMissing) {
    snapshots.set(target, { path: target, missing: true });
    return false;
  }
  try {
    const info = await fs.lstat(target);
    const canonical = await fs.realpath(target);
    const expected = path.join(canonicalHome, path.relative(home, target));
    if (info.isSymbolicLink() || !info.isDirectory() || canonical !== expected ||
        (target !== home && info.uid !== process.getuid?.())) {
      throw new Error(`Claude Desktop session directory is not a physical user directory; cleanup stopped: ${target}`);
    }
    snapshots.set(target, { path: target, device: info.dev, inode: info.ino, mode: info.mode });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      snapshots.set(target, { path: target, missing: true });
      return false;
    }
    throw error;
  }
}

async function readDirectoryEntries(directory: string, counter: { value: number; deadline: number }) {
  const entries = [];
  const handle = await fs.opendir(directory);
  for await (const entry of handle) {
    counter.value += 1;
    if (counter.value > MAX_DIRECTORY_ENTRIES || performance.now() > counter.deadline) {
      throw new Error("Claude Desktop session inventory exceeds its resource limit; cleanup stopped.");
    }
    entries.push(entry);
  }
  return entries;
}

async function readSessionFile(
  file: string,
  filenameId: string,
  root: string,
  canonicalRoot: string,
  bytes: { value: number }
): Promise<FileSnapshot> {
  if (path.dirname(file) !== root) throw new Error(`Invalid Claude Desktop metadata path: ${file}`);
  const before = await fs.lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()) {
    throw new Error(`Refusing non-regular or hard-linked Claude Desktop metadata: ${file}`);
  }
  if (before.size > MAX_RECORD_BYTES) throw new Error(`Claude Desktop metadata exceeds the size limit: ${file}`);
  bytes.value += before.size;
  if (bytes.value > MAX_TOTAL_BYTES) throw new Error("Claude Desktop metadata inventory exceeds the size limit.");
  const expectedCanonicalPath = path.join(canonicalRoot, path.basename(file));
  if (await fs.realpath(file) !== expectedCanonicalPath) throw new Error(`Claude Desktop metadata path is redirected: ${file}`);

  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let contents: Buffer;
  let after;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      throw new Error(`Claude Desktop metadata changed while opening: ${file}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_RECORD_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_RECORD_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total > MAX_RECORD_BYTES) throw new Error(`Claude Desktop metadata exceeds the size limit: ${file}`);
    contents = Buffer.concat(chunks, total);
    after = await handle.stat();
  } finally {
    await handle.close();
  }
  const finalPath = await fs.lstat(file);
  if (after!.dev !== before.dev || after!.ino !== before.ino || after!.size !== before.size ||
      after!.mtimeMs !== before.mtimeMs || after!.nlink !== 1 || finalPath.dev !== before.dev ||
      finalPath.ino !== before.ino || finalPath.nlink !== 1 || await fs.realpath(file) !== expectedCanonicalPath) {
    throw new Error(`Claude Desktop metadata changed while reading: ${file}`);
  }
  let value: unknown;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents!);
    value = JSON.parse(decoded);
  }
  catch { throw new Error(`Invalid Claude Desktop session metadata JSON; cleanup stopped: ${file}`); }
  const record = validateRecord(value, filenameId, file);
  return {
    path: file, canonicalPath: expectedCanonicalPath, sessionId: record.sessionId, record,
    device: before.dev, inode: before.ino,
    modifiedMs: before.mtimeMs, sizeBytes: before.size, mode: before.mode, nlink: before.nlink,
    digest: createHash("sha256").update(contents!).digest("hex")
  };
}

async function scanStore(home: string, stores: DesktopStore[]): Promise<StoreSnapshot> {
  const directories = new Map<string, DirectoryState>();
  const files = new Map<string, FileSnapshot>();
  const directoryCount = { value: 0, deadline: performance.now() + 30_000 };
  const totalBytes = { value: 0 };
  const canonicalHome = await fs.realpath(home);

  for (const store of stores) {
    let missing = false;
    for (const directory of directoryPaths(home, store)) {
      const exists = await inspectDirectory(home, canonicalHome, directory, directories, missing);
      missing ||= !exists;
    }
    if (missing) continue;

    for (const account of await readDirectoryEntries(store.root, directoryCount)) {
      if (account.isSymbolicLink()) throw new Error(`Claude Desktop session storage contains a symbolic link: ${path.join(store.root, account.name)}`);
      if (!account.isDirectory() || !UUID.test(account.name)) continue;
      const accountPath = path.join(store.root, account.name);
      await inspectDirectory(home, canonicalHome, accountPath, directories, false);
      for (const org of await readDirectoryEntries(accountPath, directoryCount)) {
        if (org.isSymbolicLink()) throw new Error(`Claude Desktop session storage contains a symbolic link: ${path.join(accountPath, org.name)}`);
        if (!org.isDirectory() || !UUID.test(org.name)) continue;
        const orgPath = path.join(accountPath, org.name);
        await inspectDirectory(home, canonicalHome, orgPath, directories, false);
        const staging = path.join(orgPath, "imported-staging");
        const hasStaging = await inspectDirectory(home, canonicalHome, staging, directories, false);
        if (hasStaging && (await readDirectoryEntries(staging, directoryCount)).length) {
          throw new Error(`Claude Desktop has an unfinished transcript import; cleanup stopped: ${staging}`);
        }
        for (const entry of await readDirectoryEntries(orgPath, directoryCount)) {
          const file = path.join(orgPath, entry.name);
          if (entry.isSymbolicLink()) throw new Error(`Claude Desktop session storage contains a symbolic link: ${file}`);
          const match = /^local_(.+)\.json$/.exec(entry.name);
          if (!match) continue;
          if (!entry.isFile()) throw new Error(`Claude Desktop session record is not a regular file: ${file}`);
          if (files.size >= MAX_RECORDS) throw new Error("Claude Desktop session inventory exceeds the record limit.");
          const snapshot = await readSessionFile(file, entry.name.slice(0, -5), orgPath,
            path.join(canonicalHome, path.relative(home, orgPath)), totalBytes);
          files.set(file, snapshot);
        }
      }
    }
  }
  return { directories, files };
}

function sameDirectories(first: Map<string, DirectoryState>, second: Map<string, DirectoryState>): boolean {
  if (first.size !== second.size) return false;
  for (const [key, previous] of first) {
    const current = second.get(key);
    if (!current) return false;
    if ("missing" in previous || "missing" in current) {
      if (!("missing" in previous && "missing" in current)) return false;
    } else if (previous.device !== current.device || previous.inode !== current.inode || previous.mode !== current.mode) return false;
  }
  return true;
}

function sameFile(first: FileSnapshot, second: FileSnapshot): boolean {
  return first.path === second.path && first.canonicalPath === second.canonicalPath && first.sessionId === second.sessionId &&
    first.device === second.device && first.inode === second.inode && first.modifiedMs === second.modifiedMs &&
    first.sizeBytes === second.sizeBytes && first.mode === second.mode && first.nlink === second.nlink &&
    first.digest === second.digest;
}

function assertInventoryUnchanged(expected: StoreSnapshot, current: StoreSnapshot): void {
  if (!sameDirectories(expected.directories, current.directories) || expected.files.size !== current.files.size) {
    throw new Error("Claude Desktop session inventory changed after preview; refresh the list.");
  }
  for (const [file, previous] of expected.files) {
    const latest = current.files.get(file);
    if (!latest || !sameFile(previous, latest)) throw new Error(`Claude Desktop session metadata changed after preview: ${file}`);
  }
}

async function validateTargetDirectories(
  home: string,
  snapshot: StoreSnapshot,
  targets: string[]
): Promise<void> {
  const canonicalHome = await fs.realpath(home);
  const parents = new Set<string>();
  for (const target of targets) {
    for (let directory = path.dirname(target);; directory = path.dirname(directory)) {
      if (snapshot.directories.has(directory)) parents.add(directory);
      if (directory === home || directory === path.dirname(directory)) break;
    }
  }
  for (const directory of parents) {
    const expected = snapshot.directories.get(directory)!;
    let current;
    try { current = await fs.lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (!("missing" in expected)) throw new Error(`Claude Desktop session directory disappeared: ${directory}`);
        continue;
      }
      throw error;
    }
    if ("missing" in expected || current.isSymbolicLink() || !current.isDirectory() ||
        current.uid !== process.getuid?.() || current.dev !== expected.device || current.ino !== expected.inode ||
        current.mode !== expected.mode || await fs.realpath(directory) !==
          path.join(canonicalHome, path.relative(home, directory))) {
      throw new Error(`Claude Desktop session directory changed before metadata cleanup: ${directory}`);
    }
  }
}

export interface ClaudeDesktopPlan {
  entries: ScanEntry[];
  paths: string[];
  validate(): Promise<void>;
  validateFiles(paths: string[]): Promise<void>;
  assertComplete(): Promise<void>;
}

export async function prepareClaudeDesktop(home: string): Promise<ClaudeDesktopPlan> {
  if (!path.isAbsolute(home)) throw new Error("Claude Desktop home must be an absolute path.");
  const rootHome = path.resolve(home);
  assertDefaultDataRoots(["claude"], process.env, rootHome);
  const stores = storesFor(rootHome);
  const discovered = await discoverClaudeConversations(rootHome, createPathWalkBudget());
  const transcriptIds = new Set(discovered.conversations.map((conversation) => conversation.id));
  const snapshot = await scanStore(rootHome, stores);
  const planned = [...snapshot.files.values()].filter(({ record }) =>
    !preserveRemoteOrStaged(record) && refersToLocalSession(record, transcriptIds));
  const plannedByPath = new Map(planned.map((entry) => [entry.path, entry]));
  const entries: ScanEntry[] = planned.map((entry) => ({
    providerId: "claude",
    providerName: "Claude Code Desktop",
    pattern: "local Claude Desktop session metadata",
    path: entry.path,
    exists: true,
    sizeBytes: entry.sizeBytes,
    identity: {
      device: entry.device,
      inode: entry.inode,
      modifiedMs: entry.modifiedMs,
      sizeBytes: entry.sizeBytes,
      kind: "file",
      canonicalPath: entry.canonicalPath
    }
  }));
  const paths = stores.map((store) => store.root);
  const currentSnapshot = async () => {
    const current = await scanStore(rootHome, stores);
    assertInventoryUnchanged(snapshot, current);
    return current;
  };

  return {
    entries,
    paths,
    validate: async () => { await currentSnapshot(); },
    validateFiles: async (targets) => {
      const unique = [...new Set(targets)];
      if (!unique.length || unique.some((target) => !path.isAbsolute(target) || target !== path.resolve(target) ||
          !plannedByPath.has(target))) {
        throw new Error("Claude Desktop metadata is outside the preflight inventory.");
      }
      await validateTargetDirectories(rootHome, snapshot, unique);
      for (const target of unique) {
        const expected = plannedByPath.get(target)!;
        const root = path.dirname(expected.path);
        const actual = await readSessionFile(expected.path, expected.record.sessionId, root,
          path.join(await fs.realpath(rootHome), path.relative(rootHome, root)), { value: 0 });
        if (!actual || !sameFile(expected, actual)) {
          throw new Error(`Claude Desktop session metadata changed before Trash; refresh the list: ${expected.path}`);
        }
      }
    },
    assertComplete: async () => {
      const current = await scanStore(rootHome, stores);
      if (!sameDirectories(snapshot.directories, current.directories)) {
        throw new Error("Claude Desktop session directory changed during cleanup.");
      }
      for (const [file, original] of snapshot.files) {
        const remaining = current.files.get(file);
        if (plannedByPath.has(file)) {
          if (remaining) throw new Error(`Claude Desktop session metadata remains after cleanup: ${file}`);
        } else if (!remaining || !sameFile(original, remaining)) {
          throw new Error(`Retained Claude Desktop session metadata changed during cleanup: ${file}`);
        }
      }
      if (current.files.size !== snapshot.files.size - plannedByPath.size) {
        throw new Error("Claude Desktop session metadata was created during cleanup; completion cannot be confirmed.");
      }
      for (const transcript of discovered.conversations) {
        try {
          await fs.lstat(transcript.dataPaths[0]!);
          throw new Error(`Claude Code transcript remains after cleanup: ${transcript.dataPaths[0]}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  };
}
