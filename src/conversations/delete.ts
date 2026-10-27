import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanEntries, validateEntries, type TrashFn } from "../cleaners/clean.js";
import { pathExists } from "../fs/paths.js";
import { createMetadataPlan } from "./metadata-plan.js";
import { deleteAntigravityConversation } from "./delete-antigravity.js";
import { deleteCodexConversations } from "./delete-codex.js";
import { prepareOpenCodeDeletion } from "./opencode.js";
import { prepareGrokDeletion } from "./grok.js";
import { CLAUDE_SELECTED_REFUSAL } from "./claude.js";
import { assertLocalConversationPathsUnchanged, assertSafeHomePaths, scanConversationPaths, snapshotConversationPaths, validateOwnedConversationPaths } from "./owned-paths.js";
import {
  attachMetadataFailure, createMetadataInventory,
  rehearseMetadata, withSqliteSidecars
} from "./metadata-safety.js";
import { columnNames, protectSqliteRows, quoteIdentifier as quote, tableNames, withSqliteTransaction } from "./sqlite.js";
import { assertConversationId } from "./types.js";
import type {
  ConversationDeleteResult,
  ConversationRecord,
  DeleteConversationOptions
} from "./types.js";

export async function deleteConversations(
  conversations: ConversationRecord[],
  options: DeleteConversationOptions
): Promise<ConversationDeleteResult> {
  const result: ConversationDeleteResult = {
    deleted: [], previewed: [], failures: []
  };
  const unique = [...new Map(conversations.map((item) => [item.key, item])).values()];
  const parents = new Map(unique.filter((item) => item.providerId === "opencode" || item.providerId === "grok")
    .map((item) => [item.key, item.parentId ? `${item.providerId}:${item.parentId}` : undefined]));
  const depth = (item: ConversationRecord): number => {
    const visited = new Set<string>();
    let id: string | undefined = item.key;
    while (id && !visited.has(id)) { visited.add(id); id = parents.get(id); }
    return visited.size;
  };
  unique.sort((a, b) => depth(b) - depth(a));
  const codex = unique.filter((item) => item.providerId === "codex" && item.deleteStrategy.kind === "local");
  const batched = new Set(codex.length > 1 ? codex : []);
  if (batched.size) {
    const eligible: ConversationRecord[] = [];
    for (const conversation of batched) {
      try {
        assertConversationId(conversation.id);
        if (conversation.disabledReason) throw new Error(conversation.disabledReason);
        eligible.push(conversation);
      } catch (error) {
        const failure = attachMetadataFailure(error);
        result.failures.push({ conversation, error: failure });
      }
    }
    if (eligible.length) await deleteCodexConversations(eligible, options, result);
  }
  for (const conversation of unique) {
    if (batched.has(conversation)) continue;
    try {
      assertConversationId(conversation.id);
      if (conversation.disabledReason) throw new Error(conversation.disabledReason);
      if (conversation.providerId === "claude") throw new Error(CLAUDE_SELECTED_REFUSAL);
      if (conversation.providerId === "antigravity") {
        await deleteAntigravityConversation(conversation, options, result);
      } else if (conversation.providerId === "codex" && conversation.deleteStrategy.kind === "local") {
        await deleteCodexConversations([conversation], options, result, false);
        continue;
      } else if (conversation.deleteStrategy.kind === "indexed") {
        await deleteIndexedConversation(conversation, options, result, options.dryRun
          ? unique.filter((item) => item.providerId === conversation.providerId).map((item) => item.id) : undefined);
      } else {
        await deleteCopilotConversation(conversation, options, result);
      }
      (options.dryRun ? result.previewed : result.deleted).push(conversation);
    } catch (error) {
      const failure = attachMetadataFailure(error);
      result.failures.push({ conversation, error: failure, deletedPaths: failure.deletedPaths,
        metadataChanged: failure.metadataChanged, recoveryPath: failure.recoveryPath });
    }
  }
  return result;
}

