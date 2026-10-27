import { promises as fs } from "node:fs";
import path from "node:path";
import { getCanonicalPath, readDirectoryBounded, type PathWalkBudget } from "../fs/paths.js";
import type { ConversationDiscovery } from "./types.js";

export const CLAUDE_SELECTED_REFUSAL = "Claude Code selected deletion is not supported because transcripts, prompt history, and related state use shared internal formats. Use clean --target claude for full cleanup.";

// 僅列出已知檔名，不解析會隨版本變動的私人逐字稿格式。
export async function discoverClaudeConversations(home: string, budget: PathWalkBudget): Promise<ConversationDiscovery> {
  const root = path.join(home, ".claude");
  const projects = path.join(root, "projects");
  const canonicalHome = await getCanonicalPath(home);
  const conversations: ConversationDiscovery["conversations"] = [];
  const warnings: string[] = [];
  const physicalDirectory = async (directory: string): Promise<boolean> => {
    const canonical = await getCanonicalPath(directory);
    if (canonical !== path.join(canonicalHome, path.relative(home, directory))) {
      throw new Error("Claude Code storage is redirected; conversation discovery stopped.");
    }
    try {
      const info = await fs.lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Claude Code storage is not a physical directory; conversation discovery stopped.");
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  if (!await physicalDirectory(root) || !await physicalDirectory(projects)) return { conversations, warnings };
  for await (const project of readDirectoryBounded(projects, budget)) {
    if (project.isSymbolicLink()) throw new Error("Claude Code project storage contains a symbolic link; conversation discovery stopped.");
    if (!project.isDirectory()) continue;
    const directory = path.join(projects, project.name);
    if (!await physicalDirectory(directory)) continue;
    for await (const entry of readDirectoryBounded(directory, budget, 1)) {
      const id = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name)?.[1];
      if (!id) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error("Claude Code transcript is not a regular file; conversation discovery stopped.");
      }
      const file = path.join(directory, entry.name);
      if (await getCanonicalPath(file) !== path.join(canonicalHome, path.relative(home, file))) {
        throw new Error("Claude Code transcript path is redirected; conversation discovery stopped.");
      }
      const info = await fs.lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Claude Code transcript changed during discovery.");
      conversations.push({
        key: `claude:${project.name}:${id}`,
        providerId: "claude",
        providerName: "Claude Code",
        id,
        title: id,
        updatedAt: info.mtime.toISOString(),
        sizeBytes: info.size,
        sizeKnown: false,
        dataPaths: [file],
        guardPaths: [projects, path.join(root, "history.jsonl")],
        deleteStrategy: { kind: "local" },
        disabledReason: CLAUDE_SELECTED_REFUSAL,
        warnings: []
      });
    }
  }
  if (conversations.length) warnings.push(CLAUDE_SELECTED_REFUSAL);
  return { conversations, warnings };
}
