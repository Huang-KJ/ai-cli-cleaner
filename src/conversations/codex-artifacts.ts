import { readJsonlLines } from "./metadata-jsonl.js";
import { createPathWalkBudget, readDirectoryBounded } from "../fs/paths.js";
import path from "node:path";
import { readCodexResidualIds } from "./codex-inventory.js";
import { assertKnownCodexDatabases, getCodexMetadataPaths } from "./codex-paths.js";
import { isRecord } from "./metadata-values.js";
import { validateCodexRolloutPath, validateExactStoragePath } from "./owned-paths.js";
import { assertConversationId } from "./types.js";

export function isCodexRolloutName(name: string): boolean {
  return name.toLowerCase().endsWith(".jsonl");
}

// 每個點號都是可能的 ID 邊界；完整名稱也可能是 ID，不能優先猜測擁有者。
export function codexArtifactOwners(name: string, ids: ReadonlySet<string>): string[] {
  const owners: string[] = [];
  for (let end = name.indexOf("."); end >= 0; end = name.indexOf(".", end + 1)) {
    const id = name.slice(0, end);
    if (ids.has(id)) owners.push(id);
  }
  if (ids.has(name)) owners.push(name);
  return owners;
}

export function codexDirectArtifact(candidate: string, home: string): { root: string; name: string } | undefined {
  for (const root of ["shell_snapshots", "visualizations"]) {
    const name = path.relative(path.resolve(home, ".codex", root), path.resolve(candidate));
    if (name && name !== "." && name !== ".." && !name.includes(path.sep) && !path.isAbsolute(name)) {
      return { root, name };
    }
  }
  return undefined;
}

export function codexJsonlId(value: unknown, kind: "index" | "history"): string {
  if (!isRecord(value)) throw new Error("Codex conversation index row must be an object.");
  const fields = kind === "index" ? ["id", "thread_id"] : ["session_id", "thread_id"];
  const ids = fields.map((key) => value[key]).filter((id) => id !== undefined);
  if (!ids.length) throw new Error("Codex conversation index row is missing a complete conversation ID.");
  for (const id of ids) {
    if (typeof id !== "string") throw new Error("Codex conversation ID must be a string.");
    assertConversationId(id);
  }
  if (new Set(ids).size !== 1) throw new Error("Codex conversation ID fields do not match.");
  return ids[0] as string;
}

// 呼叫端只有在同階段已完整掃描 rollout 時，才能提供該次掃描的 ID 集合。
export async function readCodexArtifactIds(
  home: string,
  selectedIds: readonly string[],
  rolloutIds?: ReadonlySet<string>
): Promise<Set<string>> {
  const root = path.join(home, ".codex");
  selectedIds.forEach(assertConversationId);
  await assertKnownCodexDatabases(home);
  const paths = getCodexMetadataPaths(home);
  const residual = await readCodexResidualIds(home, paths);
  if (residual.disabledReason) throw new Error(residual.warnings.join("\n"));
  const ids = new Set([...selectedIds, ...residual.ids]);
  for (const [file, kind] of [[paths.sessionIndex, "index"], [paths.historyFile, "history"]] as const) {
    if (!file) continue;
    const checked = await validateExactStoragePath(file, root, [path.basename(file)], "file");
    if (checked.status === "missing") continue;
    if (checked.status === "invalid") throw new Error(checked.reason);
    for await (const { line } of readJsonlLines(checked.path)) {
      if (line.trim()) ids.add(codexJsonlId(JSON.parse(line), kind));
    }
  }
  if (rolloutIds) {
    for (const id of rolloutIds) ids.add(id);
    return ids;
  }
  const budget = createPathWalkBudget();
  const walk = async (parts: string[]): Promise<void> => {
    const checked = await validateExactStoragePath(path.join(root, ...parts), root, parts, "directory");
    if (checked.status === "missing") return;
    if (checked.status === "invalid") throw new Error(checked.reason);
    for await (const entry of readDirectoryBounded(checked.path, budget, parts.length - 1)) {
      const file = path.join(root, ...parts, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Cannot determine complete Codex artifact ownership through a symbolic link.");
      if (entry.isDirectory()) await walk([...parts, entry.name]);
      else if (isCodexRolloutName(entry.name)) {
        const rollout = await validateCodexRolloutPath(file, home);
        if (rollout.status !== "valid" || !rollout.header.id) {
          throw new Error(rollout.status === "invalid" ? rollout.reason : "Codex rollout disappeared while validating artifact ownership.");
        }
        ids.add(rollout.header.id);
      }
    }
  };
  await walk(["sessions"]);
  await walk(["archived_sessions"]);
  return ids;
}