async function deleteIndexedConversation(
  conversation: ConversationRecord,
  options: DeleteConversationOptions,
  result: ConversationDeleteResult,
  previewIds?: string[]
): Promise<void> {
  const home = options.home ?? homedir();
  if (conversation.providerId !== "opencode" && conversation.providerId !== "grok") {
    throw new Error("Unsupported index deletion strategy for this conversation.");
  }
  const plan = conversation.providerId === "opencode"
    ? await prepareOpenCodeDeletion(conversation, home, previewIds)
    : await prepareGrokDeletion(conversation, home, previewIds);
  const guards = [...new Set([...plan.guardPaths, ...plan.dataPaths])];
  await assertSafeHomePaths(guards, home, "inspect");
  const entries = await snapshotConversationPaths(conversation, plan.dataPaths);
  await plan.validate();
  if (options.dryRun) return;
  const assertClosed = async (): Promise<void> => {
    const check = await options.checkOpenPaths(guards);
    if (!check.supported) result.openFileCheckUnsupported = true;
    if (!check.supported || check.openPaths.length > 0) {
      throw new Error("Deletion refused: conversation data is open or its open-file status cannot be checked; close the relevant agents, then retry.");
    }
  };
  let deletedPaths: string[] = [];
  try {
    await assertClosed();
    await plan.validate();
    await validateEntries(entries);
    await plan.prepareRecovery();
    const cleaned = await cleanEntries(entries, { checkOpenPaths: options.checkOpenPaths, trash: options.trash });
    if (cleaned.openFileCheckUnsupported) result.openFileCheckUnsupported = true;
    deletedPaths = cleaned.deleted.map((entry) => entry.path);
    if (cleaned.failures.length || cleaned.scanErrors.length) {
      throw new Error([...cleaned.failures.map((failure) => failure.error.message),
        ...cleaned.scanErrors.map((entry) => entry.error?.message ?? `Cannot scan ${entry.path}`)].join("; "));
    }
    await assertClosed();
    for (const file of plan.dataPaths) {
      if (await pathExists(file)) throw new Error("Selected conversation data reappeared after being moved; indexes were not updated. Refresh the conversation list.");
    }
    await plan.execute(options.trash);
  } catch (error) {
    throw attachMetadataFailure(error, { deletedPaths, recoveryPath: plan.recoveryPath });
  }
}

async function deleteCopilotConversation(
  conversation: ConversationRecord,
  options: DeleteConversationOptions,
  result: ConversationDeleteResult
): Promise<void> {
  const strategy = conversation.deleteStrategy;
  if (strategy.kind !== "local") throw new Error("The conversation does not use a local deletion strategy.");
  if (conversation.providerId !== "copilot") {
    throw new Error(`Unsupported local conversation deletion target: ${conversation.providerId}`);
  }
  if (strategy.metadata?.kind !== "copilot") {
    throw new Error("Conversation metadata does not match the target.");
  }

  const home = options.home ?? homedir();
  const entries = await scanConversationPaths(conversation, home);
  await assertLocalConversationPathsUnchanged(conversation, home);
  const metadataPaths = withSqliteSidecars(strategy.metadata.sessionStoreDatabase ? [strategy.metadata.sessionStoreDatabase] : []);
  const metadataSet = new Set(metadataPaths.map((file) => path.resolve(file)));
  const ownedGuardPaths = [...new Set([
    ...entries.filter((entry) => entry.exists).map((entry) => entry.path),
    ...conversation.guardPaths.filter((file) => !metadataSet.has(path.resolve(file)))
  ])];
  const guardPaths = [...new Set([...ownedGuardPaths, ...metadataPaths])];
  await assertSafeHomePaths(guardPaths, home, "inspect");
  if (!options.dryRun) {
    const guardCheck = await options.checkOpenPaths(ownedGuardPaths);
    if (!guardCheck.supported) result.openFileCheckUnsupported = true;
    if (!guardCheck.supported) {
      throw new Error("Cannot check whether files are open; close the relevant agents, then retry.");
    }
    if (guardCheck.openPaths.length > 0) {
      throw new Error(`Refusing to delete open files: ${guardCheck.openPaths.join(", ")}`);
    }
    const metadataCheck = await options.checkOpenPaths(metadataPaths);
    if (!metadataCheck.supported) result.openFileCheckUnsupported = true;
    if (!metadataCheck.supported) throw new Error("Cannot check whether index files are open.");
    if (metadataCheck.openPaths.length > 0) {
      throw new Error(`Refusing to delete open files: ${metadataCheck.openPaths.join(", ")}`);
    }
  }
  const plan = await prepareCopilotMetadata(home, strategy.metadata.sessionStoreDatabase, conversation.id, options.trash);
  if (options.dryRun) {
    await assertLocalConversationPathsUnchanged(conversation, home);
    return;
  }

  let deletedPaths: string[] = [];
  try {
    await plan.validate();
    await validateOwnedConversationPaths(conversation, home);
    await validateEntries(entries);
    await plan.prepareRecovery();
    await plan.validate();
    await assertLocalConversationPathsUnchanged(conversation, home);
    const cleanResult = await cleanEntries(entries, {
      checkOpenPaths: options.checkOpenPaths,
      trash: options.trash
    });
    if (cleanResult.openFileCheckUnsupported) result.openFileCheckUnsupported = true;
    deletedPaths = cleanResult.deleted.map((entry) => entry.path);
    if (cleanResult.failures.length > 0 || cleanResult.scanErrors.length > 0) {
      throw attachMetadataFailure(new Error([
        ...cleanResult.failures.map((failure) => failure.error.message),
        ...cleanResult.scanErrors.map((entry) => entry.error?.message ?? `Cannot scan ${entry.path}`)
      ].join("; ")), { metadataChanged: false });
    }
    await plan.validate();
    const metadataCheck = await options.checkOpenPaths(metadataPaths);
    if (!metadataCheck.supported) result.openFileCheckUnsupported = true;
    if (!metadataCheck.supported || metadataCheck.openPaths.length > 0) {
      throw new Error("Pre-update check failed: metadata is open or its open-file status cannot be checked.");
    }
    await assertLocalConversationPathsUnchanged(conversation, home, []);
    await plan.execute();
  } catch (error) {
    throw attachMetadataFailure(error, { deletedPaths, recoveryPath: plan.recoveryPath });
  }
}

