import { execFile } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { toolEnvironment } from "./trusted-tools.js";
import { claimPaths, type ClaimIdentity } from "./claims.js";
import { currentOperationHome } from "../recovery/operations.js";
import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { containsPath } from "./paths.js";

const execFileAsync = promisify(execFile);
const { verifyNativeArtifact } = createRequire(import.meta.url)("../../lib/native-helper.cjs") as {
  verifyNativeArtifact(root: string): string;
};
export type TrashRunner = (binary: string, paths: string[]) => Promise<void>;

// 執行前核對固定原生產物，不提供 JavaScript 垃圾桶退路。
export function systemTrashBinary(): string {
  return verifyNativeArtifact(fileURLToPath(new URL("../../", import.meta.url)));
}

export async function moveToSystemTrash(
  paths: string[],
  expectedOrOptions: Map<string, ClaimIdentity> | { platform?: string; run?: TrashRunner } = {},
  runnerOptions: { platform?: string; run?: TrashRunner } = {}
): Promise<void> {
  const expected = expectedOrOptions instanceof Map ? expectedOrOptions : undefined;
  const options = expectedOrOptions instanceof Map ? runnerOptions : expectedOrOptions;
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("System Trash is only supported on macOS.");
  }
  const unique = [...new Set(paths)];
  if (unique.some((file) => !path.isAbsolute(file) || path.resolve(file) === path.parse(file).root)) {
    throw new Error("Trash operations require absolute paths other than the filesystem root.");
  }
  if (unique.length === 0) return;
  const run = options.run ?? runTrash;
  const binary = systemTrashBinary();
  if (!expected) throw new Error("System Trash requires the approved filesystem identity for every source.");
  let staged = unique;
  let claim: Awaited<ReturnType<typeof claimPaths>> | undefined;
  if (expected) {
    if (unique.some((file) => !expected.has(file))) throw new Error("System Trash requires the approved filesystem identity for every source.");
    const temporary = realpathSync(tmpdir());
    const operationHome = currentOperationHome();
    const home = operationHome && unique.every((file) => containsPath(operationHome, file)) ? operationHome
      : unique.every((file) => containsPath(temporary, file)) ? temporary
      : unique.every((file) => containsPath(tmpdir(), file)) ? tmpdir() : homedir();
    claim = await claimPaths(home, unique.map((file) => ({ path: file, identity: expected.get(file)! })));
    staged = unique.map((file) => claim!.files.get(file)!);
  }
  try {
    await runTrashBatches(binary, staged, run);
    await claim?.markTrashed();
  } catch (error) {
    throw Object.assign(new Error(`System Trash operation failed and may have moved some items. Check the cleanup results; no fallback .Trash directory was used.${claim ? ` Recovery directory: ${claim.directory}` : ""}`, { cause: error }), { unconfirmedTrash: true, recoveryPath: claim?.directory });
  }
}

// 純參數分批，來源核准與私有claim由上層完成。
export async function runTrashBatches(binary: string, paths: string[], run: TrashRunner): Promise<void> {
  for (let offset = 0; offset < paths.length; offset += 64) {
    try {
      await run(binary, paths.slice(offset, offset + 64));
    } catch (error) {
      throw new Error("System Trash operation failed and may have moved some items. Check the cleanup results; no fallback .Trash directory was used.", { cause: error });
    }
  }
}

async function runTrash(binary: string, paths: string[]): Promise<void> {
  await execFileAsync(binary, paths, {
    env: toolEnvironment(),
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024
  });
}
