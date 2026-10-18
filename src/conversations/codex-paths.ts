import path from "node:path";
import { promises as fs } from "node:fs";
import { createPathWalkBudget, readDirectoryBounded } from "../fs/paths.js";

export interface CodexMetadataPaths {
  stateDatabase: string;
  sessionIndex: string;
  historyFile?: string;
  globalStateFiles?: string[];
  threadHistoryDatabase?: string;
  logsDatabase?: string;
  goalsDatabase?: string;
  memoriesDatabase?: string;
  queueDatabase?: string;
  appDatabase?: string;
  threadSummariesDatabase?: string;
  historySnapshotsDatabase?: string;
}

export function getCodexMetadataPaths(home: string): CodexMetadataPaths {
  const root = path.join(home, ".codex");
  return {
    stateDatabase: path.join(root, "state_5.sqlite"),
    sessionIndex: path.join(root, "session_index.jsonl"),
    historyFile: path.join(root, "history.jsonl"),
    globalStateFiles: [
      path.join(root, ".codex-global-state.json"),
      path.join(root, ".codex-global-state.json.bak")
    ],
    threadHistoryDatabase: path.join(root, "thread_history_1.sqlite"),
    logsDatabase: path.join(root, "logs_2.sqlite"),
    goalsDatabase: path.join(root, "goals_1.sqlite"),
    memoriesDatabase: path.join(root, "memories_1.sqlite"),
    queueDatabase: path.join(root, "queue_1.sqlite"),
    appDatabase: path.join(root, "sqlite", "codex-dev.db"),
    threadSummariesDatabase: path.join(root, "sqlite", "codex-thread-summaries-dev.db"),
    historySnapshotsDatabase: path.join(root, "sqlite", "codex-history-snapshots-dev.db")
  };
}

export function codexMetadataFiles(paths: Partial<CodexMetadataPaths>): string[] {
  return [
    paths.stateDatabase,
    paths.sessionIndex,
    paths.historyFile,
    ...(paths.globalStateFiles ?? []),
    paths.threadHistoryDatabase,
    paths.logsDatabase,
    paths.goalsDatabase,
    paths.memoriesDatabase,
    paths.queueDatabase,
    paths.appDatabase,
    paths.threadSummariesDatabase,
    paths.historySnapshotsDatabase
  ].filter((file): file is string => Boolean(file));
}

export async function assertKnownCodexDatabases(home: string): Promise<void> {
  const root = path.resolve(home, ".codex");
  const known = new Set(codexMetadataFiles(getCodexMetadataPaths(home)).map((file) => path.resolve(file)));
  const unknown: string[] = [];
  const walkBudget = createPathWalkBudget();
  // 僅檢查已定義的儲存根；新的 App 子目錄視為未知格式，不深入讀取。
  for (const directory of [root, path.join(root, "sqlite")]) {
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Codex database directories cannot be symbolic links.");
    if (!stat.isDirectory()) throw new Error("Codex database storage must be a directory.");
    for await (const entry of readDirectoryBounded(directory, walkBudget)) {
      const file = path.join(directory, entry.name);
      const base = file.replace(/-(?:wal|shm|journal)$/i, "");
      if (/\.(?:sqlite|db)(?:-(?:wal|shm|journal))?$/i.test(entry.name)) {
        if (!known.has(base) || !entry.isFile()) unknown.push(path.relative(root, file));
      } else if (directory !== root && !entry.isFile()) {
        unknown.push(path.relative(root, file));
      }
    }
  }
  if (unknown.length) throw new Error(`Unsupported Codex conversation databases detected; nothing deleted: ${unknown.join(", ")}`);
}