async function prepareCopilotMetadata(
  home: string,
  file: string | undefined,
  sessionId: string,
  trash: TrashFn
) {
  const root = path.join(home, ".copilot");
  if (file && path.resolve(file) !== path.resolve(root, "session-store.db")) {
    throw new Error("Copilot metadata must use the default session-store.db.");
  }
  const inventory = await createMetadataInventory(file ? [file] : [], root, home);
  const changed = await rehearseMetadata(inventory, async (copies) => {
    if (file) {
      const copy = copies.get(path.resolve(file));
      if (!copy) throw new Error("Copilot metadata temporary mapping is missing.");
      await deleteCopilotMetadata(copy, sessionId);
    }
  });
  const metadata = createMetadataPlan({
    home, inventory, changedPaths: changed, providerId: "copilot", conversationIds: [sessionId],
    write: async (markChanged, copies) => {
      markChanged();
      if (file) await deleteCopilotMetadata(copies.get(path.resolve(file))!, sessionId);
    }
  });
  return {
    validate: metadata.validate,
    get recoveryPath() { return metadata.recoveryPath; },
    prepareRecovery: metadata.prepareRecovery,
    execute: () => metadata.execute(trash)
  };
}

async function deleteCopilotMetadata(file: string, sessionId: string): Promise<void> {
  if (!(await pathExists(file))) return;
  const database = new DatabaseSync(file);
  try {
    const sessionColumns = columnNames(database, "sessions");
    if (!["id", "session_id", "sessionId"].some((column) => sessionColumns.has(column))) {
      throw new Error("Unsupported Copilot session-store schema: sessions is missing a complete session ID column.");
    }
    database.exec("PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON");
    withSqliteTransaction(database, () => {
      const tables = tableNames(database);
      const tableInfo = database.prepare("PRAGMA table_list").all();
      const shadows = new Set(tableInfo
        .filter((row) => row.type === "shadow").flatMap((row) => typeof row.name === "string" ? [row.name] : []));
      const selected = copilotOwnedRows(database, tables.filter((table) => !shadows.has(table)), sessionId);
      const assertRetained = protectSqliteRows(database, (table, row) =>
        selected.get(table)?.has(copilotRowKey(row)) ?? false, shadows);
      // 延後外鍵驗證，讓多層子表與循環關聯可在同一交易內完整移除。
      database.exec("PRAGMA defer_foreign_keys = ON");
      for (const [table, keys] of selected) {
        if (!keys.size) continue;
        const statement = database.prepare(`SELECT * FROM ${quote(table)}`);
        statement.setReadBigInts(true);
        for (const row of statement.all()) {
          if (!keys.has(copilotRowKey(row))) continue;
          const columns = Object.keys(row);
          database.prepare(`DELETE FROM ${quote(table)} WHERE ${columns.map((column) => `${quote(column)} IS ?`).join(" AND ")}`)
            .run(...Object.values(row) as (string | number | bigint | null | Uint8Array)[]);
        }
      }
      assertRetained();
      // 外部內容 FTS 的 SELECT 不會顯示已刪主列，須另比對實際索引內容。
      for (const table of tableInfo.filter((row) => row.type === "virtual")) {
        const name = String(table.name);
        const hidden = database.prepare(`PRAGMA table_xinfo(${quote(name)})`).all()
          .filter((column) => column.hidden === 1).map((column) => column.name);
        if (!hidden.includes(name) || !hidden.includes("rank")) continue;
        try {
          database.prepare(`INSERT INTO ${quote(name)}(${quote(name)}, rank) VALUES('integrity-check', 1)`).run();
        } catch (error) {
          throw new Error(`Copilot search index ${name} is inconsistent with its content; deletion canceled.`, { cause: error });
        }
      }
      if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("Copilot metadata foreign key validation failed.");
    });
  } finally {
    database.close();
  }
}

