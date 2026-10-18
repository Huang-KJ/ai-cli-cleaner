import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { columnNames, protectSqliteRows, tableNames, withSqliteTransaction } from "./sqlite.js";
import { createPathWalkBudget, getCanonicalPath, pathExists, readDirectoryBounded, type PathWalkBudget } from "../fs/paths.js";
import {
  assertMetadataInventoryUnchanged, atomicRewrite, createMetadataInventory,
  rehearseMetadata, type MetadataInventory
} from "./metadata-safety.js";
import { createMetadataPlan, type ProviderDeletionPlan } from "./metadata-plan.js";
import { validateExactStoragePath } from "./owned-paths.js";
import { assertConversationId, type ConversationRecord } from "./types.js";

async function validateGrokConversation(
  conversation: ConversationRecord,
  home: string,
  budget = createPathWalkBudget()
): Promise<string[]> {
  if (conversation.providerId !== "grok" || conversation.dataPaths.length !== 1) {
    throw new Error("Grok requires exactly one verifiable session directory.");
  }
  assertConversationId(conversation.id);
  const root = path.join(home, ".grok");
  const directory = conversation.dataPaths[0]!;
  const parts = path.relative(root, directory).split(path.sep);
  if (!path.isAbsolute(directory) || parts.length !== 3 || parts[0] !== "sessions") {
    throw new Error("Grok session path is outside the allowed scope.");
  }
  for (const part of parts) assertConversationId(part);
  const check = await validateExactStoragePath(directory, root, parts, "directory");
  if (check.status !== "valid") throw new Error(check.status === "invalid" ? check.reason : "The Grok session no longer exists.");
  const summary = await readSummary(root, parts);
  const info = isRecord(summary.info) ? summary.info : {};
  const id = typeof info.id === "string" ? info.id : typeof info.session_id === "string" ? info.session_id : parts[2];
  if (id !== conversation.id) throw new Error("Grok summary ID does not match the selected conversation.");
  // 目錄中的符號連結雖不會被追蹤，仍拒絕不明歸屬的對話資料。
  await assertNormalTree(directory, budget);
  return [directory];
}

export async function prepareGrokDeletion(conversation: ConversationRecord, home: string, previewIds?: string[]): Promise<ProviderDeletionPlan> {
  const budget = createPathWalkBudget();
  const dataPaths = await validateGrokConversation(conversation, home, budget);
  const root = path.join(home, ".grok");
  const search = path.join(root, "sessions", "session_search.sqlite");
  const active = path.join(root, "active_sessions.json");
  await assertNoPendingRegistry(root);
  const inventory = await createMetadataInventory([search, active], root, home);
  await assertNoGrokChildren(root, conversation.id, dataPaths[0]!, previewIds, budget);
  const edit = async (files: Map<string, string>, workInventory?: MetadataInventory) => {
    const searchFile = files.get(search)!;
    const activeFile = files.get(active)!;
    if (await pathExists(searchFile)) editSearch(searchFile, conversation.id);
    if (await pathExists(activeFile)) await editActive(activeFile, conversation.id, workInventory);
  };
  const changed = await rehearseMetadata(inventory, edit);
  const metadata = createMetadataPlan({
    home, inventory, changedPaths: changed, providerId: "grok", conversationIds: [conversation.id],
    previewOnly: Boolean(previewIds),
    beforeWrite: async () => {
      await assertNoPendingRegistry(root);
      await assertNoGrokChildren(root, conversation.id, dataPaths[0]!);
    },
    write: async (markChanged, copies, workInventory) => {
      markChanged();
      await edit(copies, workInventory);
    }
  });
  return {
    dataPaths,
    get recoveryPath() { return metadata.recoveryPath; },
    prepareRecovery: metadata.prepareRecovery,
    guardPaths: [...inventory.entries.map((entry) => entry.path), path.join(root, "active_sessions.lock"), path.join(root, "sessions")],
    validate: async () => {
      const validationBudget = createPathWalkBudget();
      await assertNoPendingRegistry(root);
      await assertMetadataInventoryUnchanged(inventory);
      await validateGrokConversation(conversation, home, validationBudget);
      await assertNoGrokChildren(root, conversation.id, dataPaths[0]!, previewIds, validationBudget);
    },
    execute: metadata.execute
  };
}

async function readSummary(root: string, parts: string[]): Promise<Record<string, unknown>> {
  const file = path.join(root, ...parts, "summary.json");
  const check = await validateExactStoragePath(file, root, [...parts, "summary.json"], "file");
  if (check.status !== "valid") throw new Error(check.status === "invalid" ? check.reason : "Grok summary is missing; conversation ownership cannot be confirmed.");
  const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  if (!isRecord(value)) throw new Error("Unrecognized Grok summary format.");
  assertGrokSummaryOwnership(value);
  return value;
}

export function assertGrokSummaryOwnership(summary: Record<string, unknown>): void {
  if (isRecord(summary.info)) {
    const info = summary.info;
    const ids = ["id", "session_id"].filter((key) => Object.hasOwn(info, key)).map((key) => info[key]);
    if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size > 1) {
      throw new Error("Grok summary session identifiers conflict or are invalid; ownership cannot be confirmed.");
    }
  }
}

async function assertNormalTree(directory: string, budget: PathWalkBudget, depth = 0): Promise<void> {
  for await (const entry of readDirectoryBounded(directory, budget, depth)) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error("Grok session contains symbolic links or non-regular files.");
    }
    if (entry.isDirectory()) await assertNormalTree(path.join(directory, entry.name), budget, depth + 1);
  }
}

