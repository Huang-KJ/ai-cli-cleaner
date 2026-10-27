export type ProviderId = "codex" | "copilot" | "antigravity" | "opencode" | "grok" | "claude";

export interface CleanerManifest {
  id: ProviderId;
  name: string;
  deletePatterns: string[];
  // 明確選擇包含記憶時，才合併這些清理路徑。
  memoryDeletePatterns?: string[];
  // 保留每個專案的指定子目錄，僅清理其餘直接子項。
  protectedChildRoots?: { root: string; childNames: string[] }[];
  datedDirectoryRoots?: string[];
  preservedPaths: string[];
}

export interface ScanEntry {
  providerId: ProviderId;
  providerName: string;
  pattern: string;
  path: string;
  exists: boolean;
  sizeBytes: number;
  identity?: ScanPathIdentity;
  preservationGuards?: PreservationGuard[];
  sqliteGroup?: {
    basePath: string;
    members: string[];
    complete: boolean;
  };
  error?: Error;
}

export interface PreservationGuard {
  path: string;
  canonicalPath: string;
  identity?: { device: number; inode: number; kind: "directory" | "file" | "symlink" | "other" };
}

export interface ScanPathIdentity {
  device: number;
  inode: number;
  modifiedMs: number;
  sizeBytes: number;
  kind: "directory" | "file" | "symlink" | "other";
  canonicalPath?: string;
  treeFingerprint?: string;
}

export interface CleanFailure {
  entry: ScanEntry;
  error: Error;
}

export interface CleanResult {
  deleted: ScanEntry[];
  scanErrors: ScanEntry[];
  openFileCheckUnsupported: boolean;
  failures: CleanFailure[];
}
