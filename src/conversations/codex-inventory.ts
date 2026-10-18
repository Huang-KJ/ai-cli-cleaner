import path from "node:path";
import type { CodexMetadataPaths } from "./codex-paths.js";
import { toError } from "./metadata-values.js";
import { validateExactStoragePath } from "./owned-paths.js";
import { columnNames, quoteIdentifier as quote, tableNames } from "./sqlite.js";
import { assertConversationId } from "./types.js";
import { withPrivateReadDatabase } from "./metadata-safety.js";

export interface CodexTableSchema {
  name: string;
  idColumns: string[];
  requiredColumns?: string[];
  host?: string;
  optionalHost?: boolean;
  requiredId?: boolean;
}

export interface CodexDatabaseSchema {
  required?: string[];
  tables: CodexTableSchema[];
}

type CodexDatabaseKey = Exclude<keyof CodexMetadataPaths, "sessionIndex" | "historyFile" | "globalStateFiles">;
const threadTables = (names: string[]): CodexTableSchema[] => names.map((name) => ({ name, idColumns: ["thread_id"] }));

// ID 歸屬、必要欄位與本機 host 規則共用；rollout path 不當作對話 ID。
export const codexDatabaseSchemas: Record<CodexDatabaseKey, CodexDatabaseSchema> = {
  stateDatabase: { required: ["threads"], tables: [
    { name: "threads", idColumns: ["id"], requiredColumns: ["rollout_path"], requiredId: true },
    ...threadTables(["thread_attachments", "thread_dynamic_tools", "thread_realtime_items", "thread_turns", "thread_items"]),
    { name: "thread_spawn_edges", idColumns: ["parent_thread_id", "child_thread_id"] },
    { name: "rollout_migration_skipped_rollouts", idColumns: [], requiredColumns: ["rollout_path"] }
  ] },
  threadHistoryDatabase: { tables: threadTables([
    "thread_items", "thread_realtime_items", "thread_turns", "thread_history_projection_state"
  ]) },
  logsDatabase: { required: ["logs"], tables: threadTables(["logs"]) },
  goalsDatabase: { tables: threadTables(["thread_goal_continuation_deferrals", "thread_goals"]) },
  memoriesDatabase: { required: ["stage1_outputs"], tables: threadTables(["stage1_outputs"]) },
  queueDatabase: { tables: threadTables(["queued_items", "queued_thread_revisions"]) },
  appDatabase: { tables: [
    ...threadTables(["local_thread_catalog", "thread_timeline_ledger", "local_thread_catalog_scan_entries", "live_visualization_suggestions"])
      .map((table) => ({ ...table, host: "host_id", optionalHost: true })),
    ...threadTables(["automation_runs", "inbox_items"])
  ] },
  threadSummariesDatabase: { required: ["thread_turn_summaries"], tables: [
    { name: "thread_turn_summaries", idColumns: ["thread_id"], host: "host_key" }
  ] },
  historySnapshotsDatabase: { required: ["app_server_history_snapshots"], tables: [
    { name: "app_server_history_snapshots", idColumns: ["thread_id"], host: "host_id" }
  ] }
};

export const codexDatabaseEntries = Object.entries(codexDatabaseSchemas) as Array<[CodexDatabaseKey, CodexDatabaseSchema]>;

export function codexRequiredColumns(table: CodexTableSchema): string[] {
  return [...table.idColumns, ...table.requiredColumns ?? [], ...(table.host && !table.optionalHost ? [table.host] : [])];
}

export function codexLocalHostSql(host: string): string {
  return `(${quote(host)} = 'local' OR ${quote(host)} LIKE 'local:%')`;
}

export function isLocalCodexHost(host: unknown): boolean {
  return typeof host === "string" && (host === "local" || host.startsWith("local:"));
}

export async function readCodexResidualIds(home: string, paths: CodexMetadataPaths): Promise<{
  ids: string[];
  warnings: string[];
  disabledReason?: string;
}> {
  const root = path.join(home, ".codex");
  const ids = new Set<string>();
  const warnings: string[] = [];
  const addIssue = (file: string, error: unknown): void => {
    warnings.push(`Codex: cannot fully validate conversation index ${file}; deletion disabled: ${toError(error).message}`);
  };
  for (const [key, spec] of codexDatabaseEntries) {
    const file = paths[key];
    if (typeof file !== "string") continue;
    try {
      const relative = path.relative(root, file).split(path.sep);
      const check = await validateExactStoragePath(file, root, relative, "file");
      if (check.status === "missing") continue;
      if (check.status === "invalid") throw new Error(check.reason);
      await withPrivateReadDatabase(home, root, check.path, (database) => {
        const tables = new Set(tableNames(database));
        for (const table of spec.required ?? []) {
          if (!tables.has(table)) addIssue(file, new Error(`Missing required table ${table}`));
        }
        if (!spec.tables.some((table) => table.idColumns.length > 0 && tables.has(table.name))) {
          throw new Error("No recognized conversation table found.");
        }
        for (const table of spec.tables) {
          if (!tables.has(table.name) || table.idColumns.length === 0) continue;
          try {
            const columns = columnNames(database, table.name);
            const required = codexRequiredColumns(table);
            for (const column of required) {
              if (!columns.has(column)) throw new Error(`${table.name} is missing required column ${column}`);
            }
            const host = table.host && columns.has(table.host) ? table.host : undefined;
            for (const column of table.idColumns) {
              const scope = host ? ` AND ${codexLocalHostSql(host)}` : "";
              const condition = table.requiredId ? "1" : `${quote(column)} IS NOT NULL`;
              const rows = database.prepare(`SELECT DISTINCT ${quote(column)} AS id FROM ${quote(table.name)} WHERE ${condition}${scope}`);
              rows.setReadBigInts(true);
              for (const row of rows.all()) {
                try {
                  if (typeof row.id !== "string") throw new Error(`${table.name}.${column} conversation ID must be a string.`);
                  assertConversationId(row.id);
                  ids.add(row.id);
                } catch (error) { addIssue(file, error); }
              }
            }
          } catch (error) { addIssue(file, error); }
        }
      });
    } catch (error) { addIssue(file, error); }
  }
  return { ids: [...ids], warnings: [...new Set(warnings)], disabledReason: warnings[0] };
}
