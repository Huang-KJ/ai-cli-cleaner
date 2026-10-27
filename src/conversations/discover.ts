import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getProviderName } from "../cleaners/manifests.js";
import type { ProviderId } from "../cleaners/types.js";
import { consumePathWalkBudget, containsPath, createPathWalkBudget, getCanonicalPath, getPathSize, pathExists, readDirectoryBounded,
  PathResourceLimitError, type PathWalkBudget } from "../fs/paths.js";
import { assertKnownCodexDatabases, codexMetadataFiles, getCodexMetadataPaths } from "./codex-paths.js";
import { codexArtifactOwners, codexJsonlId, isCodexRolloutName } from "./codex-artifacts.js";
import { readCodexResidualIds } from "./codex-inventory.js";
import { discoverAntigravityConversations } from "./discover-antigravity.js";
import { discoverClaudeConversations } from "./claude.js";
import {
  validateCodexRolloutPath,
  validateCodexArtifactPaths,
  validateCopilotDataPath,
  validateExactStoragePath,
  isValidStorageDate,
  isValidStorageMonth
} from "./owned-paths.js";
import { readOpenCodeSessions } from "./opencode.js";
import { assertGrokSummaryOwnership } from "./grok.js";
import { readJsonlLines } from "./metadata-jsonl.js";
import { withPrivateReadDatabase } from "./metadata-safety.js";
import { columnNames, tableExists } from "./sqlite.js";
import { asIso, asString, cleanTitle, firstDate, firstString, isRecord, toError } from "./metadata-values.js";
import { assertConversationId } from "./types.js";
import type {
  ConversationDeleteStrategy,
  ConversationDiscovery,
  ConversationRecord
} from "./types.js";

export interface DiscoverConversationOptions {
  home?: string;
  includeMemories?: boolean;
}

interface Candidate {
  providerId: ProviderId;
  providerName: string;
  id: string;
  title: string;
  parentId?: string;
  updatedAt?: string;
  workspace?: string;
  dataPaths: string[];
  guardPaths: string[];
  deleteStrategy: ConversationDeleteStrategy;
  warnings?: string[];
  disabledReason?: string;
  sizeKnown?: boolean;
}

interface CodexSeed {
  id: string;
  title: string;
  updatedAt?: string;
  workspace?: string;
  dataPaths: string[];
  disabledReason?: string;
}

export async function discoverConversations(
  targets: ProviderId[],
  options: DiscoverConversationOptions = {}
): Promise<ConversationDiscovery> {
  const home = options.home ?? homedir();
  const warnings: string[] = [];
  const conversations: ConversationRecord[] = [];

  for (const target of [...new Set(targets)]) {
    try {
      const walkBudget = createPathWalkBudget();
      if (target === "claude") {
        const result = await discoverClaudeConversations(home, walkBudget);
        conversations.push(...result.conversations);
        warnings.push(...result.warnings);
        continue;
      }
      if (target === "antigravity") {
        const result = await discoverAntigravityConversations(home, walkBudget);
        conversations.push(...result.conversations);
        warnings.push(...result.warnings);
        continue;
      }
      const candidates = target === "codex"
        ? await discoverCodex(home, warnings, walkBudget, options.includeMemories)
        : target === "copilot"
          ? await discoverCopilot(home, warnings, walkBudget)
          : target === "opencode"
            ? await discoverOpenCode(home)
            : await discoverGrok(home, warnings, walkBudget);
      const providerConversations: ConversationRecord[] = [];
      for (const candidate of candidates) {
        consumePathWalkBudget(walkBudget, `${candidate.providerId}:${candidate.id}`);
        const safePaths: string[] = [];
        let sizeBytes = 0;
        let disabledReason = candidate.disabledReason;
        for (const candidatePath of [...new Set(candidate.dataPaths)]) {
          try {
            const info = await fs.lstat(candidatePath);
            if (info.isSymbolicLink()) {
              disabledReason ??= `Candidate data path is a symbolic link; deletion disabled: ${candidatePath}`;
              warnings.push(`${candidate.providerName}: ${disabledReason}`);
              continue;
            }
            if (candidate.providerId === "copilot") {
              const validation = await validateCopilotDataPath(candidatePath, candidate.id, home);
              if (validation.status !== "valid") {
                disabledReason ??= validation.status === "invalid"
                  ? `Candidate data path failed safety validation: ${validation.reason}`
                  : `Candidate data path disappeared before validation: ${candidatePath}`;
                warnings.push(`${candidate.providerName}: ${disabledReason}`);
                continue;
              }
            }
            if (candidate.providerId !== "codex" && !(await isSafeHomePath(candidatePath, home))) {
              disabledReason ??= `Candidate data path is outside the home directory; deletion disabled: ${candidatePath}`;
              warnings.push(`${candidate.providerName}: ${disabledReason}`);
              continue;
            }
            safePaths.push(candidatePath);
            sizeBytes += await getPathSize(candidatePath, { budget: walkBudget });
          } catch (error) {
            if (error instanceof PathResourceLimitError) throw error;
            disabledReason ??= `Cannot fully inspect candidate data path; deletion disabled: ${candidatePath}: ${toError(error).message}`;
            warnings.push(`${candidate.providerName}: ${disabledReason}`);
          }
        }
        providerConversations.push({
          key: `${candidate.providerId}:${candidate.id}`,
          providerId: candidate.providerId,
          providerName: candidate.providerName,
          id: candidate.id,
          title: cleanTitle(candidate.title, candidate.id),
          parentId: candidate.parentId,
          updatedAt: candidate.updatedAt,
          workspace: candidate.workspace,
          sizeBytes,
          sizeKnown: candidate.sizeKnown,
          dataPaths: safePaths,
          guardPaths: [...new Set(candidate.guardPaths)],
          deleteStrategy: candidate.deleteStrategy,
          disabledReason,
          warnings: [...new Set(candidate.warnings ?? [])]
        });
      }
      conversations.push(...providerConversations);
    } catch (error) {
      warnings.push(`${getProviderName(target)}: ${toError(error).message}`);
    }
  }

  conversations.sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
    a.providerName.localeCompare(b.providerName) ||
    a.title.localeCompare(b.title)
  );
  return { conversations, warnings: [...new Set(warnings)] };
}

