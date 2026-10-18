import { homedir } from "node:os";
import path from "node:path";
import { cleanEntries, validateEntries } from "../cleaners/clean.js";
import { getCanonicalPath } from "../fs/paths.js";
import type { ScanEntry } from "../cleaners/types.js";
import { codexMetadataFiles, type CodexMetadataPaths } from "./codex-paths.js";
import { prepareCodexThreadsMetadata, prepareLiveCodexThreadsMetadata } from "./codex-metadata.js";
import { codexDirectArtifact } from "./codex-artifacts.js";
import { attachMetadataFailure, withSqliteSidecars } from "./metadata-safety.js";
import {
  assertCodexConversationsPathsUnchanged, assertSafeHomePaths,
  snapshotConversationPaths, validateCodexConversationsPaths, validateCodexArtifactPaths
} from "./owned-paths.js";
import type { ConversationDeleteResult, ConversationRecord, DeleteConversationOptions } from "./types.js";

// 共用索引只預演、備份及更新一次；所有原始資料先完成檢查再開始搬移。
export async function deleteCodexConversations(
  conversations: ConversationRecord[],
  options: DeleteConversationOptions,
  result: ConversationDeleteResult,
  batch = true
): Promise<void> {
  const home = options.home ?? homedir();
  const entries: ScanEntry[] = [];
  const owners = new Map<string, Set<string>>();
  const deletedPaths: string[] = [];
  let plan: Awaited<ReturnType<typeof prepareCodexThreadsMetadata>> | undefined;
  try {
    const canonicalHome = await getCanonicalPath(home);
    const metadata = mergeMetadata(conversations);
    const metadataPaths = withSqliteSidecars(codexMetadataFiles(metadata));
    const assertIndexesClosed = async (): Promise<void> => {
      const indexes = await options.checkOpenPaths(metadataPaths);
      if (!indexes.supported) result.openFileCheckUnsupported = true;
      if (!indexes.supported) throw new Error("Cannot check whether index files are open.");
      if (indexes.openPaths.length) throw new Error(`Refusing to rewrite open Codex indexes; close the selected agents: ${indexes.openPaths.join(", ")}`);
    };
    const metadataSet = new Set(metadataPaths.map((file) => path.resolve(file)));
    const validated = await validateCodexConversationsPaths(conversations, home);
    for (const conversation of conversations) {
      const scanned = await snapshotConversationPaths(conversation, validated.get(conversation)!);
      owners.set(conversation.key, new Set(scanned.map((entry) => entry.path)));
      entries.push(...scanned);
    }
    await assertCodexConversationsPathsUnchanged(conversations, home);
    const ownedPaths = [...new Set([
      ...entries.filter((entry) => entry.exists).map((entry) => entry.path),
      ...conversations.flatMap((item) => item.guardPaths).filter((file) => !metadataSet.has(path.resolve(file)))
    ])];
    await assertSafeHomePaths([...ownedPaths, ...metadataPaths], home, "inspect");
    if (await getCanonicalPath(home) !== canonicalHome) {
      throw new Error("Codex home changed during ownership validation; refresh the conversation list.");
    }
    if (!options.dryRun) {
      const checked = await options.checkOpenPaths(ownedPaths);
      if (!checked.supported) result.openFileCheckUnsupported = true;
      if (!checked.supported) throw new Error("Cannot check whether files are open; close the relevant agents, then retry.");
      if (checked.openPaths.length) throw new Error(`Refusing to delete open files: ${checked.openPaths.join(", ")}`);
      await assertIndexesClosed();
    }
    plan = await (options.dryRun ? prepareLiveCodexThreadsMetadata : prepareCodexThreadsMetadata)(
      home, metadata, conversations.map((item) => item.id), options.trash,
      [...conversations.flatMap((item) => item.dataPaths), ...entries.filter((entry) => entry.exists).map((entry) => entry.path)]);
    if (options.dryRun) {
      await assertCodexConversationsPathsUnchanged(conversations, home);
      result.previewed.push(...conversations);
      return;
    }
    await plan.validate();
    await validateCodexConversationsPaths(conversations, home);
    await validateEntries(entries);
    await plan.prepareRecovery();
    await plan.validate();
    await assertCodexConversationsPathsUnchanged(conversations, home);
    const cleaned = await cleanEntries(entries, {
      batch, checkOpenPaths: options.checkOpenPaths,
      trash: async (files, expected) => {
        await assertIndexesClosed();
        // 最後的占用檢查可能讓 metadata 改變；每批搬移前重讀所有 ID，僅重驗該批直接產物。
        const artifacts = files.filter((candidate) => codexDirectArtifact(candidate, canonicalHome)).flatMap((candidate) =>
          conversations.filter((conversation) => owners.get(conversation.key)?.has(candidate))
            .map((conversation) => ({ candidate, id: conversation.id })));
        const checked = await validateCodexArtifactPaths(artifacts, canonicalHome, conversations.map((conversation) => conversation.id));
        const invalid = checked.find((item) => item.status !== "valid");
        if (invalid) throw new Error(invalid.status === "invalid" ? invalid.reason : "Codex artifact disappeared before movement.");
        await options.trash(files, expected);
      }
    });
    deletedPaths.push(...cleaned.deleted.map((entry) => entry.path));
    if (cleaned.openFileCheckUnsupported) result.openFileCheckUnsupported = true;
    if (cleaned.failures.length || cleaned.scanErrors.length) {
      throw attachMetadataFailure(new Error([...cleaned.failures.map((failure) => failure.error.message),
        ...cleaned.scanErrors.map((entry) => entry.error?.message ?? `Cannot scan ${entry.path}`)].join("; ")),
      batch ? {} : { metadataChanged: false });
    }
    await plan.validate();
    await assertIndexesClosed();
    await assertCodexConversationsPathsUnchanged(conversations, home,
      new Map(conversations.map((item) => [item.id, []])));
    await plan.execute();
    result.deleted.push(...conversations);
  } catch (error) {
    const failure = attachMetadataFailure(error, { recoveryPath: plan?.recoveryPath });
    for (const conversation of conversations) {
      const moved = deletedPaths.filter((file) => owners.get(conversation.key)?.has(file));
      const details = attachMetadataFailure(batch ? new Error(failure.message, { cause: failure }) : failure, {
        deletedPaths: moved, metadataChanged: failure.metadataChanged, recoveryPath: failure.recoveryPath
      });
      result.failures.push({ conversation, error: details, deletedPaths: batch ? moved : details.deletedPaths,
        metadataChanged: details.metadataChanged, recoveryPath: details.recoveryPath });
    }
  }
}

