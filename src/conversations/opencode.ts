import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertMetadataInventoryUnchanged, createMetadataInventory, rehearseMetadata, withPrivateReadDatabase
} from "./metadata-safety.js";
import { columnNames, protectSqliteRows, tableNames, withSqliteTransaction } from "./sqlite.js";
import { createMetadataPlan, type ProviderDeletionPlan } from "./metadata-plan.js";
import { validateExactStoragePath } from "./owned-paths.js";
import { assertConversationId, type ConversationRecord } from "./types.js";

export const knownOpenCodeTables: ReadonlySet<string> = new Set(["session", "message", "part", "todo", "session_share", "project", "permission",
  "workspace", "account", "account_state", "control_account", "__drizzle_migrations", "credential",
  "session_context_epoch", "session_input", "session_message", "event", "event_sequence", "project_directory",
  "data_migration", "migration"]);

interface OpenCodeSession {
  id: string;
  parentId?: string;
  title: string;
  directory: string;
  updated: number;
}

const openCodeSessionQuery =
  "SELECT id, parent_id, title, directory, time_updated FROM session";
export const OPENCODE_SESSION_LIMITS = { rows: 100_000, depth: 1024 } as const;
const sessionTables = ["part", "message", "todo", "session_share", "session_context_epoch", "session_input", "session_message"];

function openCodeRoot(home: string): string {
  return path.join(home, ".local", "share", "opencode");
}

