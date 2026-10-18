import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TrashFn } from "../cleaners/clean.js";
import { createMetadataPlan, type MetadataPlanResult } from "./metadata-plan.js";
import {
  assertMetadataInventoryUnchanged, createMetadataInventory, rehearseMetadata,
  withPrivateReadDatabase
} from "./metadata-safety.js";
import { knownOpenCodeTables } from "./opencode.js";
import { columnNames, protectSqliteRows, quoteIdentifier, tableNames, withSqliteTransaction } from "./sqlite.js";

export interface OpenCodeBulkPlan {
  paths: string[];
  operations: string[];
  retainDatabase: boolean;
  readonly recoveryPath?: string;
  validate(): Promise<void>;
  prepareRecovery(): Promise<void>;
  execute(): Promise<MetadataPlanResult>;
  assertComplete(): Promise<void>;
}

const conversationTables = new Set([
  "session", "message", "part", "todo", "session_share", "session_context_epoch", "session_input", "session_message"
]);
const eventTables = new Set(["event", "event_sequence"]);
const migrationTables = new Set(["__drizzle_migrations", "data_migration", "migration"]);
const requiredColumns: Record<string, string[]> = {
  session: ["id"], message: ["id", "session_id"], part: ["id", "message_id", "session_id"],
  todo: ["session_id"], session_share: ["session_id"],
  session_context_epoch: ["session_id", "baseline", "snapshot", "baseline_seq"],
  session_input: ["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"],
  session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
  event_sequence: ["aggregate_id", "seq", "owner_id"], event: ["id", "aggregate_id", "seq", "type", "data"]
};

interface BulkSelection {
  tables: string[];
  aggregates: Set<string>;
  retainDatabase: boolean;
}

// 只在私有副本辨識與預演，原始 WAL 與永久設定不會因預覽而改寫。
export async function prepareOpenCodeBulkMetadata(home: string, trash: TrashFn): Promise<OpenCodeBulkPlan> {
  const root = path.join(home, ".local", "share", "opencode");
  const file = path.join(root, "opencode.db");
  const inventory = await createMetadataInventory([file], root, home);
  const exists = inventory.entries.some((entry) => entry.path === file && entry.identity);
  if (!exists && inventory.entries.some((entry) => entry.identity)) {
    throw new Error("OpenCode database is missing but sidecars remain; authentication data cannot be confirmed. Bulk cleanup stopped.");
  }
  let selection: BulkSelection | undefined;
  const changedPaths = exists ? await rehearseMetadata(inventory, async (copies) => {
    const copy = copies.get(file);
    if (!copy) throw new Error("OpenCode bulk metadata preview mapping is missing.");
    const database = new DatabaseSync(copy);
    try {
      selection = inspectDatabase(database);
      if (selection.retainDatabase) clearConversations(database, selection);
    } finally { database.close(); }
  }) : [];
  const retainDatabase = selection?.retainDatabase ?? false;
  const validate = () => assertMetadataInventoryUnchanged(inventory);
  const assertComplete = async (): Promise<void> => {
    if (!retainDatabase) return;
    await withPrivateReadDatabase(home, root, file, (database) => {
      const current = inspectDatabase(database);
      if (current.aggregates.size || current.tables.some((table) => conversationTables.has(table) && hasRows(database, table))) {
        throw new Error("OpenCode conversation rows remain after cleanup.");
      }
    });
  };
  const metadata = createMetadataPlan({
    home, inventory, changedPaths, providerId: "opencode", conversationIds: [...(selection?.aggregates ?? [])],
    write: async (_markChanged, copies) => {
      const copy = copies.get(file);
      if (!copy) throw new Error("OpenCode bulk metadata publication mapping is missing.");
      const database = new DatabaseSync(copy);
      try { clearConversations(database, inspectDatabase(database)); }
      finally { database.close(); }
    },
    afterWrite: assertComplete
  });
  return {
    paths: inventory.entries.map((entry) => entry.path),
    operations: changedPaths.map(() => "Clear all OpenCode conversation rows and session events in opencode.db; preserve authentication, accounts, permissions, projects and workspaces."),
    retainDatabase,
    get recoveryPath() { return metadata.recoveryPath; },
    validate,
    prepareRecovery: metadata.prepareRecovery,
    execute: () => metadata.execute(trash),
    assertComplete
  };
}

