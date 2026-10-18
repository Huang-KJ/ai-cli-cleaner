import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { TrashFn } from "../cleaners/clean.js";
import { createMetadataPlan, type MetadataPlan, type MetadataPlanResult } from "./metadata-plan.js";
import { validateCodexRolloutPath, validateExactStoragePath } from "./owned-paths.js";
import { assertConversationId } from "./types.js";
import { createPathWalkBudget, pathExists, readDirectoryBounded } from "../fs/paths.js";
import { assertKnownCodexDatabases, codexMetadataFiles, getCodexMetadataPaths, type CodexMetadataPaths } from "./codex-paths.js";
import {
  codexDatabaseEntries, codexDatabaseSchemas, codexLocalHostSql, codexRequiredColumns,
  isLocalCodexHost, readCodexResidualIds, type CodexDatabaseSchema, type CodexTableSchema
} from "./codex-inventory.js";
import { isRecord } from "./metadata-values.js";
import { codexJsonlId } from "./codex-artifacts.js";
import { readJsonlLines, rewriteJsonl, validateJsonl } from "./metadata-jsonl.js";
import {
  columnNames, protectSqliteRows, quoteIdentifier as quote, tableExists, tableNames,
  withSqliteTransaction, type SqliteSelection
} from "./sqlite.js";
import {
  assertMetadataInventoryUnchanged,
  assertMetadataTargetUnchanged,
  assertSqliteRecoveryUnchanged,
  atomicRewrite,
  createMetadataInventory,
  guardSqliteRecovery,
  rehearseMetadata,
  withSqliteSidecars,
  type MetadataInventory
} from "./metadata-safety.js";

type CodexPlanPaths = Partial<CodexMetadataPaths>;

export interface CodexMetadataPlan extends Omit<MetadataPlan, "execute"> {
  paths: string[];
  operations: string[];
  execute: () => Promise<MetadataPlanResult>;
}

export async function prepareCodexThreadsMetadata(
  home: string,
  paths: CodexMetadataPaths,
  threadIds: string[],
  trash: TrashFn,
  rolloutPaths: string[] = []
): Promise<CodexMetadataPlan> {
  threadIds.forEach(assertConversationId);
  await assertKnownCodexDatabases(home);
  const rollouts = await selectedRolloutPaths(home, threadIds, rolloutPaths);
  return prepareCodexPlan(home, paths, trash, threadIds, "Selected Codex conversations", async (mapped, inventory) => {
    await deleteCodexMetadataInternal(mapped, threadIds, inventory, rollouts);
  });
}

export async function prepareLiveCodexThreadsMetadata(
  home: string,
  paths: CodexMetadataPaths,
  threadIds: string[],
  trash: TrashFn,
  rolloutPaths: string[] = []
): Promise<CodexMetadataPlan> {
  threadIds.forEach(assertConversationId);
  await assertKnownCodexDatabases(home);
  const rollouts = await selectedRolloutPaths(home, threadIds, rolloutPaths);
  return prepareCodexPlan(home, paths, trash, threadIds, "Selected Codex conversations", async (mapped, inventory) => {
    await deleteCodexMetadataInternal(mapped, threadIds, inventory, rollouts);
  }, codexMetadataFiles(paths), true, rollouts);
}

async function selectedRolloutPaths(home: string, threadIds: string[], candidates: string[]): Promise<string[]> {
  const ids = new Set(threadIds);
  const rollouts = new Set<string>();
  for (const file of new Set(candidates)) {
    const checked = await validateCodexRolloutPath(file, home);
    if (checked.status === "valid" && checked.header.id && ids.has(checked.header.id)) {
      // 索引可能保留 /var 等系統別名，兩種字串都必須先確認同一 rollout 歸屬。
      rollouts.add(file);
      rollouts.add(checked.path);
    }
  }
  return [...rollouts];
}