function copilotRowKey(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_, value) => typeof value === "bigint" ? { sqliteInteger: String(value) } : value);
}

function copilotOwnedRows(database: DatabaseSync, tables: string[], sessionId: string): Map<string, Set<string>> {
  const rows = new Map(tables.map((table) => {
    const statement = database.prepare(`SELECT * FROM ${quote(table)}`);
    statement.setReadBigInts(true);
    return [table, statement.all()];
  }));
  const owners = new Map(tables.map((table) => [table,
    ["session_id", "sessionId", ...(table === "sessions" ? ["id"] : [])]
      .filter((column) => columnNames(database, table).has(column))]));
  const selected = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const [table, contents] of rows) {
    for (const row of contents) {
      const values = owners.get(table)!.map((column) => row[column]).filter((value) => value !== null);
      if (!values.includes(sessionId)) continue;
      if (values.some((value) => value !== sessionId)) throw new Error("Copilot session ownership columns conflict; deletion canceled.");
      selected.get(table)!.add(copilotRowKey(row));
    }
  }
  const relations = tables.flatMap((table) => {
    if (owners.get(table)!.length) return [];
    const groups = new Map<number, Record<string, unknown>[]>();
    for (const foreign of database.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()) {
      const group = groups.get(Number(foreign.id)) ?? [];
      group.push(foreign);
      groups.set(Number(foreign.id), group);
    }
    return [...groups.values()].map((group) => {
      group.sort((a, b) => Number(a.seq) - Number(b.seq));
      const parent = String(group[0]!.table);
      const primary = database.prepare(`PRAGMA table_info(${quote(parent)})`).all()
        .filter((column) => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
      return { table, parent, columns: group.map((foreign, index) => ({
        from: String(foreign.from), to: String(foreign.to ?? primary[index]?.name ?? "")
      })) };
    });
  });
  // 僅沿明確外鍵延伸；具直接 session owner 的列不能改歸其他對話。
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of relations) {
      const parents = (rows.get(relation.parent) ?? []).filter((row) => selected.get(relation.parent)?.has(copilotRowKey(row)));
      for (const row of rows.get(relation.table)!) {
        const key = copilotRowKey(row);
        if (selected.get(relation.table)!.has(key)) continue;
        if (parents.some((parent) => relation.columns.every(({ from, to }) =>
          row[from] !== null && row[from] !== undefined && row[from] === parent[to]))) {
          selected.get(relation.table)!.add(key);
          changed = true;
        }
      }
    }
  }
  const ownedTables = new Set(tables.filter((table) => owners.get(table)!.length > 0));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const { table, parent } of relations) {
      if (ownedTables.has(parent) && !ownedTables.has(table)) {
        ownedTables.add(table);
        expanded = true;
      }
    }
  }
  for (const relation of relations.filter(({ parent }) => ownedTables.has(parent))) {
    for (const row of rows.get(relation.table)!) {
      if (!selected.get(relation.table)!.has(copilotRowKey(row)) ||
          relation.columns.some(({ from }) => row[from] === null)) continue;
      if (!(rows.get(relation.parent) ?? []).some((parent) =>
        selected.get(relation.parent)?.has(copilotRowKey(parent)) &&
        relation.columns.every(({ from, to }) => row[from] === parent[to]))) {
        throw new Error("Copilot related data is shared by multiple sessions; deletion canceled.");
      }
    }
  }
  return selected;
}
