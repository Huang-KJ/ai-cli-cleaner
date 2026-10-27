import { homedir } from "node:os";
import { getManifests } from "./manifests.js";
import { cleanEntries, validateEntries, type OpenFileCheckFn, type TrashFn } from "./clean.js";
import type { ProviderId, ScanEntry } from "./types.js";
import { scanManifests } from "../fs/scan.js";
import { codexConversationMetadataPaths, prepareCodexConversationMetadata } from "../conversations/codex-metadata.js";
import { assertKnownCodexDatabases } from "../conversations/codex-paths.js";
import { attachMetadataFailure } from "../conversations/metadata-safety.js";
import { prepareOpenCodeBulkMetadata } from "../conversations/opencode-bulk.js";

export interface CleanPlan {
  entries: ScanEntry[];
  operations: string[];
  execute: () => Promise<{
    deleted: ScanEntry[];
    failures: { providerId: ProviderId; message: string; recoveryPath?: string }[];
  }>;
}

export async function prepareClean(
  targets: ProviderId[],
  options: { home?: string; trash: TrashFn; checkOpenPaths: OpenFileCheckFn; includeMemories?: boolean }
): Promise<CleanPlan> {
  const home = options.home ?? homedir();
  const memoryOptions = { includeMemories: options.includeMemories ?? false };
  const manifests = getManifests(targets, memoryOptions);
  if (!targets.length || manifests.length !== new Set(targets).size) throw new Error("Select at least one valid agent.");
  const openCode = targets.includes("opencode") ? await prepareOpenCodeBulkMetadata(home, options.trash) : undefined;
  const metadata = targets.includes("codex")
    ? await prepareCodexConversationMetadata(home, options.trash, memoryOptions)
    : undefined;
  if (metadata) await assertKnownCodexDatabases(home);
  // 預檢只操作私有副本；搬移清單仍依來源當下的資料庫及 sidecar 建立。
  const scanned = await scanManifests(manifests, { home });
  const errors = scanned.filter((entry) => entry.error);
  if (errors.length) throw new Error(errors.map((entry) => `${entry.path}: ${entry.error!.message}`).join("\n"));
  const retainedPaths = new Set(openCode?.retainDatabase ? openCode.paths : []);
  const entries = scanned.filter((entry) => entry.exists && !retainedPaths.has(entry.path));
  const guardPaths = [...new Set([
    ...entries.map((entry) => entry.path),
    ...(metadata ? codexConversationMetadataPaths(home, memoryOptions) : []),
    ...(openCode?.paths ?? [])
  ])];
  const checkClosed = async (): Promise<void> => {
    if (!entries.length && !metadata?.operations.length && !openCode?.operations.length) return;
    const check = await options.checkOpenPaths(guardPaths);
    if (!check.supported) throw new Error("Cannot check open-file status; ensure lsof is available and close the relevant agents, then retry.");
    if (check.openPaths.length) throw new Error(
      `Quit the relevant agents completely, or add --force-stop to stop the selected agents before cleanup. Open files: ${check.openPaths.join(", ")}`
    );
  };
  await checkClosed();
  let executed = false;

  return {
    entries,
    operations: [...(metadata?.operations ?? []), ...(openCode?.operations ?? [])],
    execute: async () => {
      if (executed) throw new Error("This deletion plan has already been executed; refresh the list.");
      executed = true;
      await openCode?.validate();
      await checkClosed();
      if (metadata) await assertKnownCodexDatabases(home);
      await metadata?.validate();
      await openCode?.validate();
      // 重新確認整份清單，包含預覽時尚不存在的路徑與 wildcard 新增項目。
      const current = await scanManifests(manifests, { home });
      const currentErrors = current.filter((entry) => entry.error);
      if (currentErrors.length) {
        throw new Error(currentErrors.map((entry) => `${entry.path}: ${entry.error!.message}`).join("\n"));
      }
      const plannedPaths = new Set(entries.map((entry) => `${entry.providerId}\0${entry.path}`));
      const currentPaths = new Set(current.filter((entry) => entry.exists && !retainedPaths.has(entry.path))
        .map((entry) => `${entry.providerId}\0${entry.path}`));
      if (plannedPaths.size !== currentPaths.size ||
        [...plannedPaths].some((entry) => !currentPaths.has(entry))) {
        throw new Error("Cleanup data was added or removed after preview; refresh the list.");
      }
      await validateEntries(entries);
      await metadata?.prepareRecovery();
      if (openCode?.retainDatabase) await openCode.prepareRecovery();
      await openCode?.validate();
      const deleted: ScanEntry[] = [];
      const failures: Awaited<ReturnType<CleanPlan["execute"]>>["failures"] = [];

      for (const manifest of manifests) {
        const selected = entries.filter((entry) => entry.providerId === manifest.id);
        try {
          if (manifest.id === "opencode") await openCode?.validate();
          const result = await cleanEntries(selected, {
            trash: options.trash,
            checkOpenPaths: options.checkOpenPaths
          });
          deleted.push(...result.deleted);
          if (result.failures.length || result.scanErrors.length) {
            throw new Error([
              ...result.failures.map((failure) => failure.error.message),
              ...result.scanErrors.map((entry) => entry.error?.message)
            ].filter(Boolean).join("\n"));
          }
          if (manifest.id === "codex" && metadata) {
            const current = await options.checkOpenPaths(metadata.paths);
            if (!current.supported || current.openPaths.length) throw new Error("Codex indexes are open or their open-file status cannot be checked; updates stopped.");
            await metadata.execute();
            await assertKnownCodexDatabases(home);
          }
          if (manifest.id === "opencode" && openCode?.retainDatabase) {
            const current = await options.checkOpenPaths(openCode.paths);
            if (!current.supported || current.openPaths.length) throw new Error("OpenCode indexes are open or their open-file status cannot be checked; updates stopped.");
            await openCode.execute();
            await openCode.assertComplete();
          }
          // 成功必須以實際路徑消失為準，避免 helper 無動作卻回報完成。
          const remaining = await scanManifests([manifest], { home });
          const unresolved = remaining.filter((entry) => entry.error || (entry.exists && !retainedPaths.has(entry.path)));
          if (unresolved.length) throw new Error(`Conversation data remains: ${unresolved.map((entry) => entry.path).join(", ")}`);
        } catch (error) {
          const failure = attachMetadataFailure(error, {
            recoveryPath: manifest.id === "codex" ? metadata?.recoveryPath
              : manifest.id === "opencode" ? openCode?.recoveryPath : undefined
          });
          failures.push({ providerId: manifest.id, message: failure.message, recoveryPath: failure.recoveryPath });
        }
      }
      return { deleted, failures };
    }
  };
}