export async function readOpenCodeSessions(home: string): Promise<OpenCodeSession[]> {
  const root = openCodeRoot(home);
  const file = path.join(root, "opencode.db");
  const inventory = await createMetadataInventory([file], root, home);
  if (!inventory.entries.find((entry) => entry.path === file)?.identity) {
    await assertNoLegacyOpenCode(root);
    return [];
  }
  return withPrivateReadDatabase(home, root, file, async (database) => {
      const sessions: OpenCodeSession[] = [];
      for (const row of database.prepare(`${openCodeSessionQuery} LIMIT ?`).iterate(OPENCODE_SESSION_LIMITS.rows + 1)) {
        if (sessions.length >= OPENCODE_SESSION_LIMITS.rows) throw new Error("OpenCode session resource limit exceeded; too many rows.");
        if (typeof row.id !== "string" || (row.parent_id !== null && typeof row.parent_id !== "string") ||
          typeof row.title !== "string" || typeof row.directory !== "string" ||
          typeof row.time_updated !== "number" || !Number.isFinite(row.time_updated)) {
          throw new Error("Unsupported OpenCode session schema; the complete parent-child relationships cannot be confirmed.");
        }
        assertConversationId(row.id);
        if (typeof row.parent_id === "string") assertConversationId(row.parent_id);
        sessions.push({ id: row.id, parentId: typeof row.parent_id === "string" ? row.parent_id : undefined,
          title: row.title, directory: row.directory, updated: row.time_updated });
      }
      const byId = new Map(sessions.map((session) => [session.id, session]));
      if (byId.size !== sessions.length) throw new Error("OpenCode sessions contain duplicate IDs.");
      const depths = new Map<string, number>();
      const visiting = new Set<string>();
      for (const session of sessions) {
        if (depths.has(session.id)) continue;
        const chain: string[] = [];
        let current: OpenCodeSession | undefined = session;
        while (current && !depths.has(current.id)) {
          if (visiting.has(current.id)) throw new Error("OpenCode session parent-child relationships contain a cycle.");
          visiting.add(current.id);
          chain.push(current.id);
          if (chain.length > OPENCODE_SESSION_LIMITS.depth) throw new Error("OpenCode session resource limit exceeded; parent chain is too deep.");
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        let depth = current ? depths.get(current.id)! : 0;
        for (const id of chain.reverse()) {
          if (++depth > OPENCODE_SESSION_LIMITS.depth) throw new Error("OpenCode session resource limit exceeded; parent chain is too deep.");
          visiting.delete(id);
          depths.set(id, depth);
        }
      }
      await assertMetadataInventoryUnchanged(inventory);
      return sessions;
  });
}

export async function prepareOpenCodeDeletion(
  conversation: ConversationRecord,
  home: string,
  previewIds?: string[]
): Promise<ProviderDeletionPlan> {
  if (conversation.providerId !== "opencode") throw new Error("OpenCode deletion target does not match.");
  assertConversationId(conversation.id);
  const root = openCodeRoot(home);
  const file = path.join(root, "opencode.db");
  const inventory = await createMetadataInventory([file], root, home);
  if (!inventory.entries.find((entry) => entry.path === file)?.identity) {
    throw new Error("OpenCode SQLite database not found; rescan.");
  }
  await assertNoLegacyOpenCode(root);
  const diff = path.join(root, "storage", "session_diff", `${conversation.id}.json`);
  const validateDiff = async () => {
    const check = await validateExactStoragePath(diff, root,
      ["storage", "session_diff", `${conversation.id}.json`], "file");
    if (check.status === "invalid") throw new Error(check.reason);
    return check.status === "valid" ? [diff] : [];
  };
  const dataPaths = await validateDiff();
  const assertDiffUnchanged = async (expected: string[]) => {
    const actual = await validateDiff();
    if (actual.length !== expected.length || actual.some((file) => !expected.includes(file))) {
      throw new Error("OpenCode conversation diffs were added or removed after preflight; refresh the conversation list.");
    }
  };
  const changed = await rehearseMetadata(inventory, async (copies) => {
    const copy = copies.get(file);
    if (!copy) throw new Error("OpenCode metadata preview mapping is missing.");
    editOpenCodeDatabase(copy, conversation.id, previewIds);
  });
  const metadata = createMetadataPlan({
    home, inventory, changedPaths: changed, providerId: "opencode", conversationIds: [conversation.id],
    previewOnly: Boolean(previewIds),
    beforeWrite: () => assertDiffUnchanged([]),
    write: async (markChanged, copies) => {
      markChanged();
      editOpenCodeDatabase(copies.get(file)!, conversation.id);
    }
  });
  return {
    guardPaths: [root, ...inventory.entries.map((entry) => entry.path)],
    dataPaths,
    get recoveryPath() { return metadata.recoveryPath; },
    prepareRecovery: metadata.prepareRecovery,
    validate: async () => {
      await assertMetadataInventoryUnchanged(inventory);
      await assertNoLegacyOpenCode(root);
      await assertDiffUnchanged(dataPaths);
    },
    execute: metadata.execute
  };
}

function editOpenCodeDatabase(file: string, id: string, previewIds: string[] = []): void {
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON");
    withSqliteTransaction(database, () => {
      const names = tableNames(database);
      if (names.some((name) => !knownOpenCodeTables.has(name)) || !["session", "message", "part"].every((name) => names.includes(name))) {
        throw new Error("Unsupported OpenCode tables; refusing to leave unknown conversation indexes behind.");
      }
      if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger'").get()) {
        throw new Error("OpenCode has unknown triggers; changes to other conversations cannot be ruled out.");
      }
      const session = database.prepare("SELECT * FROM session WHERE id = ?").get(id);
      if (!session) throw new Error("The OpenCode conversation no longer exists; rescan.");
      if (database.prepare("SELECT id FROM session WHERE parent_id = ?").all(id)
        .some((row) => !previewIds.includes(String(row.id)))) {
        throw new Error("The OpenCode parent conversation still has children; delete its child conversations first.");
      }
      const required: Record<string, string[]> = {
        session: ["id", "parent_id"], message: ["id", "session_id"],
        part: ["id", "message_id", "session_id"], todo: ["session_id"], session_share: ["session_id"],
        session_context_epoch: ["session_id", "baseline", "snapshot", "baseline_seq"],
        session_input: ["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"],
        session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
        event_sequence: ["aggregate_id", "seq", "owner_id"], event: ["id", "aggregate_id", "seq", "type", "data"]
      };
      for (const [name, columns] of Object.entries(required)) {
        if (!names.includes(name)) continue;
        const actual = columnNames(database, name);
        if (columns.some((column) => !actual.has(column))) throw new Error(`Unsupported OpenCode ${name} schema.`);
      }
      if (database.prepare("SELECT 1 FROM part p JOIN message m ON p.message_id=m.id WHERE p.session_id IS NOT m.session_id").get()) {
        throw new Error("OpenCode messages and parts have inconsistent session ownership.");
      }
      if (names.includes("session_input") && names.includes("session_message") &&
          database.prepare("SELECT 1 FROM session_input i JOIN session_message m ON i.id=m.id WHERE i.session_id IS NOT m.session_id").get()) {
        throw new Error("OpenCode inputs and messages have inconsistent session ownership.");
      }
      if (names.includes("event") !== names.includes("event_sequence")) {
        throw new Error("Unsupported OpenCode event schema; event and sequence tables are incomplete.");
      }
      if (names.includes("event")) {
        // 官方 durable aggregate 是 sessionID；owner_id 是同步所有者，不能用來選取對話。
        for (const event of database.prepare("SELECT aggregate_id, data FROM event").iterate()) {
          let data: unknown;
          try { data = JSON.parse(String(event.data)); }
          catch { throw new Error("OpenCode event contents cannot be validated; deletion canceled."); }
          const sessionId = typeof data === "object" && data !== null && !Array.isArray(data)
            ? (data as Record<string, unknown>).sessionID : undefined;
          if ((event.aggregate_id === id && sessionId !== id) ||
              (event.aggregate_id !== id && sessionId === id)) {
            throw new Error("OpenCode event and session ownership do not match; deletion canceled.");
          }
        }
      }
      const assertRetained = protectSqliteRows(database, (table, row) => {
        const column = table === "session" ? "id"
          : sessionTables.includes(table) ? "session_id"
            : ["event", "event_sequence"].includes(table) ? "aggregate_id" : undefined;
        return column !== undefined && row[column] === id;
      });
      if (names.includes("event")) {
        database.prepare("DELETE FROM event WHERE aggregate_id = ?").run(id);
        database.prepare("DELETE FROM event_sequence WHERE aggregate_id = ?").run(id);
      }
      for (const table of sessionTables) {
        if (names.includes(table)) database.prepare(`DELETE FROM "${table}" WHERE session_id = ?`).run(id);
      }
      database.prepare("DELETE FROM session WHERE id = ?").run(id);
      assertRetained();
      if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("OpenCode foreign key validation failed.");
    });
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint && checkpoint.busy !== 0) throw new Error("OpenCode WAL is still in use; keep the recovery backups.");
  } finally {
    database.close();
  }
}

async function assertNoLegacyOpenCode(root: string): Promise<void> {
  // 舊格式可能仍保存另一份逐字稿，不能只刪資料庫便宣稱完成。
  for (const name of ["session", "message", "part", "todo", "session_share"]) {
    const legacy = path.join(root, "storage", name);
    const check = await validateExactStoragePath(legacy, root, ["storage", name], "directory");
    if (check.status === "invalid" || (check.status === "valid" && (await fs.readdir(legacy)).length > 0)) {
      throw new Error("OpenCode contains legacy or unverifiable conversation storage; individual conversations cannot be safely deleted.");
    }
  }
}
