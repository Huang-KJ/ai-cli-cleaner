export type ProviderId = "codex" | "copilot" | "antigravity" | "opencode" | "grok";

export interface CleanerManifest {
  id: ProviderId;
  name: string;
  deletePatterns: string[];
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
  sqliteGroup?: {
    basePath: string;
    members: string[];
    complete: boolean;
  };
  error?: Error;
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