function mergeMetadata(conversations: ConversationRecord[]): CodexMetadataPaths {
  const merged: Partial<CodexMetadataPaths> = {};
  for (const conversation of conversations) {
    const strategy = conversation.deleteStrategy;
    if (conversation.providerId !== "codex" || strategy.kind !== "local" || strategy.metadata?.kind !== "codex") {
      throw new Error("Conversation metadata does not match the Codex target.");
    }
    const { kind: _kind, globalStateFiles, ...files } = strategy.metadata;
    for (const key of Object.keys(files) as Array<Exclude<keyof CodexMetadataPaths, "globalStateFiles">>) {
      const file = files[key];
      if (file === undefined) continue;
      if (merged[key] !== undefined && path.resolve(merged[key]) !== path.resolve(file)) {
        throw new Error("Selected Codex conversations have inconsistent shared index paths; refresh the conversation list.");
      }
      merged[key] = file;
    }
    if (globalStateFiles) merged.globalStateFiles = [...new Set([...(merged.globalStateFiles ?? []), ...globalStateFiles])];
  }
  if (!merged.stateDatabase || !merged.sessionIndex) throw new Error("Codex metadata is missing required index paths.");
  return { ...merged, stateDatabase: merged.stateDatabase, sessionIndex: merged.sessionIndex };
}
