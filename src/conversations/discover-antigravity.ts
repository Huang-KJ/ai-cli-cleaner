import { promises as fs } from "node:fs";
import path from "node:path";
import { consumePathWalkBudget, createPathWalkBudget, getPathSize, PathResourceLimitError, readDirectoryBounded,
  type PathWalkBudget } from "../fs/paths.js";
import { getProviderName } from "../cleaners/manifests.js";
import {
  antigravityDataPaths, antigravityDirectories, antigravityRoots,
  validateAntigravityDataPath, validateExactStoragePath
} from "./owned-paths.js";
import { assertConversationId } from "./types.js";
import { antigravityHistoryId, asIso, asString, cleanTitle, isRecord, toError } from "./metadata-values.js";
import { readJsonlLines } from "./metadata-jsonl.js";
import { withPrivateReadDatabase } from "./metadata-safety.js";
import { columnNames, quoteIdentifier, tableNames } from "./sqlite.js";
import type { ConversationDiscovery, ConversationRecord } from "./types.js";

interface ConversationMetadata {
  title?: string;
  updatedAt?: string;
  workspace?: string;
  disabledReason?: string;
  discoveredPaths?: Set<string>;
}

const PROVIDER_NAME = getProviderName("antigravity");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function discoverAntigravityConversations(
  home: string,
  walkBudget = createPathWalkBudget()
): Promise<ConversationDiscovery> {
  const warnings: string[] = [];
  const root = path.join(home, ".gemini");
  const baseNames = antigravityRoots;
  const bases = baseNames.map((name) => ({ name, path: path.join(root, name) }));
  const cliRoot = path.join(root, "antigravity-cli");
  const summaryDatabase = path.join(cliRoot, "conversation_summaries.db");
  const historyFile = path.join(cliRoot, "history.jsonl");
  const lastConversationsFile = path.join(cliRoot, "cache", "last_conversations.json");
  const sharedIndexes = bases.map((base) => path.join(base.path, "jetbox_summaries_proto.pb"));
  const ids = new Map<string, ConversationMetadata>();
  const issues: string[] = [];
  const baseChecks = await Promise.all(bases.map(({ name, path: base }) =>
    validateExactStoragePath(base, root, [name], "directory")
  ));
  for (const check of baseChecks) {
    if (check.status === "invalid") {
      const reason = `Antigravity storage root failed safety validation: ${check.reason}`;
      issues.push(reason);
      warnings.push(`${PROVIDER_NAME}: ${reason}`);
    }
  }
  try { await assertAntigravitySharedIndexSupported(home); }
  catch (error) {
    const reason = toError(error).message;
    issues.push(reason);
    warnings.push(`${PROVIDER_NAME}: ${reason}`);
  }

  const cliCheck = baseChecks[0];
  const metadataChecks = cliCheck?.status === "valid"
    ? await Promise.all([
        validateExactStoragePath(summaryDatabase, root, ["antigravity-cli", "conversation_summaries.db"], "file"),
        validateExactStoragePath(historyFile, root, ["antigravity-cli", "history.jsonl"], "file"),
        validateExactStoragePath(lastConversationsFile, root,
          ["antigravity-cli", "cache", "last_conversations.json"], "file")
      ])
    : [];
  for (const [index, check] of metadataChecks.entries()) {
    if (check.status === "invalid") {
      const file = [summaryDatabase, historyFile, lastConversationsFile][index];
      const reason = `Antigravity metadata failed safety validation: ${check.reason}`;
      issues.push(reason);
      warnings.push(`${PROVIDER_NAME}: ${file}: ${reason}`);
    }
  }

  const summaryCheck = metadataChecks[0];
  const historyCheck = metadataChecks[1];
  const recentCheck = metadataChecks[2];
  const readIssues: Array<string | undefined> = [];
  if (historyCheck?.status === "valid") {
    readIssues.push(await mergeHistory(ids, historyCheck.path, warnings));
  }
  if (summaryCheck?.status === "valid") {
    readIssues.push(await mergeSummaries(ids, summaryCheck.path, warnings, home));
  }
  if (recentCheck?.status === "valid") {
    readIssues.push(await mergeRecentConversations(ids, recentCheck.path, warnings));
  }
  issues.push(...readIssues.filter((value): value is string => Boolean(value)));
  await mergeStoredIds(ids, bases, root, warnings, issues, walkBudget);
  const globalDisabledReason = [...new Set(issues)].join("; ") || undefined;
  if (globalDisabledReason) {
    for (const metadata of ids.values()) metadata.disabledReason ??= globalDisabledReason;
  }

  const conversations: ConversationRecord[] = [];
  for (const [id, metadata] of ids) {
    consumePathWalkBudget(walkBudget, `${PROVIDER_NAME}:${id}`);
    const dataPaths: string[] = [];
    let sizeBytes = 0;
    for (const candidate of antigravityDataPaths(home, id)) {
      try {
        const validation = await validateAntigravityDataPath(candidate, id, home);
        if (validation.status === "missing") {
          if (metadata.discoveredPaths?.has(path.resolve(candidate))) {
            metadata.disabledReason ??= `Antigravity conversation data disappeared before safety validation; deletion disabled: ${candidate}`;
            warnings.push(`${PROVIDER_NAME}: conversation ${id} disabled: ${metadata.disabledReason}`);
          }
          continue;
        }
        if (validation.status === "invalid") {
          metadata.disabledReason ??= `Antigravity conversation path failed safety validation: ${validation.reason}`;
          warnings.push(`${PROVIDER_NAME}: conversation ${id} disabled: ${metadata.disabledReason}`);
          continue;
        }
        dataPaths.push(candidate);
        sizeBytes += await getPathSize(validation.path, { budget: walkBudget });
      } catch (error) {
        if (error instanceof PathResourceLimitError) throw error;
        metadata.disabledReason ??= `Cannot fully inspect Antigravity conversation path; deletion disabled: ${candidate}: ${toError(error).message}`;
        warnings.push(`${PROVIDER_NAME}: conversation ${id} disabled: ${metadata.disabledReason}`);
      }
    }
    const covered = new Set(dataPaths.map((candidate) => path.resolve(candidate)));
    const uncovered = [...metadata.discoveredPaths ?? []].filter((candidate) => !covered.has(candidate));
    if (uncovered.length > 0) {
      const reason = `Antigravity conversation contains unaccounted-for or unsupported data; deletion disabled: ${uncovered.join(", ")}`;
      metadata.disabledReason ??= reason;
      warnings.push(`${PROVIDER_NAME}: conversation ${id} disabled: ${reason}`);
    }
    conversations.push({
        key: `antigravity:${id}`,
        providerId: "antigravity",
        providerName: PROVIDER_NAME,
        id,
        title: cleanTitle(metadata.title, id),
        updatedAt: metadata.updatedAt,
        workspace: metadata.workspace,
        sizeBytes,
        dataPaths,
        guardPaths: [summaryDatabase, historyFile, lastConversationsFile, ...sharedIndexes],
        deleteStrategy: {
          kind: "local",
          metadata: {
            kind: "antigravity",
            summaryDatabase,
            historyFile,
            lastConversationsFile
          }
        },
        disabledReason: metadata.disabledReason,
        warnings: []
    });
  }
  conversations.sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.title.localeCompare(b.title)
  );
  return { conversations, warnings: [...new Set(warnings)] };
}