async function discoverCodex(
  home: string,
  warnings: string[],
  walkBudget: PathWalkBudget,
  includeMemories = false
): Promise<Candidate[]> {
  const root = path.join(home, ".codex");
  try {
    const rootInfo = await fs.lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      warnings.push(`Codex: refusing a symbolic link or non-directory storage root ${root}`);
      return [];
    }
  } catch (error) {
    if (isCommandMissing(error)) return [];
    throw error;
  }
  await assertKnownCodexDatabases(home);
  const metadata = {
    kind: "codex" as const,
    ...getCodexMetadataPaths(home, { includeMemories })
  };
  const { stateDatabase, sessionIndex } = metadata;
  const index = await isNormalCodexFile(root, sessionIndex, warnings)
    ? await readCodexSessionIndex(sessionIndex)
    : { titles: new Map<string, string>(), disabledReason: undefined };
  const titles = index.titles;
  const seeds = new Map<string, CodexSeed>();
  let indexDisabledReason = index.disabledReason;
  if (indexDisabledReason) warnings.push(indexDisabledReason);
  for (const [id, title] of titles) {
    try {
      assertConversationId(id);
      getCodexSeed(seeds, id, title);
    } catch (error) {
      indexDisabledReason ??= `Codex session index contains a conversation ID that cannot be validated; deletion disabled: ${toError(error).message}`;
      warnings.push(indexDisabledReason);
    }
  }

  if (await isNormalCodexFile(root, stateDatabase, warnings)) {
    try {
      await withPrivateReadDatabase(home, root, stateDatabase, async (database) => {
        if (tableExists(database, "threads")) {
          const rows = database.prepare("SELECT * FROM threads").all() as Array<Record<string, unknown>>;
          for (const row of rows) {
            try {
              const id = firstString(row, ["id", "thread_id"]);
              if (!id) continue;
              assertConversationId(id);
              const seed = getCodexSeed(seeds, id, titles.get(id) ?? firstString(row, ["title", "name"]) ?? id);
              seed.updatedAt ??= firstDate(row, ["updated_at", "created_at"]);
              seed.workspace ??= firstString(row, ["cwd", "workspace"]);
              const rolloutPath = asString(row.rollout_path);
              if (rolloutPath) {
                const validation = await validateCodexRolloutPath(rolloutPath, home, id);
                if (validation.status === "valid") seed.dataPaths.push(rolloutPath);
                else if (validation.status === "invalid") {
                  seed.disabledReason ??= `Codex rollout path failed safety validation: ${validation.reason}`;
                  warnings.push(`Codex: conversation ${id} disabled: ${validation.reason}`);
                }
              }
            } catch (error) {
              warnings.push(`Codex: cannot validate state database thread: ${toError(error).message}`);
            }
          }
        }
      });
    } catch (error) {
      indexDisabledReason ??= `Codex: cannot read ${stateDatabase}; deletion disabled: ${toError(error).message}`;
      warnings.push(indexDisabledReason);
    }
  }

  if (metadata.appDatabase && await isNormalCodexFile(root, metadata.appDatabase, warnings)) {
    try {
      await withPrivateReadDatabase(home, root, metadata.appDatabase, (database) => {
        for (const table of ["local_thread_catalog", "thread_timeline_ledger", "local_thread_catalog_scan_entries", "live_visualization_suggestions"]) {
          if (!tableExists(database, table)) continue;
          const columns = columnNames(database, table);
          if (!columns.has("thread_id")) throw new Error(`Codex ${table} is missing a complete thread_id column.`);
          const query = columns.has("host_id")
            ? `SELECT * FROM "${table}" WHERE host_id = 'local' OR host_id LIKE 'local:%'`
            : `SELECT * FROM "${table}"`;
          for (const row of database.prepare(query).all()) {
            if (typeof row.thread_id !== "string") throw new Error(`Codex ${table}.thread_id must be a string.`);
            assertConversationId(row.thread_id);
            const seed = getCodexSeed(seeds, row.thread_id, titles.get(row.thread_id) ?? firstString(row, ["title", "thread_name"]) ?? row.thread_id);
            seed.updatedAt ??= firstDate(row, ["updated_at", "created_at"]);
            seed.workspace ??= firstString(row, ["cwd", "workspace"]);
          }
        }
      });
    } catch (error) {
      indexDisabledReason ??= `Codex: cannot fully read the app's local conversation index; deletion disabled: ${toError(error).message}`;
      warnings.push(indexDisabledReason);
    }
  }

  if (metadata.historyFile && await isNormalCodexFile(root, metadata.historyFile, warnings)) {
    try {
      for await (const { line } of readJsonlLines(metadata.historyFile)) {
        if (!line.trim()) continue;
        try {
          const row: unknown = JSON.parse(line);
          if (!isRecord(row)) continue;
          const id = codexJsonlId(row, "history");
          const seed = getCodexSeed(seeds, id, firstString(row, ["display", "text"]) ?? id);
          seed.updatedAt ??= firstDate(row, ["timestamp", "updated_at", "created_at"]);
        } catch (error) {
          warnings.push(`Codex: cannot validate history record: ${toError(error).message}`);
        }
      }
    } catch (error) {
      const reason = `Codex history metadata cannot be completely read; deletion disabled: ${toError(error).message}`;
      warnings.push(`Codex: ${reason}`);
      indexDisabledReason ??= reason;
      // 未完成讀取時，不能將已讀取的部分索引當成完整刪除範圍。
      for (const seed of seeds.values()) seed.disabledReason ??= reason;
    }
  }

  for (const directory of ["sessions", "archived_sessions"]) {
    const sessionRoot = path.join(root, directory);
    const files = await walkCodexRollouts(root, sessionRoot, warnings, walkBudget);
    for (const file of files) {
      const validation = await validateCodexRolloutPath(file, home);
      if (validation.status === "missing") continue;
      if (validation.status === "invalid") {
        warnings.push(`Codex: skipping rollout ${file} that failed validation: ${validation.reason}`);
        continue;
      }
      const info = validation.header;
      if (!info.id) continue;
      const seed = getCodexSeed(seeds, info.id, titles.get(info.id) ?? info.id);
      seed.dataPaths.push(file);
      seed.updatedAt ??= info.updatedAt;
      seed.workspace ??= info.workspace;
    }
  }
  const residual = await readCodexResidualIds(home, metadata, { includeMemories });
  warnings.push(...residual.warnings);
  for (const id of residual.ids) getCodexSeed(seeds, id, titles.get(id) ?? id);
  const artifactIndex = await indexCodexArtifacts(root, [...seeds.keys()], warnings, walkBudget);
  const artifactCandidates = [...seeds.values()].flatMap((seed) => [...new Set([
    path.join(root, "generated_images", seed.id),
    path.join(root, "visualizations", seed.id),
    path.join(root, "thread-writer-locks", `${seed.id}.lock`),
    ...(artifactIndex.get(seed.id) ?? [])
  ])].map((candidate) => ({ candidate, id: seed.id })));
  const artifactChecks = await validateCodexArtifactPaths(artifactCandidates, home, [...seeds.keys()]);
  const artifactPaths = new Map<string, string[]>();
  for (const [index, { candidate, id }] of artifactCandidates.entries()) {
    const validation = artifactChecks[index]!;
    if (validation.status === "valid") {
      const paths = artifactPaths.get(id) ?? [];
      paths.push(candidate);
      artifactPaths.set(id, paths);
    } else if (validation.status === "invalid" && await pathExists(candidate)) {
      const seed = seeds.get(id)!;
      seed.disabledReason ??= `Codex conversation artifact failed safety validation: ${validation.reason}`;
      warnings.push(`Codex: conversation ${id} disabled: ${validation.reason}`);
    }
  }
  const candidates: Candidate[] = [];
  for (const seed of seeds.values()) {
    const paths = new Set([...seed.dataPaths, ...artifactPaths.get(seed.id) ?? []]);
    candidates.push({
      providerId: "codex",
      providerName: getProviderName("codex"),
      id: seed.id,
      title: seed.title,
      updatedAt: seed.updatedAt,
      workspace: seed.workspace,
      dataPaths: [...paths],
      guardPaths: codexMetadataFiles(metadata),
      deleteStrategy: { kind: "local", metadata },
      disabledReason: seed.disabledReason ?? indexDisabledReason ?? residual.disabledReason
    });
  }
  return candidates;
}