const codexGlobalThreadKeys = [
  "app-server-migrated-pinned-thread-ids-by-host",
  "electron-thread-read-state-v1",
  "pinned-thread-ids",
  "projectless-thread-ids",
  "queued-follow-ups",
  "sidebar-project-thread-orders",
  "thread-project-assignments",
  "thread-projectless-output-directories",
  "thread-workspace-root-hints",
  "thread-writable-roots"
] as const;

export function codexConversationMetadataPaths(home: string): string[] {
  return withSqliteSidecars(codexMetadataFiles(getCodexMetadataPaths(home)));
}

export async function prepareCodexConversationMetadata(home: string, trash: TrashFn): Promise<CodexMetadataPlan> {
  const root = path.join(home, ".codex");
  const sourcePaths = getCodexMetadataPaths(home);
  if (!path.isAbsolute(home)) throw new Error("Codex home must be an absolute path.");
  const rollouts = await collectCodexRollouts(home);
  const globalPaths = new Set(sourcePaths.globalStateFiles ?? []);
  const sourceInventory = await createMetadataInventory([
    ...codexMetadataFiles(sourcePaths).filter((file) => !globalPaths.has(file)),
    ...rollouts
  ], root, home);
  // 共用 residual 驗證已檢查 state/app schema，且僅開啟私有資料庫副本。
  const residual = await readCodexResidualIds(home, sourcePaths);
  if (residual.disabledReason) throw new Error(residual.warnings.join("\n"));
  const ids = new Set(residual.ids);
  for (const file of [sourcePaths.sessionIndex, sourcePaths.historyFile]) {
    if (!file || !(await pathExists(file))) continue;
    await validateJsonl(file, "Codex");
    for await (const { line } of readJsonlLines(file)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      const id = codexJsonlId(row, file === sourcePaths.sessionIndex ? "index" : "history");
      ids.add(id);
    }
  }
  for (const file of rollouts) {
    const rollout = await validateCodexRolloutPath(file, home);
    if (rollout.status !== "valid" || !rollout.header.id) throw new Error(`Codex rollout changed: ${file}`);
    ids.add(rollout.header.id);
  }
  const threadIds = [...ids];
  await assertMetadataInventoryUnchanged(sourceInventory);
  const paths: CodexPlanPaths = {
    globalStateFiles: sourcePaths.globalStateFiles,
    appDatabase: sourcePaths.appDatabase,
    threadSummariesDatabase: sourcePaths.threadSummariesDatabase,
    historySnapshotsDatabase: sourcePaths.historySnapshotsDatabase
  };
  const plan = await prepareCodexPlan(
    home,
    paths,
    trash,
    threadIds,
    "Local Codex conversations",
    async (mapped, inventory) => clearLocalCodexMetadata(mapped, threadIds, inventory)
  );
  return {
    ...plan,
    get recoveryPath() { return plan.recoveryPath; },
    validate: async () => {
      // 來源資料庫只在搬移前驗證；execute 內仍僅驗證保留的 metadata。
      await assertMetadataInventoryUnchanged(sourceInventory);
      await plan.validate();
    }
  };
}

async function prepareCodexPlan(
  home: string,
  paths: CodexPlanPaths,
  trash: TrashFn,
  conversationIds: string[],
  label: string,
  run: (mapped: CodexPlanPaths, inventory?: MetadataInventory) => Promise<void>,
  inventoryFiles: string[] = codexMetadataFiles(paths),
  liveSqlite = false,
  rolloutPaths: string[] = []
): Promise<CodexMetadataPlan> {
  if (!path.isAbsolute(home)) throw new Error("Codex home must be an absolute path.");
  const providerRoot = path.join(path.resolve(home), ".codex");
  const inventory = await createMetadataInventory(inventoryFiles, providerRoot, home, { liveSqlite });
  const rehearsed = await rehearseMetadata(inventory, async (copies) => {
    await run(mapCodexPaths(paths, copies));
  });
  if (liveSqlite) registerCodexRecoveryGuards(paths, conversationIds, inventory, rolloutPaths);
  // 線上資料庫在預演後可能新增目標資料列；全部備份，並於交易內重驗未選取列。
  const changedPaths = liveSqlite ? [...new Set([
    ...rehearsed,
    ...inventory.entries.filter((entry) => entry.kind === "sqlite" && entry.identity &&
      /\.(?:sqlite|db)$/i.test(entry.path)).map((entry) => entry.path)
  ])] : rehearsed;
  const operations = changedPaths.map((file) => `${label} metadata: ${path.relative(providerRoot, file)}`);
  const metadata = createMetadataPlan({
    home, inventory, changedPaths, providerId: "codex", conversationIds,
    write: async (markChanged, copies, mappedInventory) => {
      markChanged();
      await run(mapCodexPaths(paths, copies), mappedInventory);
    }
  });
  return {
    paths: inventory.entries.filter((entry) => entry.identity).map((entry) => entry.path),
    operations,
    get recoveryPath() { return metadata.recoveryPath; },
    validate: metadata.validate,
    prepareRecovery: metadata.prepareRecovery,
    execute: () => metadata.execute(trash)
  };
}

