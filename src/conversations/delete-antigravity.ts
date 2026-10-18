import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanEntries, validateEntries } from "../cleaners/clean.js";
import { pathExists } from "../fs/paths.js";
import { assertAntigravityPathsUnchanged, assertAntigravitySharedIndexSupported } from "./discover-antigravity.js";
import { createMetadataPlan, type MetadataPlan } from "./metadata-plan.js";
import { columnNames, protectSqliteRows, quoteIdentifier, tableExists, tableNames, withSqliteTransaction } from "./sqlite.js";
import { assertSafeHomePaths, scanConversationPaths, validateExactStoragePath, validateOwnedConversationPaths } from "./owned-paths.js";
import {
  assertMetadataInventoryUnchanged,
  assertMetadataTargetUnchanged,
  atomicRewrite,
  attachMetadataFailure,
  createMetadataInventory,
  rehearseMetadata,
  withSqliteSidecars,
  type MetadataInventory
} from "./metadata-safety.js";
import { assertConversationId } from "./types.js";
import { antigravityHistoryId, isRecord } from "./metadata-values.js";
import { readJsonlLines, rewriteJsonl, validateJsonl } from "./metadata-jsonl.js";
import type { ConversationDeleteResult, ConversationRecord, DeleteConversationOptions } from "./types.js";

export async function deleteAntigravityConversation(
  conversation: ConversationRecord,
  options: DeleteConversationOptions,
  result: Pick<ConversationDeleteResult, "openFileCheckUnsupported">
): Promise<void> {
  const home = options.home ?? homedir();
  let movedPaths: string[] = [];
  let metadataChanged = false;
  let plan: MetadataPlan | undefined;
  try {
    assertConversationId(conversation.id);
    validateConversation(conversation);
    if (conversation.disabledReason) throw new Error(conversation.disabledReason);
    await assertAntigravitySharedIndexSupported(home);

    const entries = await scanConversationPaths(conversation, home);
    const metadataPaths = getMetadataPaths(conversation);
    const guardPaths = [...new Set([
      ...entries.filter((entry) => entry.exists).map((entry) => entry.path),
      ...conversation.guardPaths,
      ...metadataPaths
    ])];
    await assertSafeHomePaths(guardPaths, home, "inspect");

    const guardCheck = await options.checkOpenPaths(guardPaths);
    if (!guardCheck.supported) result.openFileCheckUnsupported = true;
    if (!guardCheck.supported) {
      throw new Error("Cannot check whether files are open; close the Antigravity IDE and CLI, then retry.");
    }
    if (guardCheck.openPaths.length > 0) {
      throw new Error(`Refusing to delete open files: ${guardCheck.openPaths.join(", ")}`);
    }
    await assertAntigravitySharedIndexSupported(home);

    const inventory = await createMetadataInventory(
      metadataBasePaths(conversation),
      path.join(home, ".gemini", "antigravity-cli"),
      home
    );
    const changedPaths = await rehearseMetadata(inventory, async (copies) => {
      await updateMetadata(mapMetadataPaths(conversation, copies));
    });
    plan = createMetadataPlan({
      home, inventory, changedPaths, providerId: "antigravity", conversationIds: [conversation.id],
      beforeWrite: async () => {
        await assertAntigravitySharedIndexSupported(home);
        await assertAntigravityPathsUnchanged(conversation, home, []);
      },
      write: async (markChanged, copies, workInventory) => {
        const mapped = mapMetadataPaths(conversation, copies);
        await updateMetadata(mapped, workInventory, markChanged);
        await assertAntigravityMetadataDeletionComplete(mapped);
      },
      afterWrite: () => assertAntigravityDeletionComplete(conversation, home)
    });

    if (options.dryRun) {
      await assertAntigravitySharedIndexSupported(home);
      await assertAntigravityPathsUnchanged(conversation, home);
      return;
    }

    await assertMetadataInventoryUnchanged(inventory);
    await validateOwnedConversationPaths(conversation, home);
    await validateEntries(entries);
    await assertAntigravityPathsUnchanged(conversation, home);
    await plan.prepareRecovery();
    await assertMetadataInventoryUnchanged(inventory);
    await assertAntigravitySharedIndexSupported(home);
    await assertAntigravityPathsUnchanged(conversation, home);
    const cleanResult = await cleanEntries(entries, {
      checkOpenPaths: options.checkOpenPaths,
      trash: async (files, expected) => {
        await assertAntigravitySharedIndexSupported(home);
        return options.trash(files, expected);
      }
    });
    if (cleanResult.openFileCheckUnsupported) result.openFileCheckUnsupported = true;
    movedPaths = cleanResult.deleted.map((entry) => entry.path);
    if (cleanResult.failures.length > 0 || cleanResult.scanErrors.length > 0) {
      throw new Error([
        ...cleanResult.failures.map((failure) => failure.error.message),
        ...cleanResult.scanErrors.map((entry) => entry.error?.message ?? `Cannot scan ${entry.path}`)
      ].join("; "));
    }

    await assertMetadataInventoryUnchanged(inventory);
    const metadataCheck = await options.checkOpenPaths(metadataPaths);
    if (!metadataCheck.supported) result.openFileCheckUnsupported = true;
    if (!metadataCheck.supported || metadataCheck.openPaths.length > 0) {
      throw new Error("Pre-update check failed: Antigravity metadata is open or its open-file status cannot be checked.");
    }

    await assertAntigravityPathsUnchanged(conversation, home, []);
    const executed = await plan.execute(options.trash);
    metadataChanged = executed.metadataChanged;
    try {
      await assertAntigravityDeletionComplete(conversation, home);
    } catch (error) {
      if (metadataChanged) {
        throw new Error(`Indexes were updated, but the selected conversation failed completion verification. Recovery backups were moved to Trash; check the deletion result. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      throw error;
    }
  } catch (error) {
    throw attachMetadataFailure(error, {
      deletedPaths: movedPaths, metadataChanged, recoveryPath: plan?.recoveryPath
    });
  }
}

async function assertAntigravityDeletionComplete(conversation: ConversationRecord, home: string): Promise<void> {
  await assertAntigravitySharedIndexSupported(home);
  await assertAntigravityPathsUnchanged(conversation, home, []);
  const strategy = conversation.deleteStrategy;
  if (strategy.kind !== "local" || strategy.metadata?.kind !== "antigravity") {
    throw new Error("Antigravity metadata does not match the deletion target.");
  }
  const root = path.join(home, ".gemini", "antigravity-cli");
  for (const file of getMetadataPaths(conversation)) {
    const check = await validateExactStoragePath(file, root, path.relative(root, file).split(path.sep), "file");
    if (check.status === "invalid") throw new Error(check.reason);
  }
}

async function assertAntigravityMetadataDeletionComplete(conversation: ConversationRecord): Promise<void> {
  const strategy = conversation.deleteStrategy;
  if (strategy.kind !== "local" || strategy.metadata?.kind !== "antigravity") {
    throw new Error("Antigravity metadata does not match the deletion target.");
  }
  const metadata = strategy.metadata;
  await validateAntigravityMetadata(conversation);
  if (metadata.summaryDatabase && await pathExists(metadata.summaryDatabase)) {
    const database = new DatabaseSync(metadata.summaryDatabase, { readOnly: true });
    try {
      for (const table of conversationTables(database)) {
        if (database.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE conversation_id = ? LIMIT 1`).get(conversation.id)) {
          throw new Error(`The selected Antigravity conversation remains in the summary index table ${table}.`);
        }
      }
    } finally { database.close(); }
  }
  if (metadata.historyFile && await pathExists(metadata.historyFile)) {
    for await (const { line } of readJsonlLines(metadata.historyFile)) {
      if (!line.trim()) continue;
      const row: unknown = JSON.parse(line);
      if (antigravityHistoryId(row) === conversation.id) {
        throw new Error("The selected Antigravity conversation remains in the history index.");
      }
    }
  }
  if (metadata.lastConversationsFile && await pathExists(metadata.lastConversationsFile)) {
    const value: unknown = JSON.parse(await fs.readFile(metadata.lastConversationsFile, "utf8"));
    if (!isRecord(value)) throw new Error("Cannot validate the Antigravity recent-conversation cache format.");
    if (Object.values(value).includes(conversation.id)) throw new Error("The selected Antigravity conversation remains in the recent-conversation cache index.");
  }
}