async function discoverCopilot(home: string, warnings: string[], walkBudget: PathWalkBudget): Promise<Candidate[]> {
  const root = path.join(home, ".copilot", "session-state");
  const sessionStoreDatabase = path.join(home, ".copilot", "session-store.db");
  const rootCheck = await validateExactStoragePath(root, path.join(home, ".copilot"), ["session-state"], "directory");
  if (rootCheck.status === "invalid") {
    warnings.push(`GitHub Copilot CLI: refusing a symbolic link or unverified storage root: ${rootCheck.reason}`);
    return [];
  }
  const storeCheck = await validateExactStoragePath(
    sessionStoreDatabase, path.join(home, ".copilot"), ["session-store.db"], "file"
  );
  const metadataDisabledReason = storeCheck.status === "invalid"
    ? `Copilot session-store failed safety validation: ${storeCheck.reason}`
    : undefined;
  if (metadataDisabledReason) warnings.push(`GitHub Copilot CLI: ${metadataDisabledReason}`);
  const candidates: Candidate[] = [];
  for await (const entry of rootCheck.status === "valid" ? readDirectoryBounded(rootCheck.path, walkBudget) : []) {
    // Copilot 1.0.88 的共用操作鎖目錄不是對話。
    if (entry.name === ".session-operation-locks") continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directory = path.join(root, entry.name);
    let disabledReason = metadataDisabledReason;
    let safeDirectory: string | undefined;
    let candidateId: string | undefined;
    try {
      assertConversationId(entry.name);
      candidateId = entry.name;
      if (entry.isSymbolicLink()) {
        disabledReason ??= `Refusing a symbolic link candidate data path: ${directory}`;
      } else {
        const validation = await validateCopilotDataPath(directory, entry.name, home);
        if (validation.status === "valid") safeDirectory = directory;
        else disabledReason ??= validation.status === "invalid"
          ? `Candidate data path failed safety validation: ${validation.reason}`
          : `Candidate data path disappeared before validation: ${directory}`;
      }
      let workspace: string | undefined;
      if (safeDirectory) {
        const workspaceFile = path.join(directory, "workspace.yaml");
        const workspaceCheck = await validateExactStoragePath(
          workspaceFile, path.join(home, ".copilot"), ["session-state", entry.name, "workspace.yaml"], "file"
        );
        if (workspaceCheck.status === "valid") {
          workspace = /^\s*(?:cwd|workspace):\s*["']?(.+?)["']?\s*$/m
            .exec(await fs.readFile(workspaceCheck.path, "utf8"))?.[1];
        } else if (workspaceCheck.status === "invalid") {
          disabledReason ??= `Copilot workspace metadata failed safety validation: ${workspaceCheck.reason}`;
        }
      }
      const stat = safeDirectory ? await fs.lstat(safeDirectory) : await fs.lstat(directory);
      candidates.push({
        providerId: "copilot",
        providerName: getProviderName("copilot"),
        id: entry.name,
        title: entry.name,
        updatedAt: stat.mtime.toISOString(),
        workspace,
        dataPaths: safeDirectory ? [safeDirectory] : [],
        guardPaths: [sessionStoreDatabase],
        deleteStrategy: {
          kind: "local",
          metadata: { kind: "copilot", sessionStoreDatabase }
        },
        warnings: ["Only local copies and local session store indexes are deleted; remote GitHub copies are unaffected."],
        disabledReason
      });
    } catch (error) {
      if (!candidateId) {
        warnings.push(`GitHub Copilot CLI: cannot inspect ${directory}: ${toError(error).message}`);
        continue;
      }
      candidates.push({
        providerId: "copilot",
        providerName: getProviderName("copilot"),
        id: candidateId,
        title: candidateId,
        dataPaths: safeDirectory ? [safeDirectory] : [],
        guardPaths: [sessionStoreDatabase],
        deleteStrategy: { kind: "local", metadata: { kind: "copilot", sessionStoreDatabase } },
        warnings: ["Only local copies and local session store indexes are deleted; remote GitHub copies are unaffected."],
        disabledReason: disabledReason ?? `Cannot inspect candidate data path: ${directory}: ${toError(error).message}`
      });
    }
  }
  if (storeCheck.status === "valid") {
    try {
      await withPrivateReadDatabase(home, path.join(home, ".copilot"), storeCheck.path, (database) => {
        const columns = columnNames(database, "sessions");
        const column = ["session_id", "sessionId", "id"].find((name) => columns.has(name));
        if (!column) throw new Error("Unsupported Copilot sessions schema: missing a complete session ID column.");
        const known = new Set(candidates.map((item) => item.id));
        for (const row of database.prepare(`SELECT "${column}" AS id FROM sessions`).all()) {
          if (typeof row.id !== "string") throw new Error("Copilot session ID must be a string.");
          assertConversationId(row.id);
          if (known.has(row.id)) continue;
          known.add(row.id);
          candidates.push({
            providerId: "copilot", providerName: getProviderName("copilot"), id: row.id, title: row.id,
            dataPaths: [], guardPaths: [sessionStoreDatabase],
            deleteStrategy: { kind: "local", metadata: { kind: "copilot", sessionStoreDatabase } },
            warnings: ["Only local copies and local session store indexes are deleted; remote GitHub copies are unaffected."]
          });
        }
      });
    } catch (error) {
      const reason = `Cannot fully read Copilot session store: ${toError(error).message}`;
      warnings.push(reason);
      for (const candidate of candidates) candidate.disabledReason ??= reason;
    }
  }
  return candidates;
}

async function discoverOpenCode(home: string): Promise<Candidate[]> {
  const sessions = await readOpenCodeSessions(home);
  return sessions.map((session): Candidate => ({
    providerId: "opencode", providerName: getProviderName("opencode"),
    id: session.id, parentId: session.parentId, title: session.title,
    updatedAt: asIso(session.updated), workspace: session.directory,
    dataPaths: [], sizeKnown: false, guardPaths: [],
    deleteStrategy: { kind: "indexed" },
    warnings: []
  }));
}

async function discoverGrok(home: string, warnings: string[], walkBudget: PathWalkBudget): Promise<Candidate[]> {
  const root = path.join(home, ".grok", "sessions");
  const rootCheck = await validateExactStoragePath(root, path.join(home, ".grok"), ["sessions"], "directory");
  if (rootCheck.status === "missing") return [];
  if (rootCheck.status === "invalid") {
    warnings.push(`Grok Build CLI: refusing a symbolic link or unverified storage root: ${rootCheck.reason}`);
    return [];
  }
  const candidates: Candidate[] = [];
  const locations = new Map<string, string[]>();
  for await (const group of readDirectoryBounded(rootCheck.path, walkBudget)) {
    if (!group.isDirectory()) continue;
    const groupPath = path.join(root, group.name);
    const groupCheck = await validateExactStoragePath(groupPath, path.join(home, ".grok"), ["sessions", group.name], "directory");
    if (groupCheck.status !== "valid") {
      warnings.push(`Grok Build CLI: skipping storage group ${groupPath} that failed validation`);
      continue;
    }
    for await (const session of readDirectoryBounded(groupCheck.path, walkBudget, 1)) {
      if (!session.isDirectory() && !session.isSymbolicLink()) continue;
      const directory = path.join(groupPath, session.name);
      const summaryFile = path.join(directory, "summary.json");
      let summary: Record<string, unknown> = {};
      let disabledReason: string | undefined;
      let safeDirectory: string | undefined;
      let updatedAt: string | undefined;
      if (session.isSymbolicLink()) {
        disabledReason = `Grok session is a symbolic link; deletion disabled: ${directory}`;
      } else {
        const sessionCheck = await validateExactStoragePath(
          directory, path.join(home, ".grok"), ["sessions", group.name, session.name], "directory"
        );
        if (sessionCheck.status === "valid") {
          safeDirectory = directory;
          const summaryCheck = await validateExactStoragePath(
            summaryFile, path.join(home, ".grok"), ["sessions", group.name, session.name, "summary.json"], "file"
          );
          if (summaryCheck.status === "valid") {
            try {
              const parsed: unknown = JSON.parse(await fs.readFile(summaryCheck.path, "utf8"));
              if (isRecord(parsed)) {
                summary = parsed;
                assertGrokSummaryOwnership(parsed);
              }
              else disabledReason = `Unrecognized Grok session summary: ${summaryFile}`;
            } catch (error) {
              disabledReason = `Cannot read Grok session summary: ${summaryFile}: ${toError(error).message}`;
            }
          } else if (summaryCheck.status === "invalid") {
            disabledReason = `Grok session summary failed safety validation: ${summaryCheck.reason}`;
          }
          updatedAt = (await fs.lstat(safeDirectory)).mtime.toISOString();
        } else {
          disabledReason = sessionCheck.status === "invalid"
            ? `Grok session path failed safety validation: ${sessionCheck.reason}`
            : `Grok session path disappeared before validation: ${directory}`;
        }
      }
      const info = isRecord(summary.info) ? summary.info : {};
      const id = firstString(info, ["id", "session_id"]) ?? session.name;
      try {
        assertConversationId(id);
        const paths = locations.get(id) ?? [];
        paths.push(directory);
        locations.set(id, paths);
        candidates.push({
          providerId: "grok",
          providerName: getProviderName("grok"),
          id,
          parentId: typeof summary.parent_session_id === "string" ? summary.parent_session_id : undefined,
          title: firstString(summary, ["generated_title", "title", "session_summary", "summary"]) ?? id,
          updatedAt: firstDate(summary, ["updated_at", "created_at"]) ?? updatedAt,
          workspace: firstString(info, ["cwd", "working_directory"]),
          dataPaths: safeDirectory ? [safeDirectory] : [],
          guardPaths: [path.join(root, "session_search.sqlite")],
          deleteStrategy: { kind: "indexed" },
          warnings: [],
          disabledReason
        });
      } catch (error) {
        warnings.push(`Grok Build CLI: skipping invalid session ID ${JSON.stringify(id)}: ${toError(error).message}`);
      }
    }
  }
  const duplicateReasons = new Map<string, string>();
  for (const [id, paths] of locations) {
    if (paths.length < 2) continue;
    const reason = `Grok conversation ID appears in multiple data directories; cannot fully determine the deletion scope: ${paths.join(", ")}`;
    warnings.push(`Grok Build CLI: conversation ${id} disabled: ${reason}`);
    duplicateReasons.set(id, reason);
  }
  for (const candidate of candidates) {
    const reason = duplicateReasons.get(candidate.id);
    if (!reason) continue;
    candidate.disabledReason ??= reason;
    candidate.warnings = [...candidate.warnings ?? [], reason];
  }
  return candidates;
}

async function readCodexSessionIndex(file: string): Promise<{
  titles: Map<string, string>;
  disabledReason?: string;
}> {
  const titles = new Map<string, string>();
  let disabledReason: string | undefined;
  if (!(await pathExists(file))) return { titles };
  try {
    for await (const { index, line } of readJsonlLines(file)) {
      if (!line.trim()) continue;
      try {
        let row: unknown;
        try { row = JSON.parse(line); }
        catch { throw new Error(`Invalid JSONL at line ${index}.`); }
        if (!isRecord(row)) throw new Error(`Line ${index} must be an object.`);
        const id = codexJsonlId(row, "index");
        titles.set(id, asString(row.thread_name) ?? id);
      } catch (error) {
        // 保留可驗證的清單，但索引不完整時拒絕刪除。
        disabledReason ??= `Codex session index format or conversation IDs cannot be fully validated; deletion disabled: ${toError(error).message}`;
      }
    }
  } catch (error) {
    disabledReason ??= `Codex session index resource limit or read error; deletion disabled: ${toError(error).message}`;
  }
  return { titles, disabledReason };
}

async function isNormalCodexFile(root: string, file: string, warnings: string[]): Promise<boolean> {
  const parts = path.relative(path.resolve(root), path.resolve(file)).split(path.sep);
  const check = await validateExactStoragePath(file, root, parts, "file");
  if (check.status === "invalid") warnings.push(`Codex: skipping file ${file} that failed safety validation: ${check.reason}`);
  return check.status === "valid";
}

async function walkCodexRollouts(
  codexRoot: string,
  root: string,
  warnings: string[],
  budget: PathWalkBudget
): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await listCodexDirectory(codexRoot, root, warnings, budget)) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...await walkCodexRollouts(codexRoot, entryPath, warnings, budget));
    } else if (entry.isFile() && isCodexRolloutName(entry.name)) {
      output.push(entryPath);
    }
  }
  return output;
}

