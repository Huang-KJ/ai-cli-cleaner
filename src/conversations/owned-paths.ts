import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { ScanEntry } from "../cleaners/types.js";
import { containsPath, createPathWalkBudget, getCanonicalPath, getPathSnapshot, readDirectoryBounded } from "../fs/paths.js";
import { annotateSQLiteGroups } from "../fs/scan.js";
import { codexArtifactOwners, codexDirectArtifact, isCodexRolloutName, readCodexArtifactIds } from "./codex-artifacts.js";
import type { ConversationRecord } from "./types.js";
import { assertConversationId } from "./types.js";
import { firstDate, firstString, isRecord, toError } from "./metadata-values.js";

const MAX_ROLLOUT_HEADER_BYTES = 64 * 1024;
export const antigravityRoots = ["antigravity-cli", "antigravity-ide"] as const;
export const antigravityDirectories = [
  "brain", "conversations", "implicit", "annotations", "scratch",
  "html_artifacts", "code_tracker", "context_state"
] as const;
const ANTIGRAVITY_SUFFIXES = ["", ".pb", ".pbtxt", ".db", ".db-wal", ".db-shm", ".db-journal"];

export function antigravityDataPaths(home: string, id: string): string[] {
  assertConversationId(id);
  return antigravityRoots.flatMap((root) => antigravityDirectories.flatMap((directory) =>
    (directory === "brain" ? [id] : ANTIGRAVITY_SUFFIXES.map((suffix) => `${id}${suffix}`))
      .map((entry) => path.join(home, ".gemini", root, directory, entry))));
}

interface CodexRolloutHeader {
  id?: string;
  workspace?: string;
  updatedAt?: string;
}

export type CodexRolloutValidation =
  | { status: "valid"; path: string; header: CodexRolloutHeader }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

export type OwnedPathValidation =
  | { status: "valid"; path: string }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

async function readCodexRolloutHeader(file: string): Promise<CodexRolloutHeader> {
  const stream = createReadStream(file, {
    encoding: "utf8",
    highWaterMark: 16 * 1024
  });
  let line = "";
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const text = String(chunk);
      const end = text.indexOf("\n");
      const part = end < 0 ? text : text.slice(0, end);
      bytes += Buffer.byteLength(part, "utf8");
      if (bytes > MAX_ROLLOUT_HEADER_BYTES) {
        throw new Error(`The first rollout line exceeds the 64 KiB (${MAX_ROLLOUT_HEADER_BYTES} bytes) limit.`);
      }
      line += part;
      if (end >= 0) break;
    }
  } finally {
    stream.destroy();
  }
  if (!line.trim()) return {};

  const value: unknown = JSON.parse(line.replace(/\r$/, ""));
  if (!isRecord(value)) return {};
  const payload = isRecord(value.payload) ? value.payload : value;
  return {
    id: firstString(payload, ["id", "session_id", "thread_id"]),
    workspace: firstString(payload, ["cwd", "workspace"]),
    updatedAt: firstDate(payload, ["timestamp", "updated_at", "created_at"]) ??
      firstDate(value, ["timestamp"])
  };
}

export async function validateCodexRolloutPath(
  file: string,
  home: string,
  expectedId?: string
): Promise<CodexRolloutValidation> {
  const ownership = await inspectCodexRolloutStoragePath(file, home);
  if (ownership.status !== "valid") return ownership;

  let header: CodexRolloutHeader;
  try {
    header = await readCodexRolloutHeader(ownership.path);
  } catch (error) {
    return { status: "invalid", reason: `Cannot validate the first rollout line: ${toError(error).message}` };
  }
  if (!header.id) return { status: "invalid", reason: "The first rollout line is missing a complete conversation ID." };
  try {
    assertConversationId(header.id);
  } catch (error) {
    return { status: "invalid", reason: toError(error).message };
  }
  if (expectedId !== undefined && header.id !== expectedId) {
    return { status: "invalid", reason: `First rollout line ID does not match the conversation ID (${header.id}).` };
  }
  return { status: "valid", path: ownership.path, header };
}