async function assertNoGrokChildren(
  root: string,
  id: string,
  selected: string,
  previewIds: string[] = [],
  budget = createPathWalkBudget()
): Promise<void> {
  const sessions = path.join(root, "sessions");
  const selectedPath = await getCanonicalPath(selected);
  for await (const group of readDirectoryBounded(sessions, budget)) {
    if (group.isSymbolicLink()) throw new Error("Grok working directory contains a symbolic link; child conversations cannot be validated.");
    if (!group.isDirectory()) continue;
    const groupCheck = await validateExactStoragePath(path.join(sessions, group.name), root, ["sessions", group.name], "directory");
    if (groupCheck.status !== "valid") throw new Error("Grok working directory cannot be validated.");
    for await (const child of readDirectoryBounded(groupCheck.path, budget, 1)) {
      if (child.isSymbolicLink()) throw new Error("Grok session contains a symbolic link; child conversations cannot be validated.");
      if (!child.isDirectory()) continue;
      if (path.join(groupCheck.path, child.name) === selectedPath) continue;
      const summary = await readSummary(root, ["sessions", group.name, child.name]);
      const info = isRecord(summary.info) ? summary.info : {};
      const childId = typeof info.id === "string" ? info.id
        : typeof info.session_id === "string" ? info.session_id : child.name;
      if (childId === id) throw new Error("Another Grok directory has the same session ID; unique ownership cannot be confirmed.");
      if (summary.parent_session_id === id && !previewIds.includes(childId)) throw new Error("The Grok parent conversation still has children; delete its child conversations first.");
    }
  }
}

async function editActive(file: string, id: string, inventory?: MetadataInventory): Promise<void> {
  const source = await fs.readFile(file, "utf8");
  const rows: unknown = source.trim() ? JSON.parse(source) : [];
  if (!Array.isArray(rows) || rows.some((row) => !isRecord(row) || typeof row.session_id !== "string" ||
    !Number.isInteger(row.pid) || Number(row.pid) <= 0 || typeof row.cwd !== "string" || typeof row.opened_at !== "string")) {
    throw new Error("Unsupported Grok active_sessions format.");
  }
  for (const row of rows.filter((row) => row.session_id === id)) {
    try {
      process.kill(row.pid, 0);
      throw new Error("The Grok conversation still has running processes; close the agent first.");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  }
  const retained = rows.filter((row) => row.session_id !== id);
  if (retained.length !== rows.length) await atomicRewrite(file, `${JSON.stringify(retained, null, 2)}\n`, inventory);
}

function editSearch(file: string, id: string): void {
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA secure_delete = ON");
    withSqliteTransaction(database, () => {
      const names = tableNames(database);
      const allowed = new Set(["meta", "session_docs", "session_docs_fts", "session_docs_fts_data", "session_docs_fts_idx",
        "session_docs_fts_docsize", "session_docs_fts_config"]);
      if (names.some((name) => !allowed.has(String(name))) || !names.includes("session_docs") || !names.includes("session_docs_fts")) {
        throw new Error("Unsupported Grok search index tables.");
      }
      const columns = columnNames(database, "session_docs");
      if (!["session_id", "cwd", "updated_at", "title", "content", "content_hash"].every((name) => columns.has(name))) {
        throw new Error("Unsupported Grok search index schema.");
      }
      const triggers = database.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all().map((row) => row.name);
      if (triggers.some((name) => !["session_docs_ai", "session_docs_ad", "session_docs_au"].includes(String(name))) ||
        !triggers.includes("session_docs_ad")) throw new Error("Grok search index triggers cannot be validated.");
      if (["rowid", "_rowid_", "oid"].some((name) => columns.has(name))) {
        throw new Error("Unsupported Grok search index row identity.");
      }
      const read = database.prepare("SELECT rowid, * FROM session_docs ORDER BY rowid");
      read.setReadBigInts(true);
      const rows = read.all();
      const ids = new Set<string>();
      for (const row of rows) {
        if (typeof row.session_id !== "string" || !row.session_id || ids.has(row.session_id)) {
          throw new Error("Grok search index session IDs must be unique nonempty strings.");
        }
        ids.add(row.session_id);
      }
      // ID 以 JavaScript 精確比對，避免資料庫定序與型別親和性擴張刪除範圍。
      const assertRetained = protectSqliteRows(database, (table, row) =>
        table === "session_docs" && row.session_id === id,
      new Set(names.filter((name) => name.startsWith("session_docs_fts"))));
      const retained = () => JSON.stringify(read.all().filter((row) => row.session_id !== id),
        (_, value) => typeof value === "bigint" ? { sqliteInteger: String(value) } : value);
      const before = retained();
      const remove = database.prepare("DELETE FROM session_docs WHERE rowid = ?");
      for (const row of rows) {
        if (row.session_id === id) remove.run(row.rowid!);
      }
      if (read.all().some((row) => row.session_id === id)) {
        throw new Error("The selected Grok conversation remains in the search index after deletion; cleanup cannot be completed.");
      }
      assertRetained();
      if (retained() !== before) throw new Error("Unselected Grok indexes changed.");
      database.exec("INSERT INTO session_docs_fts(session_docs_fts, rank) VALUES('integrity-check', 1)");
    });
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint && checkpoint.busy !== 0) throw new Error("Grok search index WAL is still in use; keep the recovery backups.");
  } finally {
    database.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertNoPendingRegistry(root: string): Promise<void> {
  const file = path.join(root, "active_sessions.json.tmp");
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Grok has an unfinished active index write. Start and exit Grok normally, then check again, or use bulk cleanup for this agent. This tool does not automatically repair the temporary index.");
}