function validateConversation(conversation: ConversationRecord): void {
  if (
    conversation.providerId !== "antigravity" ||
    conversation.deleteStrategy.kind !== "local" ||
    conversation.deleteStrategy.metadata?.kind !== "antigravity"
  ) {
    throw new Error("Only local Antigravity conversation data can be deleted.");
  }
}

function getMetadataPaths(conversation: ConversationRecord): string[] {
  if (conversation.deleteStrategy.kind !== "local") return [];
  const metadata = conversation.deleteStrategy.metadata;
  if (!metadata || metadata.kind !== "antigravity") return [];
  return withSqliteSidecars(metadataBasePaths(conversation));
}

function metadataBasePaths(conversation: ConversationRecord): string[] {
  if (conversation.deleteStrategy.kind !== "local") return [];
  const metadata = conversation.deleteStrategy.metadata;
  if (!metadata || metadata.kind !== "antigravity") return [];
  return [metadata.summaryDatabase, metadata.historyFile, metadata.lastConversationsFile]
    .filter((file): file is string => Boolean(file));
}


function mapMetadataPaths(
  conversation: ConversationRecord,
  copies: Map<string, string>
): ConversationRecord {
  if (conversation.deleteStrategy.kind !== "local" || conversation.deleteStrategy.metadata?.kind !== "antigravity") {
    return conversation;
  }
  const metadata = conversation.deleteStrategy.metadata;
  const map = (file: string | undefined): string | undefined => {
    if (file === undefined) return undefined;
    const mapped = copies.get(path.resolve(file));
    if (!mapped) throw new Error(`Antigravity metadata is missing a temporary preflight path: ${file}`);
    return mapped;
  };
  return {
    ...conversation,
    deleteStrategy: {
      ...conversation.deleteStrategy,
      metadata: {
        ...metadata,
        summaryDatabase: map(metadata.summaryDatabase),
        historyFile: map(metadata.historyFile),
        lastConversationsFile: map(metadata.lastConversationsFile)
      }
    }
  };
}