function hasRows(database: DatabaseSync, table: string): boolean {
  return database.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} LIMIT 1`).get() !== undefined;
}

function inspectDatabase(database: DatabaseSync): BulkSelection {
  const tables = tableNames(database);
  if (tables.some((table) => !knownOpenCodeTables.has(table))) {
    throw new Error("OpenCode has unknown tables; authentication, settings and conversation ownership cannot be confirmed.");
  }
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('trigger', 'view')").get()) {
    throw new Error("OpenCode has unknown triggers or views; permanent data cannot be safely preserved.");
  }
  for (const table of tables) {
    const columns = columnNames(database, table);
    if ((requiredColumns[table] ?? []).some((column) => !columns.has(column))) {
      throw new Error(`Unsupported OpenCode ${table} schema.`);
    }
    for (const foreign of database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all()) {
      const target = String(foreign.table);
      if (!tables.includes(target) ||
          (!conversationTables.has(table) && !eventTables.has(table) &&
            (conversationTables.has(target) || eventTables.has(target)))) {
        throw new Error(`OpenCode has an unsafe foreign key from ${table} to ${target}; permanent data may depend on conversations.`);
      }
    }
  }
  if (tables.includes("event") !== tables.includes("event_sequence")) {
    throw new Error("Unsupported OpenCode event schema; event and sequence tables are incomplete.");
  }
  const aggregates = new Set<string>();
  if (tables.includes("session")) {
    for (const row of database.prepare("SELECT id FROM session").iterate()) {
      if (typeof row.id !== "string" || !row.id) throw new Error("Unsupported OpenCode session ID schema.");
      aggregates.add(row.id);
    }
  }
  const eventAggregates = new Set<string>();
  let sharedEvents = false;
  if (tables.includes("event")) {
    const ownership: { aggregate: string; session: unknown }[] = [];
    for (const event of database.prepare("SELECT aggregate_id, type, data FROM event").iterate()) {
      if (typeof event.aggregate_id !== "string" || typeof event.type !== "string" || typeof event.data !== "string") {
        throw new Error("Unsupported OpenCode event contents.");
      }
      let data: unknown;
      try { data = JSON.parse(event.data); }
      catch { throw new Error("OpenCode event contents cannot be validated; deletion canceled."); }
      if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Unsupported OpenCode event contents.");
      const value = data as Record<string, unknown>;
      // 事件類型決定歸屬，避免共用事件被額外的 sessionID 誤列為對話。
      const owner = event.type.startsWith("workspace.") ? "workspaceID"
        : event.type.startsWith("project.") ? "projectID" : "sessionID";
      const scope = value[owner];
      if (typeof scope !== "string" || !scope || scope !== event.aggregate_id ||
          ["sessionID", "workspaceID", "projectID"].some((key) => key !== owner && value[key] !== undefined)) {
        throw new Error("OpenCode event and session ownership do not match; deletion canceled.");
      }
      const session = owner === "sessionID" ? scope : undefined;
      ownership.push({ aggregate: event.aggregate_id, session });
      eventAggregates.add(event.aggregate_id);
      if (typeof session === "string") aggregates.add(session);
      else sharedEvents = true;
    }
    for (const event of ownership) {
      if (aggregates.has(event.aggregate) && event.session !== event.aggregate) {
        throw new Error("OpenCode event and session ownership do not match; deletion canceled.");
      }
    }
    for (const sequence of database.prepare("SELECT aggregate_id FROM event_sequence").iterate()) {
      if (typeof sequence.aggregate_id !== "string" || !sequence.aggregate_id) throw new Error("Unsupported OpenCode event sequence contents.");
      if (aggregates.has(sequence.aggregate_id)) continue;
      if (!eventAggregates.has(sequence.aggregate_id)) {
        throw new Error("OpenCode orphaned event sequence ownership cannot be confirmed; deletion canceled.");
      }
      sharedEvents = true;
    }
  }
  const retainDatabase = sharedEvents || tables.some((table) =>
    !conversationTables.has(table) && !eventTables.has(table) && !migrationTables.has(table) && hasRows(database, table));
  return { tables, aggregates, retainDatabase };
}

function clearConversations(database: DatabaseSync, selection: BulkSelection): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON");
  withSqliteTransaction(database, () => {
    const assertRetained = protectSqliteRows(database, (table, row) =>
      conversationTables.has(table) || (eventTables.has(table) && typeof row.aggregate_id === "string" && selection.aggregates.has(row.aggregate_id)));
    if (selection.tables.includes("event")) {
      for (const aggregate of selection.aggregates) {
        database.prepare("DELETE FROM event WHERE aggregate_id = ?").run(aggregate);
        database.prepare("DELETE FROM event_sequence WHERE aggregate_id = ?").run(aggregate);
      }
    }
    for (const table of ["part", "message", "todo", "session_share", "session_context_epoch", "session_input", "session_message", "session"]) {
      if (selection.tables.includes(table)) database.exec(`DELETE FROM ${quoteIdentifier(table)}`);
    }
    assertRetained();
    if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("OpenCode foreign key validation failed.");
  });
  const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (checkpoint && checkpoint.busy !== 0) throw new Error("OpenCode WAL is still in use; keep the recovery backups.");
}