export async function assertAntigravitySharedIndexSupported(home: string): Promise<void> {
  const root = path.join(home, ".gemini");
  for (const name of antigravityRoots) {
    const check = await validateExactStoragePath(path.join(root, name, "jetbox_summaries_proto.pb"),
      root, [name, "jetbox_summaries_proto.pb"], "file");
    if (check.status === "missing") continue;
    if (check.status === "invalid") throw new Error(`Cannot safely validate the Antigravity shared index path: ${check.reason}`);
    if ((await fs.lstat(check.path)).size > 0) {
      throw new Error("Selected deletion is not supported for Antigravity shared protobuf indexes. Use Antigravity's built-in /resume interface to delete individual conversations. Bulk cleanup deletes all local conversations.");
    }
  }
}

export async function assertAntigravityPathsUnchanged(
  conversation: ConversationRecord,
  home: string,
  expectedPaths: string[] = conversation.dataPaths
): Promise<void> {
  assertConversationId(conversation.id);
  if (conversation.providerId !== "antigravity") throw new Error("Antigravity conversation target does not match.");
  const root = path.join(home, ".gemini");
  const names = antigravityRoots;
  const allowed = new Set(antigravityDataPaths(home, conversation.id)
    .map((candidate) => path.resolve(candidate)));
  const actual = new Set<string>();
  const walkBudget = createPathWalkBudget();
  // 只列舉所選 ID 的 storage 項目，不重新讀取其他對話或共用索引。
  for (const name of names) {
    for (const directory of antigravityDirectories) {
      const storage = path.join(root, name, directory);
      const check = await validateExactStoragePath(storage, root, [name, directory], "directory");
      if (check.status === "missing") continue;
      if (check.status === "invalid") throw new Error(`Cannot safely validate Antigravity storage: ${check.reason}`);
      for await (const entry of readDirectoryBounded(check.path, walkBudget)) {
        const candidate = path.resolve(storage, entry.name);
        if (uuidFromName(entry.name) !== conversation.id && !allowed.has(candidate)) continue;
        if (!allowed.has(candidate)) throw new Error(`Antigravity conversation contains unaccounted-for or unsupported data: ${candidate}`);
        const validation = await validateAntigravityDataPath(candidate, conversation.id, home);
        if (validation.status !== "valid") {
          throw new Error(validation.status === "invalid" ? validation.reason : `Antigravity conversation data disappeared before validation: ${candidate}`);
        }
        actual.add(candidate);
      }
    }
  }
  const expected = new Set(expectedPaths.map((candidate) => path.resolve(candidate)));
  if (actual.size !== expected.size || [...actual].some((candidate) => !expected.has(candidate))) {
    throw new Error("Antigravity conversation data was added or removed after discovery; refresh the conversation list.");
  }
}