async function validateAntigravityMetadata(conversation: ConversationRecord): Promise<void> {
  if (conversation.deleteStrategy.kind !== "local" || conversation.deleteStrategy.metadata?.kind !== "antigravity") return;
  const metadata = conversation.deleteStrategy.metadata;
  if (metadata.summaryDatabase && await pathExists(metadata.summaryDatabase)) {
    const database = new DatabaseSync(metadata.summaryDatabase, { readOnly: true });
    try {
      if (!tableExists(database, "conversation_summaries")) {
        throw new Error(`Antigravity metadata is missing the conversation_summaries table: ${metadata.summaryDatabase}`);
      }
      const columns = columnNames(database, "conversation_summaries");
      if (!columns.has("conversation_id")) {
        throw new Error(`Antigravity conversation_summaries is missing the conversation_id column: ${metadata.summaryDatabase}`);
      }
    } finally {
      database.close();
    }
  }
  if (metadata.historyFile && await pathExists(metadata.historyFile)) {
    await validateJsonl(metadata.historyFile, "Antigravity");
    for await (const { line } of readJsonlLines(metadata.historyFile)) {
      if (line.trim()) antigravityHistoryId(JSON.parse(line));
    }
  }
  if (metadata.lastConversationsFile && await pathExists(metadata.lastConversationsFile)) {
    const value: unknown = JSON.parse(await fs.readFile(metadata.lastConversationsFile, "utf8"));
    if (!isRecord(value)) throw new Error(`Unrecognized recent-conversation cache: ${metadata.lastConversationsFile}`);
  }
}

async function updateMetadata(
  conversation: ConversationRecord,
  inventory?: MetadataInventory,
  markChanged?: () => void
): Promise<void> {
  if (conversation.deleteStrategy.kind !== "local" || conversation.deleteStrategy.metadata?.kind !== "antigravity") return;
  const metadata = conversation.deleteStrategy.metadata;
  await validateAntigravityMetadata(conversation);
  if (metadata.summaryDatabase && await pathExists(metadata.summaryDatabase)) {
    await assertMetadataTargetUnchanged(metadata.summaryDatabase, inventory);
    const database = new DatabaseSync(metadata.summaryDatabase);
    try {
      database.exec("PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON");
      const deletion = withSqliteTransaction(database, () => {
        const tables = conversationTables(database);
        const selected = new Set(tables);
        const assertRetained = protectSqliteRows(database, (table, row) =>
          selected.has(table) && row.conversation_id === conversation.id);
        // 關聯列可能互相參照，統一在交易完成前驗證外鍵及其他對話。
        database.exec("PRAGMA defer_foreign_keys = ON");
        let changes = 0;
        for (const table of tables) {
          changes += Number(database.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE conversation_id = ?`)
            .run(conversation.id).changes);
        }
        assertRetained();
        if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("Antigravity metadata foreign key validation failed.");
        return { changes };
      });
      if (deletion.changes > 0) markChanged?.();
    } finally {
      database.close();
    }
  }
  if (metadata.historyFile) {
    await rewriteJsonl(metadata.historyFile, "Antigravity", (record) =>
      antigravityHistoryId(record) !== conversation.id,
      inventory,
      markChanged
    );
  }
  if (metadata.lastConversationsFile) {
    await removeLastConversationReferences(metadata.lastConversationsFile, conversation.id, inventory, markChanged);
  }
}

function conversationTables(database: DatabaseSync): string[] {
  return tableNames(database).filter((table) => columnNames(database, table).has("conversation_id"))
    .sort((first, second) => Number(first === "conversation_summaries") - Number(second === "conversation_summaries"));
}

// 快取以工作目錄為鍵，只移除值完全等於所選 ID 的項目。
async function removeLastConversationReferences(
  file: string,
  id: string,
  inventory?: MetadataInventory,
  markChanged?: () => void
): Promise<void> {
  if (!(await pathExists(file))) return;
  const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  if (!isRecord(value)) throw new Error(`Unrecognized recent-conversation cache: ${file}`);
  const entries = Object.entries(value);
  const kept = entries.filter(([, conversationId]) => conversationId !== id);
  if (kept.length === entries.length) return;
  await atomicRewrite(file, JSON.stringify(Object.fromEntries(kept), null, 2) + "\n", inventory);
  markChanged?.();
}
