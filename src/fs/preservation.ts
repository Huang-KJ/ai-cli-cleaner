import { promises as fs } from "node:fs";
import type { PreservationGuard } from "../cleaners/types.js";
import { getCanonicalPath } from "./paths.js";

export async function snapshotPreservedPath(file: string): Promise<PreservationGuard> {
  const canonicalPath = await getCanonicalPath(file);
  try {
    const info = await fs.lstat(file);
    const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other";
    return { path: file, canonicalPath, identity: { device: info.dev, inode: info.ino, kind } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, canonicalPath };
    throw error;
  }
}

export async function validatePreservationGuards(guards: PreservationGuard[]): Promise<void> {
  for (const guard of new Map(guards.map((entry) => [entry.path, entry])).values()) {
    const current = await snapshotPreservedPath(guard.path);
    // 我們刪除旁邊的子項會改變容器 mtime，僅比對路徑及實體身分。
    if (current.canonicalPath !== guard.canonicalPath ||
        current.identity?.device !== guard.identity?.device || current.identity?.inode !== guard.identity?.inode ||
        current.identity?.kind !== guard.identity?.kind) {
      throw new Error(`Preserved memory path or its container changed after scanning; refresh the list: ${guard.path}`);
    }
  }
}