async function mergeHistory(
  ids: Map<string, ConversationMetadata>, file: string, warnings: string[]
): Promise<string | undefined> {
  try {
    for await (const { line } of readJsonlLines(file)) {
      if (!line.trim()) continue;
      const record: unknown = JSON.parse(line);
      const id = antigravityHistoryId(record);
      if (!id || !UUID_PATTERN.test(id)) continue;
      if (!isRecord(record)) throw new Error("Antigravity history row must be an object.");
      const previous = ids.get(id);
      ids.set(id, {
        ...previous,
        title: previous?.title ?? asString(record.display),
        updatedAt: latest(previous?.updatedAt, asIso(record.timestamp)),
        workspace: previous?.workspace ?? asString(record.workspace)
      });
    }
    return undefined;
  } catch (error) {
    addWarning(warnings, file, error);
    return `Cannot read Antigravity history metadata: ${file}: ${toError(error).message}`;
  }
}

async function mergeSummaries(
  ids: Map<string, ConversationMetadata>, file: string, warnings: string[], home: string
): Promise<string | undefined> {
  try {
    await withPrivateReadDatabase(home, path.join(home, ".gemini"), file, (database) => {
      const rows = database.prepare(
        "SELECT conversation_id, title, preview, last_modified_time, workspace_uris FROM conversation_summaries"
      ).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const id = asString(row.conversation_id);
        if (!id || !UUID_PATTERN.test(id)) continue;
        const previous = ids.get(id);
        ids.set(id, {
          ...previous,
          title: asString(row.title) ?? asString(row.preview) ?? previous?.title,
          updatedAt: latest(previous?.updatedAt, asIso(row.last_modified_time)),
          workspace: asString(row.workspace_uris) ?? previous?.workspace
        });
      }
      for (const table of tableNames(database)) {
        if (table === "conversation_summaries" || !columnNames(database, table).has("conversation_id")) continue;
        for (const row of database.prepare(`SELECT DISTINCT conversation_id FROM ${quoteIdentifier(table)}`).all()) {
          const id = asString(row.conversation_id);
          if (id && UUID_PATTERN.test(id) && !ids.has(id)) ids.set(id, {});
        }
      }
    });
    return undefined;
  } catch (error) {
    addWarning(warnings, file, error);
    return `Cannot read Antigravity summary metadata: ${file}: ${toError(error).message}`;
  }
}