function registerCodexRecoveryGuards(
  paths: CodexPlanPaths,
  ids: string[],
  inventory: MetadataInventory,
  rolloutPaths: string[] = []
): void {
  for (const [key, schema] of codexDatabaseEntries) {
    const file = paths[key];
    if (file && inventory.entries.some((entry) => entry.path === path.resolve(file) && entry.identity)) {
      guardSqliteRecovery(inventory, file, (database) => key === "stateDatabase"
        ? selectStateRows(database, ids, rolloutPaths) : selectCodexRows(schema, ids));
    }
  }
}

function mapCodexPaths(paths: CodexPlanPaths, copies: Map<string, string>): CodexPlanPaths {
  const map = (file: string): string => {
    const mapped = copies.get(path.resolve(file));
    if (!mapped) throw new Error(`Codex metadata is missing a temporary preflight path: ${file}`);
    return mapped;
  };
  const optional = (file: string | undefined): string | undefined => file === undefined ? undefined : map(file);
  return {
    stateDatabase: optional(paths.stateDatabase),
    sessionIndex: optional(paths.sessionIndex),
    historyFile: optional(paths.historyFile),
    globalStateFiles: paths.globalStateFiles?.map(map),
    threadHistoryDatabase: optional(paths.threadHistoryDatabase),
    logsDatabase: optional(paths.logsDatabase),
    goalsDatabase: optional(paths.goalsDatabase),
    memoriesDatabase: optional(paths.memoriesDatabase),
    queueDatabase: optional(paths.queueDatabase),
    appDatabase: optional(paths.appDatabase),
    threadSummariesDatabase: optional(paths.threadSummariesDatabase),
    historySnapshotsDatabase: optional(paths.historySnapshotsDatabase)
  };
}

async function deleteCodexMetadataInternal(
  paths: CodexPlanPaths,
  threadIds: string[],
  inventory?: MetadataInventory,
  rolloutPaths: string[] = []
): Promise<void> {
  const ids: ReadonlySet<unknown> = new Set(threadIds);
  await validateCodexMetadata(paths);
  await rewriteJsonl(paths.sessionIndex, "Codex", (row) =>
    !ids.has(codexJsonlId(row, "index")),
    inventory
  );
  if (paths.historyFile) await rewriteJsonl(paths.historyFile, "Codex", (row) =>
    !ids.has(codexJsonlId(row, "history")),
    inventory
  );
  for (const file of paths.globalStateFiles ?? []) await rewriteGlobalState(file, threadIds, inventory);
  await deleteCodexDatabaseRows(paths, threadIds, inventory, rolloutPaths);
}

async function deleteCodexDatabaseRows(
  paths: CodexPlanPaths,
  threadIds: string[],
  inventory?: MetadataInventory,
  rolloutPaths: string[] = []
): Promise<void> {
  for (const [key, schema] of codexDatabaseEntries) {
    if (key === "stateDatabase") await deleteStateRows(paths[key], threadIds, inventory, rolloutPaths);
    else await deleteCodexRows(paths[key], schema, threadIds, inventory);
  }
}

