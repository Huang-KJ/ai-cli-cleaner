import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type RowSelector = (table: string, row: Record<string, unknown>) => boolean;
export type SqliteSelection = (database: DatabaseSync) => RowSelector;

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function tableNames(database: DatabaseSync): string[] {
  return database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'")
    .all().flatMap((row) => typeof row.name === "string" ? [row.name] : []);
}

export function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) !== undefined;
}

export function columnNames(database: DatabaseSync, table: string): Set<string> {
  return new Set(database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all().flatMap((row) => typeof row.name === "string" ? [row.name] : []));
}

// 呼叫端保留 PRAGMA、schema 與資料保護規則，這裡只管理同步交易。
export function withSqliteTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], error instanceof Error ? error.message : String(error), { cause: error });
      }
    }
    throw error;
  }
}

function tableRows(database: DatabaseSync, table: string): Record<string, unknown>[] {
  const statement = database.prepare(`SELECT * FROM ${quoteIdentifier(table)}`);
  statement.setReadBigInts(true);
  return statement.all();
}

function serializeRows(rows: Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row, (_, value) =>
    typeof value === "bigint" ? { sqliteInteger: String(value) } : value)).sort();
}

export function sqliteSelectionSnapshot(database: DatabaseSync, selected: RowSelector): string {
  const hash = createHash("sha256");
  for (const table of tableNames(database).sort()) {
    const rows = tableRows(database, table).filter((row) => selected(table, row));
    if (rows.length) hash.update(JSON.stringify([table, serializeRows(rows)]));
  }
  return hash.digest("hex");
}

// 外鍵及觸發器可能連帶變更其他對話；只允許明確選取的資料列消失。
export function protectSqliteRows(
  database: DatabaseSync,
  selected: RowSelector,
  ignoredTables: ReadonlySet<string> = new Set()
): () => void {
  const snapshot = (table: string): { contents: string; hasSelected: boolean } => {
    let hasSelected = false;
    const rows = tableRows(database, table).filter((row) => {
      if (!selected(table, row)) return true;
      hasSelected = true;
      return false;
    });
    return { contents: JSON.stringify(serializeRows(rows)), hasSelected };
  };
  const before = new Map(tableNames(database).sort().filter((table) => !ignoredTables.has(table))
    .map((table) => [table, snapshot(table)]));
  return () => {
    let remainingTable: string | undefined;
    for (const [table, original] of before) {
      const current = snapshot(table);
      if (current.contents !== original.contents) throw new Error(`Unselected data in ${table} changed; deletion canceled.`);
      if (current.hasSelected && remainingTable === undefined) remainingTable = table;
    }
    if (remainingTable !== undefined) throw new Error(`Selected data remains in ${remainingTable}; deletion canceled.`);
  };
}