function getCodexSeed(seeds: Map<string, CodexSeed>, id: string, title: string): CodexSeed {
  let seed = seeds.get(id);
  if (!seed) {
    seed = { id, title, dataPaths: [] };
    seeds.set(id, seed);
  } else if (seed.title === id && title !== id) {
    seed.title = title;
  }
  return seed;
}

async function indexCodexArtifacts(
  codexRoot: string,
  ids: string[],
  warnings: string[],
  budget: PathWalkBudget
): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  const knownIds = new Set(ids);
  const directRoots = ["shell_snapshots", "visualizations"];
  for (const directory of directRoots) {
    const storage = path.join(codexRoot, directory);
    const entries = await listCodexDirectory(codexRoot, storage, warnings, budget);
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isDirectory()) continue;
      for (const id of codexArtifactOwners(entry.name, knownIds)) {
        const paths = index.get(id) ?? [];
        paths.push(path.join(storage, entry.name));
        index.set(id, paths);
      }
    }
    if (directory !== "visualizations") continue;

    for (const year of entries.filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))) {
      const yearPath = path.join(storage, year.name);
      const months = await listCodexDirectory(codexRoot, yearPath, warnings, budget);
      for (const month of months.filter((entry) => entry.isDirectory() && isValidStorageMonth(entry.name))) {
        const monthPath = path.join(yearPath, month.name);
        const days = await listCodexDirectory(codexRoot, monthPath, warnings, budget);
        for (const day of days.filter((entry) => entry.isDirectory() && isValidStorageDate(year.name, month.name, entry.name))) {
          const dayPath = path.join(monthPath, day.name);
          const artifacts = await listCodexDirectory(codexRoot, dayPath, warnings, budget);
          for (const artifact of artifacts) {
            if (!knownIds.has(artifact.name) || (!artifact.isFile() && !artifact.isDirectory())) continue;
            const paths = index.get(artifact.name) ?? [];
            paths.push(path.join(dayPath, artifact.name));
            index.set(artifact.name, paths);
          }
        }
      }
    }
  }
  return index;
}