async function validateCodexMetadata(paths: CodexPlanPaths): Promise<void> {
  await validateCodexJsonl(paths.sessionIndex, "index");
  await validateCodexJsonl(paths.historyFile, "history");
  for (const file of paths.globalStateFiles ?? []) await validateGlobalJson(file);
  for (const [key, schema] of codexDatabaseEntries) await validateCodexDatabase(paths[key], schema);
}

async function validateCodexJsonl(file: string | undefined, kind: "index" | "history"): Promise<void> {
  await validateJsonl(file, "Codex");
  if (!file || !(await pathExists(file))) return;
  for await (const { line } of readJsonlLines(file)) {
    if (line.trim()) codexJsonlId(JSON.parse(line), kind);
  }
}

async function validateCodexDatabase(
  file: string | undefined,
  expected: CodexDatabaseSchema
): Promise<void> {
  if (!file || !(await pathExists(file))) return;
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const existing = new Set(tableNames(database));
    for (const table of expected.required ?? []) {
      if (!existing.has(table)) throw new Error(`Codex metadata is missing required table ${table}: ${file}`);
    }
    if (!expected.tables.some((table) => existing.has(table.name))) {
      throw new Error(`Cannot recognize required Codex metadata tables: ${file}`);
    }
    for (const table of expected.tables) {
      if (!existing.has(table.name)) continue;
      const actual = columnNames(database, table.name);
      for (const column of codexRequiredColumns(table)) {
        if (!actual.has(column)) throw new Error(`Codex metadata ${table.name} is missing required column ${column}: ${file}`);
      }
    }
  } finally { database.close(); }
}

async function validateGlobalJson(file: string): Promise<void> {
  if (!(await pathExists(file))) return;
  const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  if (!isRecord(value)) throw new Error(`Unrecognized Codex global state: ${file}`);
  transformKnownCodexGlobalReferences(value, new Set());
}

async function clearLocalCodexMetadata(
  paths: CodexPlanPaths,
  threadIds: string[],
  inventory?: MetadataInventory
): Promise<void> {
  await validateCodexMetadata(paths);
  for (const file of paths.globalStateFiles ?? []) await rewriteGlobalState(file, threadIds, inventory);
  await deleteCodexDatabaseRows(paths, threadIds, inventory);
}

async function collectCodexRollouts(home: string): Promise<string[]> {
  const root = path.join(home, ".codex");
  const files: string[] = [];
  const budget = createPathWalkBudget();
  const visit = async (parts: string[]): Promise<void> => {
    const directory = path.join(root, ...parts);
    const checked = await validateExactStoragePath(directory, root, parts, "directory");
    if (checked.status === "missing") return;
    if (checked.status !== "valid") throw new Error(`Cannot validate Codex rollout storage: ${checked.reason}`);
    for await (const entry of readDirectoryBounded(directory, budget, parts.length - 1)) {
      if (entry.isDirectory()) await visit([...parts, entry.name]);
      else if (entry.isSymbolicLink()) throw new Error(`Codex rollout storage contains a symbolic link: ${path.join(directory, entry.name)}`);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const file = path.join(directory, entry.name);
        const rollout = await validateCodexRolloutPath(file, home);
        if (rollout.status !== "valid") throw new Error(`Cannot validate Codex rollout: ${file}`);
        files.push(file);
      }
    }
  };
  await visit(["sessions"]);
  await visit(["archived_sessions"]);
  return files;
}

