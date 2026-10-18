import type { ProviderId } from "../cleaners/types.js";
import type { OpenFileCheckFn, TrashFn } from "../cleaners/clean.js";
import type { CodexMetadataPaths } from "./codex-paths.js";

export type ConversationDeleteStrategy =
  | {
      kind: "local";
      metadata?:
        | {
            kind: "antigravity";
            summaryDatabase?: string;
            historyFile?: string;
            lastConversationsFile?: string;
          }
        | ({ kind: "codex" } & CodexMetadataPaths)
        | {
            kind: "copilot";
            sessionStoreDatabase?: string;
          };
    }
  | {
      kind: "indexed";
    };

export interface ConversationRecord {
  key: string;
  providerId: ProviderId;
  providerName: string;
  id: string;
  title: string;
  parentId?: string;
  updatedAt?: string;
  workspace?: string;
  sizeBytes: number;
  sizeKnown?: boolean;
  dataPaths: string[];
  guardPaths: string[];
  deleteStrategy: ConversationDeleteStrategy;
  disabledReason?: string;
  warnings: string[];
}

export interface ConversationDiscovery {
  conversations: ConversationRecord[];
  warnings: string[];
}

export interface DeletionFailureDetails {
  deletedPaths?: string[];
  metadataChanged?: boolean;
  recoveryPath?: string;
}

export type DeletionError = Error & DeletionFailureDetails;

export interface ConversationDeleteFailure extends DeletionFailureDetails {
  conversation: ConversationRecord;
  error: Error;
}

export interface ConversationDeleteResult {
  deleted: ConversationRecord[];
  previewed: ConversationRecord[];
  failures: ConversationDeleteFailure[];
  openFileCheckUnsupported?: boolean;
}

export interface DeleteConversationOptions {
  dryRun?: boolean;
  home?: string;
  checkOpenPaths: OpenFileCheckFn;
  trash: TrashFn;
}

// ID 會用於路徑及資料庫查詢；拒絕路徑穿越、選項與控制字元。
export function assertConversationId(id: string): void {
  if (!id || id === "." || id === ".." || /^-/.test(id) || /[/\\\x00-\x20\x7f]/.test(id)) {
    throw new Error(`Invalid conversation ID: ${JSON.stringify(id)}`);
  }
}