async function listCodexDirectory(
  codexRoot: string,
  directory: string,
  warnings: string[],
  budget: PathWalkBudget
): Promise<import("node:fs").Dirent[]> {
  const relative = path.relative(path.resolve(codexRoot), path.resolve(directory));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
  const check = await validateExactStoragePath(directory, codexRoot, relative ? relative.split(path.sep) : [], "directory");
  if (check.status === "missing") return [];
  if (check.status === "invalid") {
    warnings.push(`Codex: storage failed safety validation ${directory}: ${check.reason}`);
    return [];
  }
  const entries: import("node:fs").Dirent[] = [];
  // 讀取失敗或超過額度時，呼叫端必須拒絕使用不完整的所有權清單。
  for await (const entry of readDirectoryBounded(check.path, budget, relative.split(path.sep).length - 1)) entries.push(entry);
  return entries;
}

async function isSafeHomePath(candidate: string, home: string): Promise<boolean> {
  if (!path.isAbsolute(candidate) || candidate === home || !containsPath(home, candidate)) return false;
  const canonicalHome = await getCanonicalPath(home);
  const canonicalCandidate = await getCanonicalPath(candidate);
  return canonicalCandidate !== canonicalHome && containsPath(canonicalHome, canonicalCandidate);
}

function isCommandMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