async function deleteStateRows(
  file: string | undefined,
  threadIds: string[],
  inventory?: MetadataInventory,
  rolloutPaths: string[] = []
): Promise<void> {
  if (!file || !(await pathExists(file))) return;
  if (threadIds.length === 0) return;
  await assertMetadataTargetUnchanged(file, inventory);
  transact(file, (database) => {
    for (const threadId of threadIds) {
      let rolloutPath: string | undefined;
      const row = database.prepare("SELECT rollout_path FROM threads WHERE id = ?")
        .get(threadId) as { rollout_path?: unknown } | undefined;
      if (typeof row?.rollout_path === "string") rolloutPath = row.rollout_path;
      for (const table of codexDatabaseSchemas.stateDatabase.tables) {
        if (table.name !== "threads") deleteCodexTableRows(database, table, [threadId]);
      }
      if (rolloutPath) {
        deleteExact(database, "rollout_migration_skipped_rollouts", "rollout_path", rolloutPath);
      }
      deleteExact(database, "threads", "id", threadId);
    }
    // 封存副本及沒有 threads 主列的 rollout 也有可確認的遷移紀錄。
    for (const rollout of rolloutPaths) deleteExact(database, "rollout_migration_skipped_rollouts", "rollout_path", rollout);
  }, (database) => selectStateRows(database, threadIds, rolloutPaths), inventory);
}

function selectStateRows(database: DatabaseSync, threadIds: string[], rolloutPaths: string[] = []): ReturnType<SqliteSelection> {
  const ids = new Set(threadIds);
  const rollouts = new Set([...rolloutPaths, ...(database.prepare("SELECT id, rollout_path FROM threads").all())
    .filter((row) => typeof row.id === "string" && ids.has(row.id)).map((row) => row.rollout_path)
    .filter((value) => typeof value === "string" && value.length > 0)]);
  const selected = selectCodexRows(codexDatabaseSchemas.stateDatabase, threadIds);
  return (table, row) => table === "rollout_migration_skipped_rollouts"
    ? typeof row.rollout_path === "string" && rollouts.has(row.rollout_path) : selected(table, row);
}

async function deleteCodexRows(
  file: string | undefined,
  schema: CodexDatabaseSchema,
  threadIds: string[],
  inventory?: MetadataInventory
): Promise<void> {
  if (!file || !(await pathExists(file)) || threadIds.length === 0) return;
  await assertMetadataTargetUnchanged(file, inventory);
  transact(file, (database) => {
    for (const table of schema.tables) deleteCodexTableRows(database, table, threadIds);
  }, () => selectCodexRows(schema, threadIds), inventory);
}

function deleteCodexTableRows(database: DatabaseSync, table: CodexTableSchema, ids: string[]): void {
  if (table.idColumns.length === 0 || !tableExists(database, table.name)) return;
  const columns = columnNames(database, table.name);
  if (codexRequiredColumns(table).some((column) => !columns.has(column))) return;
  const host = table.host && columns.has(table.host) ? table.host : undefined;
  const condition = table.idColumns.map((column) => `${quote(column)} = ?`).join(" OR ");
  const scope = host ? ` AND ${codexLocalHostSql(host)}` : "";
  const statement = database.prepare(`DELETE FROM ${quote(table.name)} WHERE (${condition})${scope}`);
  for (const id of ids) statement.run(...table.idColumns.map(() => id));
}

function selectCodexRows(schema: CodexDatabaseSchema, threadIds: string[]): ReturnType<SqliteSelection> {
  const ids = new Set(threadIds);
  return (name, row) => {
    const table = schema.tables.find((table) => table.name === name);
    if (!table || !table.idColumns.some((column) => typeof row[column] === "string" && ids.has(row[column] as string))) {
      return false;
    }
    return !table.host || (table.optionalHost && !(table.host in row)) || isLocalCodexHost(row[table.host]);
  };
}

function transact(
  file: string,
  operation: (database: DatabaseSync) => void,
  selected: SqliteSelection,
  inventory?: MetadataInventory
): void {
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA busy_timeout = 2500; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON");
    withSqliteTransaction(database, () => {
      // 寫入鎖內重驗備份，避免最後一次預檢後新增的所選資料遭到移除。
      assertSqliteRecoveryUnchanged(database, file, inventory);
      const assertRetained = protectSqliteRows(database, selected(database));
      operation(database);
      assertRetained();
      if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("Codex metadata foreign key validation failed.");
    });
  } finally {
    database.close();
  }
}

