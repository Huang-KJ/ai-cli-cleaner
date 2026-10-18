import { haltOperation, recordMetadata } from "../recovery/operations.js";
import type { TrashFn } from "../cleaners/clean.js";
import { pathExists } from "../fs/paths.js";
import {
  assertMetadataInventoryUnchanged, attachMetadataFailure, createRecoveryBackup,
  removeRecoveryBackup, writeStagedMetadata, type MetadataInventory
} from "./metadata-safety.js";

export interface MetadataPlanResult {
  metadataChanged: boolean;
}

export interface MetadataPlan {
  readonly recoveryPath?: string;
  validate(): Promise<void>;
  prepareRecovery(): Promise<void>;
  execute(trash: TrashFn): Promise<MetadataPlanResult>;
}

export interface ProviderDeletionPlan extends MetadataPlan {
  guardPaths: string[];
  dataPaths: string[];
}

interface MetadataPlanOptions {
  home: string;
  inventory: MetadataInventory;
  changedPaths: string[];
  providerId: string;
  conversationIds: string[];
  previewOnly?: boolean;
  beforeStage?: () => Promise<void> | void;
  beforeWrite?: () => Promise<void> | void;
  write(markChanged: () => void, copies: Map<string, string>, inventory: MetadataInventory): Promise<void>;
  afterWrite?: () => Promise<void> | void;
}

export function createMetadataPlan(options: MetadataPlanOptions): MetadataPlan {
  let recovery: Awaited<ReturnType<typeof createRecoveryBackup>>;
  const validate = () => assertMetadataInventoryUnchanged(options.inventory);
  const prepareRecovery = async (): Promise<void> => {
    try {
      if (options.previewOnly) throw new Error("A preview plan cannot create deletion backups.");
      await validate();
      if (options.changedPaths.length && !recovery) {
        await recordMetadata({ providerId: options.providerId, paths: options.changedPaths, stage: "planned" });
        await options.beforeStage?.();
        recovery = await createRecoveryBackup(options.home, options.inventory, options.changedPaths,
          options.providerId, options.conversationIds);
      }
    } catch (error) {
      haltOperation(error);
      throw error;
    }
  };
  const finish = async (trash: TrashFn): Promise<void> => {
    try {
      await removeRecoveryBackup(recovery, trash);
      recovery = undefined;
    } catch (error) {
      if (recovery) {
        let exists = true;
        try {
          exists = await pathExists(recovery.directory);
        } catch {
          // 無法查明時保留備份路徑與原始錯誤，交由執行者確認。
        }
        if (!exists) {
          recovery = undefined;
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${message} The backup no longer exists at its original path; look in system Trash. The move could not be confirmed.`, { cause: error });
        }
      }
      throw error;
    }
  };
  return {
    get recoveryPath() { return recovery?.directory; },
    validate,
    prepareRecovery,
    execute: async (trash) => {
      let metadataChanged = false;
      let writingStarted = false;
      try {
        if (options.previewOnly) throw new Error("A preview plan cannot execute deletion.");
        await validate();
        if (options.inventory.liveSqlite) throw new Error("Metadata updates require stopped agents; live cleanup is no longer supported.");
        await options.beforeWrite?.();
        if (!options.changedPaths.length) return { metadataChanged };
        await prepareRecovery();
        await validate();
        await recordMetadata({ providerId: options.providerId, paths: options.changedPaths, stage: "writing", recoveryPath: recovery?.directory });
        writingStarted = true;
        if (!recovery) throw new Error("Metadata recovery backup is missing before staged publication.");
        const verifyPublished = await writeStagedMetadata(options.home, options.inventory, recovery,
          (copies, inventory) => options.write(() => undefined, copies, inventory),
          () => { metadataChanged = true; });
        await options.afterWrite?.();
        await verifyPublished();
        await recordMetadata({ providerId: options.providerId, paths: options.changedPaths, stage: "written", recoveryPath: recovery?.directory });
        await finish(trash);
        await verifyPublished();
        await recordMetadata({ providerId: options.providerId, paths: options.changedPaths, stage: "released" });
        return { metadataChanged };
      } catch (error) {
        const failure = attachMetadataFailure(error, { metadataChanged, recoveryPath: recovery?.directory });
        haltOperation(failure);
        if (writingStarted) {
          try {
            await recordMetadata({ providerId: options.providerId, paths: options.changedPaths, stage: "possibly-partial", recoveryPath: recovery?.directory });
          } catch (journalError) {
            // 日誌錯誤不能掩蓋內層已完成 rename 的事實。
            throw attachMetadataFailure(journalError, { metadataChanged: failure.metadataChanged,
              recoveryPath: failure.recoveryPath, deletedPaths: failure.deletedPaths });
          }
        }
        throw failure;
      }
    }
  };
}
