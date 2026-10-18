import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { columnNames, tableExists, tableNames, withSqliteTransaction } from "../src/conversations/sqlite.js";

describe("shared SQLite mechanisms", () => {
  it("commits synchronous results and rolls back changes when the operation fails", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("CREATE TABLE items (value TEXT)");
      expect(withSqliteTransaction(database, () => {
        database.exec("INSERT INTO items VALUES ('committed')");
        return "result";
      })).toBe("result");
      const failure = new Error("operation failed");
      expect(() => withSqliteTransaction(database, () => {
        database.exec("INSERT INTO items VALUES ('rolled-back')");
        throw failure;
      })).toThrow(failure);
      expect(database.prepare("SELECT * FROM items").all()).toEqual([{ value: "committed" }]);
      expect(database.isTransaction).toBe(false);
    } finally { database.close(); }
  });

  it("preserves a trigger error when SQLite automatically rolls back the transaction", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE items (value TEXT); INSERT INTO items VALUES ('keep');
        CREATE TRIGGER stop_delete BEFORE DELETE ON items BEGIN SELECT RAISE(ROLLBACK, 'trigger stopped deletion'); END;`);
      expect(() => withSqliteTransaction(database, () => database.exec("DELETE FROM items")))
        .toThrow("trigger stopped deletion");
      expect(database.prepare("SELECT * FROM items").all()).toEqual([{ value: "keep" }]);
      expect(database.isTransaction).toBe(false);
    } finally { database.close(); }
  });

  it("preserves both the operation error and a failed rollback", () => {
    const database = new DatabaseSync(":memory:");
    const exec = database.exec.bind(database);
    const failure = new Error("operation failed");
    const rollback = new Error("rollback failed");
    const spy = vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") throw rollback;
      exec(sql);
    });
    try {
      let received: unknown;
      try {
        withSqliteTransaction(database, () => { throw failure; });
      } catch (error) { received = error; }
      expect(received).toBeInstanceOf(AggregateError);
      expect(received).toMatchObject({ message: failure.message, cause: failure, errors: [failure, rollback] });
    } finally { spy.mockRestore(); database.close(); }
  });

  it("preserves table enumeration order and handles quoted identifiers", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec('CREATE TABLE z (id TEXT); CREATE TABLE a (id TEXT); CREATE TABLE "table""name" ("column""name" TEXT);');
      expect(tableNames(database)).toEqual(["z", "a", 'table"name']);
      expect(tableExists(database, 'table"name')).toBe(true);
      expect(tableExists(database, "missing")).toBe(false);
      expect(columnNames(database, 'table"name')).toEqual(new Set(['column"name']));
    } finally { database.close(); }
  });
});