export async function validateOwnedConversationPaths(
  conversation: ConversationRecord,
  home: string
): Promise<string[]> {
  if (conversation.providerId === "codex") {
    return (await validateCodexConversationsPaths([conversation], home)).get(conversation)!;
  }
  return validateOwnedPaths(conversation, home);
}

export async function validateCodexConversationsPaths(
  conversations: ConversationRecord[],
  home: string
): Promise<Map<ConversationRecord, string[]>> {
  const candidates = conversations.flatMap((conversation) => conversation.dataPaths.map((candidate) => ({ candidate, id: conversation.id })));
  const artifacts = await validateCodexArtifactPaths(candidates.filter(({ candidate }) => codexDirectArtifact(candidate, home)), home,
    conversations.map((conversation) => conversation.id));
  const invalid = artifacts.find((item) => item.status === "invalid");
  if (invalid?.status === "invalid") throw new Error(invalid.reason);
  const output = new Map<ConversationRecord, string[]>();
  // 完整歸屬已在本階段批次確認；接著維持逐路徑物理及 rollout 驗證。
  for (const conversation of conversations) output.set(conversation, await validateOwnedPaths(conversation, home));
  return output;
}

async function validateOwnedPaths(conversation: ConversationRecord, home: string): Promise<string[]> {
  assertConversationId(conversation.id);
  const strategy = conversation.deleteStrategy;
  if (strategy.kind !== "local") {
    throw new Error("validateOwnedConversationPaths only supports local deletion strategies.");
  }
  if (
    (conversation.providerId === "codex" && strategy.metadata?.kind !== "codex") ||
    (conversation.providerId === "copilot" && strategy.metadata?.kind !== "copilot") ||
    (conversation.providerId === "antigravity" && strategy.metadata?.kind !== "antigravity")
  ) {
    throw new Error("Conversation provider does not match the local deletion strategy.");
  }

  const output = new Set<string>();
  for (const candidate of new Set(conversation.dataPaths)) {
    if (!path.isAbsolute(candidate)) throw new Error(`Refusing a non-absolute data path: ${candidate}`);
    let canonical: string | undefined;
    if (conversation.providerId === "codex") {
      canonical = await validateCodexDataPath(candidate, conversation.id, home);
    } else if (conversation.providerId === "copilot") {
      const validation = await validateCopilotDataPath(candidate, conversation.id, home);
      if (validation.status === "invalid") throw new Error(validation.reason);
      canonical = validation.status === "valid" ? validation.path : undefined;
    } else if (conversation.providerId === "antigravity") {
      const validation = await validateAntigravityDataPath(candidate, conversation.id, home);
      if (validation.status === "invalid") throw new Error(validation.reason);
      canonical = validation.status === "valid" ? validation.path : undefined;
    } else {
      throw new Error("Local conversation path validation is not supported for this provider.");
    }
    if (canonical) output.add(canonical);
  }
  return [...output];
}

// 所選對話可能在清單顯示後新增逐字稿或產物；只比較其完整資料範圍。
export async function assertLocalConversationPathsUnchanged(
  conversation: ConversationRecord,
  home: string,
  expectedPaths: string[] = conversation.dataPaths
): Promise<void> {
  assertConversationId(conversation.id);
  if (conversation.providerId === "codex") {
    return assertCodexConversationsPathsUnchanged([conversation], home, new Map([[conversation.id, expectedPaths]]));
  }
  const actual = new Set<string>();
  if (conversation.providerId === "copilot") {
    const directory = path.join(home, ".copilot", "session-state", conversation.id);
    const checked = await validateCopilotDataPath(directory, conversation.id, home);
    if (checked.status === "invalid") throw new Error(checked.reason);
    if (checked.status === "valid") actual.add(checked.path);
  } else {
    throw new Error("Local conversation scope checks only support Codex and Copilot.");
  }
  const expected = new Set(await Promise.all(expectedPaths.map((file) => getCanonicalPath(file))));
  if (actual.size !== expected.size || [...actual].some((file) => !expected.has(file))) {
    throw new Error("Conversation data was added or removed after discovery; refresh the conversation list.");
  }
}