async function mergeRecentConversations(
  ids: Map<string, ConversationMetadata>, file: string, warnings: string[]
): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!isRecord(value)) throw new Error(`Unrecognized recent-conversation cache: ${file}`);
    for (const id of Object.values(value)) {
      if (typeof id === "string" && UUID_PATTERN.test(id) && !ids.has(id)) ids.set(id, {});
    }
    return undefined;
  } catch (error) {
    addWarning(warnings, file, error);
    return `Cannot read Antigravity recent-conversation metadata: ${file}: ${toError(error).message}`;
  }
}

async function mergeStoredIds(
  ids: Map<string, ConversationMetadata>,
  bases: Array<{ name: string; path: string }>,
  root: string,
  warnings: string[],
  issues: string[],
  walkBudget: PathWalkBudget
): Promise<void> {
  for (const base of bases) {
    for (const directory of antigravityDirectories) {
      const storage = path.join(base.path, directory);
      const validation = await validateExactStoragePath(storage, root, [base.name, directory], "directory");
      if (validation.status === "missing") continue;
      if (validation.status === "invalid") {
        const reason = `Cannot safely enumerate Antigravity storage: ${validation.reason}`;
        issues.push(reason);
        warnings.push(`${PROVIDER_NAME}: ${reason}`);
        continue;
      }
      try {
        for await (const entry of readDirectoryBounded(validation.path, walkBudget)) {
          const id = uuidFromName(entry.name);
          if (!id) continue;
          const itemPath = path.join(storage, entry.name);
          const previous = ids.get(id) ?? {};
          const discoveredPaths = new Set(previous.discoveredPaths ?? []);
          discoveredPaths.add(path.resolve(itemPath));
          ids.set(id, { ...previous, discoveredPaths });
          try {
            const info = await fs.lstat(itemPath);
            const current = ids.get(id) ?? {};
            const disabledReason = info.isSymbolicLink()
              ? `Antigravity conversation data is a symbolic link: ${itemPath}`
              : !info.isFile() && !info.isDirectory()
                ? `Antigravity conversation data is not a regular file or directory: ${itemPath}`
                : current.disabledReason;
            ids.set(id, {
              ...current,
              updatedAt: latest(current.updatedAt, info.mtime.toISOString()),
              disabledReason
            });
            if (disabledReason && !current.disabledReason) {
              warnings.push(`${PROVIDER_NAME}: conversation ${id} disabled: ${disabledReason}`);
            }
          } catch (error) {
            const reason = `Cannot inspect Antigravity conversation data: ${itemPath}: ${toError(error).message}`;
            const current = ids.get(id) ?? {};
            ids.set(id, { ...current, disabledReason: current.disabledReason ?? reason });
            warnings.push(`${PROVIDER_NAME}: conversation ${id} disabled: ${reason}`);
          }
        }
      } catch (error) {
        addWarning(warnings, storage, error);
        issues.push(`Cannot enumerate Antigravity storage ${storage}: ${toError(error).message}`);
      }
    }
  }
}

function uuidFromName(name: string): string | undefined {
  const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(name)?.[1];
  return id && UUID_PATTERN.test(id) ? id : undefined;
}

function latest(first: string | undefined, second: string | undefined): string | undefined {
  return [first, second].filter((value): value is string => Boolean(value)).sort().at(-1);
}

function addWarning(warnings: string[], source: string, error: unknown): void {
  warnings.push(`${PROVIDER_NAME}: cannot read ${source}: ${toError(error).message}`);
}
