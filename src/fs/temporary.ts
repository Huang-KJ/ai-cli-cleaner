import { promises as fs } from "node:fs";
import path from "node:path";
import { moveToSystemTrash } from "./trash.js";
import { trustedToolPath } from "./trusted-tools.js";
import { snapshotClaimIdentity } from "./claims.js";

export async function createTemporaryDirectory(prefix: string): Promise<string> {
  if (!path.isAbsolute(prefix)) throw new Error("Temporary staging requires an absolute path.");
  // 來源副本稍後會重新開啟；父路徑必須阻止其他帳號替換整個 stage。
  const parent = await trustedToolPath(path.dirname(prefix), "directory");
  const directory = await fs.mkdtemp(path.join(parent, path.basename(prefix)));
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700) {
    throw new Error("Invalid private temporary staging directory.");
  }
  return trustedToolPath(directory, "directory");
}

// 預檢副本與未完成改寫可能含原始內容，僅使用系統垃圾桶清理。
export async function discardTemporary(paths: string[]): Promise<void> {
  const existing: string[] = [];
  for (const file of paths) {
    try {
      await fs.lstat(file);
      existing.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (existing.length) await moveToSystemTrash(existing, new Map(existing.map((file) => [file, snapshotClaimIdentity(file)])));
}