// 每個檢查階段只掃描儲存區一次，同時核對所有所選對話。
export async function assertCodexConversationsPathsUnchanged(
  conversations: ConversationRecord[],
  home: string,
  expectedPaths: ReadonlyMap<string, string[]> = new Map(conversations.map((item) => [item.id, item.dataPaths]))
): Promise<void> {
  const actual = new Map<string, Set<string>>();
  const rolloutIds = new Set<string>();
  const rolloutIssues: string[] = [];
  for (const conversation of conversations) {
    assertConversationId(conversation.id);
    if (conversation.providerId !== "codex") throw new Error("Codex batch scope checks cannot include other agents.");
    actual.set(conversation.id, new Set());
  }
  const root = path.join(home, ".codex");
  const budget = createPathWalkBudget();
  const list = async (parts: string[]): Promise<import("node:fs").Dirent[]> => {
    const checked = await validateExactStoragePath(path.join(root, ...parts), root, parts, "directory");
    if (checked.status === "missing") return [];
    if (checked.status === "invalid") throw new Error(checked.reason);
    const entries: import("node:fs").Dirent[] = [];
    for await (const entry of readDirectoryBounded(checked.path, budget, parts.length - 1)) entries.push(entry);
    return entries;
  };
  const rollouts = async (parts: string[]): Promise<void> => {
    for (const entry of await list(parts)) {
      const file = path.join(root, ...parts, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Codex rollout storage contains a symbolic link; the complete conversation scope cannot be confirmed: ${file}`);
      if (entry.isDirectory()) {
        await rollouts([...parts, entry.name]);
      } else if (isCodexRolloutName(entry.name)) {
        const checked = await validateCodexRolloutPath(file, home);
        if (checked.status === "valid" && checked.header.id) {
          rolloutIds.add(checked.header.id);
          actual.get(checked.header.id)?.add(checked.path);
        } else rolloutIssues.push(checked.status === "invalid" ? checked.reason : `Codex rollout disappeared: ${file}`);
        // 檔名明確指向所選 ID 時，不能把無法讀取的副本當成無關檔案。
        const rolloutName = entry.name.slice(0, -6);
        const identifies = conversations.some((item) => rolloutName === item.id || rolloutName.endsWith(`-${item.id}`));
        if (identifies && checked.status !== "valid") {
          throw new Error(checked.status === "invalid" ? checked.reason : `Codex rollout disappeared before validation: ${file}`);
        }
      }
    }
  };
  await rollouts(["sessions"]);
  await rollouts(["archived_sessions"]);
  const direct = await Promise.all(["generated_images", "visualizations", "shell_snapshots"].map(async (name) => ({ name, entries: await list([name]) })));
  const selectedIds = new Set(actual.keys());
  const ownershipRisk = direct.some(({ name, entries }) => name !== "generated_images" &&
    entries.some((entry) => codexArtifactOwners(entry.name, selectedIds).length > 0));
  if (ownershipRisk && rolloutIssues.length) throw new Error(`Cannot determine complete Codex artifact ownership: ${rolloutIssues.join("; ")}`);
  const knownIds = ownershipRisk ? await readCodexArtifactIds(home, [...selectedIds], rolloutIds) : selectedIds;
  const addArtifact = async (file: string, id: string): Promise<void> => {
    const checked = await validateCodexArtifactPathWithIds(file, id, home, knownIds);
    if (checked.status === "invalid") throw new Error(checked.reason);
    if (checked.status === "valid") actual.get(id)!.add(checked.path);
  };
  for (const { name, entries } of direct) {
    for (const entry of entries) {
      const owners = name === "generated_images" ? (selectedIds.has(entry.name) ? [entry.name] : [])
        : codexArtifactOwners(entry.name, knownIds);
      for (const id of owners.filter((owner) => selectedIds.has(owner))) {
        await addArtifact(path.join(root, name, entry.name), id);
      }
    }
  }
  for (const year of (await list(["visualizations"])).filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))) {
    for (const month of (await list(["visualizations", year.name])).filter((entry) => entry.isDirectory() && isValidStorageMonth(entry.name))) {
      for (const day of (await list(["visualizations", year.name, month.name])).filter((entry) => entry.isDirectory() && isValidStorageDate(year.name, month.name, entry.name))) {
        for (const entry of await list(["visualizations", year.name, month.name, day.name])) {
          if (actual.has(entry.name)) {
            await addArtifact(path.join(root, "visualizations", year.name, month.name, day.name, entry.name), entry.name);
          }
        }
      }
    }
  }
  for (const { id } of conversations) {
    await addArtifact(path.join(root, "thread-writer-locks", `${id}.lock`), id);
    const expected = new Set(await Promise.all((expectedPaths.get(id) ?? []).map((file) => getCanonicalPath(file))));
    const found = actual.get(id)!;
    if (found.size !== expected.size || [...found].some((file) => !expected.has(file))) {
      throw new Error(`Data for conversation ${id} was added or removed after discovery; refresh the conversation list.`);
    }
  }
}

async function validateCodexDataPath(
  candidate: string,
  id: string,
  home: string
): Promise<string | undefined> {
  const rollout = await validateCodexRolloutPath(candidate, home, id);
  if (rollout.status === "valid") return rollout.path;
  if (rollout.status === "missing") return undefined;
  const artifact = await validateCodexArtifactPathWithIds(candidate, id, home);
  if (artifact.status === "valid") return artifact.path;
  if (artifact.status === "missing") return undefined;
  if (rollout.status === "invalid") throw new Error(rollout.reason);
  throw new Error(artifact.reason);
}

export async function validateCopilotDataPath(
  candidate: string,
  id: string,
  home: string
): Promise<OwnedPathValidation> {
  const root = path.join(home, ".copilot", "session-state");
  if (path.resolve(candidate) !== path.join(path.resolve(root), id)) {
    return { status: "invalid", reason: `Copilot path must be the session-state directory for the specified ID: ${candidate}` };
  }
  const result = await validateExactStoragePath(candidate, path.join(home, ".copilot"), ["session-state", id], "directory");
  return result;
}

export async function validateAntigravityDataPath(
  candidate: string,
  id: string,
  home: string
): Promise<OwnedPathValidation> {
  for (const expected of antigravityDataPaths(home, id)) {
    if (path.resolve(candidate) !== path.resolve(expected)) continue;
    const root = path.join(home, ".gemini");
    const parts = path.relative(root, expected).split(path.sep);
    return validateExactStoragePath(candidate, root, parts, parts[1] === "brain" ? "directory" : "either");
  }
  return { status: "invalid", reason: `Antigravity path does not exactly match the conversation ID: ${candidate}` };
}

export interface CodexArtifactCandidate { candidate: string; id: string }

// 安全匯出函式自行讀取完整清單；額外的 selected IDs 只能增加碰撞，不能略過磁碟證據。
export async function validateCodexArtifactPaths(
  candidates: CodexArtifactCandidate[],
  home: string,
  selectedIds: readonly string[] = []
): Promise<OwnedPathValidation[]> {
  const checked = await Promise.all(candidates.map(({ candidate, id }) => {
    assertConversationId(id);
    return validateCodexArtifactPathWithIds(candidate, id, home);
  }));
  const risky = candidates.filter(({ candidate }, index) => checked[index]?.status === "valid" && codexDirectArtifact(candidate, home));
  if (!risky.length) return checked;
  let ids: Set<string>;
  try {
    ids = await readCodexArtifactIds(home, [...selectedIds, ...candidates.map(({ id }) => id)]);
  } catch (error) {
    return checked.map((item, index) => item.status === "valid" && codexDirectArtifact(candidates[index]!.candidate, home)
      ? { status: "invalid", reason: `Cannot determine complete Codex artifact ownership: ${toError(error).message}` } : item);
  }
  return Promise.all(candidates.map(({ candidate, id }) => validateCodexArtifactPathWithIds(candidate, id, home, ids)));
}

export async function validateCodexArtifactPath(candidate: string, id: string, home: string): Promise<OwnedPathValidation> {
  return (await validateCodexArtifactPaths([{ candidate, id }], home))[0]!;
}

async function validateCodexArtifactPathWithIds(
  candidate: string,
  id: string,
  home: string,
  knownIds?: ReadonlySet<string>
): Promise<OwnedPathValidation> {
  const base = path.join(home, ".codex");
  const directRoots = ["generated_images", "visualizations", "shell_snapshots"];
  for (const rootName of directRoots) {
    const relative = path.relative(path.resolve(path.join(base, rootName)), path.resolve(candidate));
    const expectedName = relative;
    if (
      expectedName && !expectedName.includes(path.sep) &&
      (rootName === "generated_images" ? expectedName === id : codexArtifactOwners(expectedName, new Set([id])).length > 0)
    ) {
      const result = await validateExactStoragePath(candidate, base, [rootName, expectedName], "either");
      if (result.status === "valid" && rootName === "visualizations" && /^\d{4}$/.test(expectedName) &&
          (await fs.lstat(result.path)).isDirectory()) {
        return { status: "invalid", reason: "Codex visualization year containers cannot belong to a single conversation." };
      }
      if (result.status === "valid" && rootName !== "generated_images" && knownIds) {
        const owners = codexArtifactOwners(expectedName, knownIds);
        if (owners.length !== 1 || owners[0] !== id) {
          return { status: "invalid", reason: `Ambiguous Codex artifact ownership for ${candidate}: ${owners.join(", ")}` };
        }
      }
      return result;
    }
  }

  const lockPath = path.join(base, "thread-writer-locks", `${id}.lock`);
  if (path.resolve(candidate) === path.resolve(lockPath)) {
    const result = await validateExactStoragePath(candidate, base, ["thread-writer-locks", `${id}.lock`], "file");
    return result;
  }

  const visualizationRoot = path.join(base, "visualizations");
  const relative = path.relative(path.resolve(visualizationRoot), path.resolve(candidate));
  const parts = relative.split(path.sep);
  if (
    parts.length === 4 && isValidStorageDate(parts[0] ?? "", parts[1] ?? "", parts[2] ?? "") &&
    parts[3] === id
  ) {
    const result = await validateExactStoragePath(candidate, base, ["visualizations", ...parts], "either");
    return result;
  }
  return { status: "invalid", reason: `Codex data path does not belong to the specified conversation: ${candidate}` };
}

async function inspectCodexRolloutStoragePath(
  candidate: string,
  home: string,
): Promise<{ status: "valid"; path: string } | { status: "missing" } | { status: "invalid"; reason: string }> {
  if (!path.isAbsolute(candidate)) {
    return { status: "invalid", reason: `Rollout path must be absolute: ${candidate}` };
  }
  const storage = ["sessions", "archived_sessions"].find((name) => {
    const root = path.join(home, ".codex", name);
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) && isCodexRolloutName(relative);
  });
  if (!storage) return { status: "invalid", reason: `Rollout path is outside .codex/sessions or archived_sessions: ${candidate}` };
  const relative = path.relative(path.resolve(path.join(home, ".codex", storage)), path.resolve(candidate));
  const inspected = await validateExactStoragePath(candidate, path.join(home, ".codex"), [storage, ...relative.split(path.sep)], "file");
  if (inspected.status === "invalid") return inspected;
  if (inspected.status === "missing") return inspected;
  return { status: "valid", path: inspected.path };
}

export async function validateExactStoragePath(
  candidate: string,
  base: string,
  relativeParts: string[],
  expectedKind: "file" | "directory" | "either"
): Promise<OwnedPathValidation> {
  if (!path.isAbsolute(candidate) || relativeParts.some((part) => !part || part === "." || part === "..")) {
    return { status: "invalid", reason: `Invalid data path format: ${candidate}` };
  }
  const canonicalHome = await fs.realpath(path.dirname(base)).catch(() => path.resolve(path.dirname(base)));
  const relativeBase = path.relative(path.resolve(path.dirname(base)), path.resolve(base));
  const root = path.resolve(path.dirname(base), relativeBase);
  let current = root;
  try {
    const rootInfo = await fs.lstat(current);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      return { status: "invalid", reason: `Refusing a symbolic link or non-directory storage root: ${current}` };
    }
    for (const part of relativeParts) {
      current = path.join(current, part);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (isMissing(error)) return { status: "missing" };
        throw error;
      }
      if (info.isSymbolicLink()) return { status: "invalid", reason: `Refusing a symbolic link data path: ${current}` };
      if (current !== path.resolve(candidate) && !info.isDirectory()) {
        return { status: "invalid", reason: `An intermediate data path component is not a directory: ${current}` };
      }
      if (current === path.resolve(candidate)) {
        const isFile = info.isFile();
        const isDirectory = info.isDirectory();
        if (expectedKind === "file" && !isFile) {
          return { status: "invalid", reason: `Data path must be a regular file: ${current}` };
        }
        if (expectedKind === "directory" && !isDirectory) {
          return { status: "invalid", reason: `Data path must be a directory: ${current}` };
        }
        if (expectedKind === "either" && !isFile && !isDirectory) {
          return { status: "invalid", reason: `Refusing a special-file data path: ${current}` };
        }
      }
    }
    const canonicalPath = await fs.realpath(candidate);
    const canonicalRoot = path.resolve(canonicalHome, relativeBase);
    const expectedCanonicalPath = path.resolve(canonicalRoot, ...relativeParts);
    if (canonicalPath !== expectedCanonicalPath) {
      return { status: "invalid", reason: `Canonical path was redirected: ${candidate}` };
    }
    return { status: "valid", path: canonicalPath };
  } catch (error) {
    if (isMissing(error)) return { status: "missing" };
    return { status: "invalid", reason: `Cannot validate data path ${candidate}: ${toError(error).message}` };
  }
}

export function isValidStorageMonth(value: string): boolean {
  return /^(0[1-9]|1[0-2])$/.test(value);
}

export function isValidStorageDate(year: string, month: string, day: string): boolean {
  if (!/^\d{4}$/.test(year) || !isValidStorageMonth(month) || !/^([0-2]\d|3[01])$/.test(day)) return false;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export async function scanConversationPaths(
  conversation: ConversationRecord,
  home: string
): Promise<ScanEntry[]> {
  return snapshotConversationPaths(conversation, await validateOwnedConversationPaths(conversation, home));
}

export async function snapshotConversationPaths(
  conversation: ConversationRecord,
  paths: string[]
): Promise<ScanEntry[]> {
  const entries: ScanEntry[] = [];
  for (const entryPath of paths) {
    const canonicalPath = await getCanonicalPath(entryPath);
    const snapshot = await getPathSnapshot(entryPath);
    entries.push({
      providerId: conversation.providerId,
      providerName: conversation.providerName,
      pattern: `conversation:${conversation.id}`,
      path: entryPath,
      exists: snapshot !== undefined,
      sizeBytes: snapshot?.sizeBytes ?? 0,
      identity: snapshot ? { ...snapshot.identity, canonicalPath } : undefined
    });
  }
  annotateSQLiteGroups(entries);
  return entries;
}

export async function assertSafeHomePaths(
  paths: string[],
  home: string,
  operation: string
): Promise<void> {
  const canonicalHome = await getCanonicalPath(home);
  for (const entryPath of paths) {
    if (!path.isAbsolute(entryPath) || entryPath === home || entryPath === canonicalHome ||
      (!containsPath(home, entryPath) && !containsPath(canonicalHome, entryPath))) {
      throw new Error(`Refusing to ${operation} a path outside the home directory: ${entryPath}`);
    }
    const canonicalPath = await getCanonicalPath(entryPath);
    if (canonicalPath === canonicalHome || !containsPath(canonicalHome, canonicalPath)) {
      throw new Error(`Refusing to ${operation} a path that resolves outside the home directory: ${entryPath}`);
    }
  }
}