function deleteExact(
  database: DatabaseSync,
  table: string,
  column: string,
  value: string
): void {
  if (!tableExists(database, table) || !columnNames(database, table).has(column)) return;
  database.prepare(`DELETE FROM ${quote(table)} WHERE ${quote(column)} = ?`).run(value);
}

async function rewriteGlobalState(
  file: string,
  threadIdOrIds: string | string[],
  inventory?: MetadataInventory
): Promise<void> {
  if (!(await pathExists(file))) return;
  const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  if (!isRecord(value)) throw new Error(`Unrecognized Codex global state: ${file}`);
  const ids = new Set(typeof threadIdOrIds === "string" ? [threadIdOrIds] : threadIdOrIds);
  const [rewritten, changed] = transformKnownCodexGlobalReferences(value, ids);
  if (changed) await atomicRewrite(file, JSON.stringify(rewritten, null, 2) + "\n", inventory);
}

function transformKnownCodexGlobalReferences(
  value: Record<string, unknown>,
  ids: Set<string>
): [Record<string, unknown>, boolean] {
  let changed = false;
  const output: Record<string, unknown> = { ...value };
  for (const key of codexGlobalThreadKeys) {
    if (!(key in value)) continue;
    const current = value[key];
    if (key === "app-server-migrated-pinned-thread-ids-by-host" || key === "electron-thread-read-state-v1") {
      if (!isRecord(current)) throw new Error(`Unrecognized Codex global state field ${key}.`);
      const hostOutput: Record<string, unknown> = { ...current };
      let hostChanged = false;
      for (const [host, hostValue] of Object.entries(current)) {
        if (!isLocalCodexHost(host)) continue;
        const [next, nestedChanged] = key === "app-server-migrated-pinned-thread-ids-by-host"
          ? removeThreadArray(hostValue, ids, `${key}.${host}`)
          : removeThreadKeys(hostValue, ids, `${key}.${host}`);
        hostOutput[host] = next;
        hostChanged ||= nestedChanged;
      }
      if (hostChanged) {
        output[key] = hostOutput;
        changed = true;
      }
      continue;
    }
    let next: unknown;
    let keyChanged: boolean;
    if (key === "pinned-thread-ids" || key === "projectless-thread-ids") {
      [next, keyChanged] = removeThreadArray(current, ids, key);
    } else if (key === "sidebar-project-thread-orders") {
      if (!isRecord(current)) throw new Error(`Unrecognized Codex global state field ${key}.`);
      const orders: Record<string, unknown> = { ...current };
      keyChanged = false;
      for (const [project, order] of Object.entries(current)) {
        const [filtered, orderChanged] = removeThreadArray(order, ids, key);
        orders[project] = filtered;
        keyChanged ||= orderChanged;
      }
      next = orders;
    } else if (key === "queued-follow-ups") {
      // 尚無可驗證的非空格式，避免把內容或其他識別碼誤當 thread ID。
      if ((!Array.isArray(current) && !isRecord(current)) || Object.keys(current).length > 0) {
        throw new Error(`Unrecognized Codex global state field ${key}.`);
      }
      next = current;
      keyChanged = false;
    } else {
      [next, keyChanged] = removeThreadKeys(current, ids, key);
    }
    if (keyChanged) {
      output[key] = next;
      changed = true;
    }
  }
  return [output, changed];
}

function removeThreadArray(value: unknown, ids: Set<string>, field: string): [unknown, boolean] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Unrecognized Codex global state field ${field}.`);
  }
  const output = value.filter((id) => !ids.has(id));
  return [output, output.length !== value.length];
}

function removeThreadKeys(value: unknown, ids: Set<string>, field: string): [unknown, boolean] {
  if (!isRecord(value)) throw new Error(`Unrecognized Codex global state field ${field}.`);
  // 值可含專案、路徑或其他資料，只有本欄位的鍵代表 thread ID。
  const entries = Object.entries(value).filter(([id]) => !ids.has(id));
  return [Object.fromEntries(entries), entries.length !== Object.keys(value).length];
}
