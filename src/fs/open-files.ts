import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { containsPath, isMissingPath } from "./paths.js";
import { systemTools, toolEnvironment, trustedToolPath } from "./trusted-tools.js";

const execFileAsync = promisify(execFile);

export interface OpenFileCheck {
  supported: boolean;
  openPaths: string[];
}

export interface LsofResult {
  supported: boolean;
  stdout: string;
  // lsof 無法 stat 的掛載點；只有與查詢路徑互不包含時，結果才算完整。
  unreadableMounts?: string[];
}

export type LsofRunner = (args: string[]) => Promise<LsofResult>;

export async function findOpenPaths(
  paths: string[],
  platform = process.platform,
  runLsof: LsofRunner = defaultLsofRunner
): Promise<OpenFileCheck> {
  if (platform !== "darwin") {
    return { supported: false, openPaths: [] };
  }

  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0) {
    return { supported: true, openPaths: [] };
  }

  const files: string[] = [];
  const directories: string[] = [];
  for (const targetPath of uniquePaths) {
    try {
      const stat = await fs.lstat(targetPath);
      if (stat.isDirectory()) {
        directories.push(targetPath);
      } else {
        files.push(targetPath);
      }
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }
  }

  const openPaths: string[] = [];
  if (files.length > 0) {
    for (let offset = 0; offset < files.length; offset += 64) {
      // 不解析主機與連接埠名稱，並限制批次參數量。
      const batch = files.slice(offset, offset + 64);
      const result = await runLsof(["-nP", "-Fn", "--", ...batch]);
      if (!result.supported || await overlapsUnreadableMount(result.unreadableMounts, batch)) {
        return { supported: false, openPaths: [] };
      }
      openPaths.push(...parseLsofOutput(result.stdout));
    }
    // lsof 可能回傳 canonical path；不可用字面比對把仍開啟的檔案濾掉。
    const aliases = new Map<string, string>();
    for (const file of files) {
      try {
        aliases.set(await fs.realpath(file), file);
      } catch (error) {
        if (!isMissingPath(error)) {
          throw error;
        }
      }
    }
    openPaths.splice(0, openPaths.length, ...openPaths.map((file) => aliases.get(file) ?? file));
  }

  for (const directory of directories) {
    const result = await runLsof(["-nP", "-Fn", "+D", directory]);
    if (!result.supported || await overlapsUnreadableMount(result.unreadableMounts, [directory])) {
      return { supported: false, openPaths: [] };
    }
    openPaths.push(...parseLsofOutput(result.stdout));
  }

  return { supported: true, openPaths: [...new Set(openPaths)] };
}

export function parseLsofOutput(output: string): string[] {
  const openPaths = output
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));

  return [...new Set(openPaths)];
}

async function defaultLsofRunner(args: string[]): Promise<LsofResult> {
  try {
    const binary = await trustedToolPath(systemTools.lsof, "executable", true);
    const { stdout, stderr } = await execFileAsync(binary, args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15_000,
      env: toolEnvironment()
    });
    return lsofResult(stdout, stderr);
  } catch (error) {
    const failureResult = getLsofFailureResult(error);
    if (failureResult) {
      return failureResult;
    }

    throw error;
  }
}

export function getLsofFailureResult(error: unknown): LsofResult | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const failure = error as Readonly<Record<string, unknown>>;
  if (failure.code === "ENOENT") {
    return { supported: false, stdout: "" };
  }
  if (failure.code !== 1) return undefined;

  const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
  const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
  return lsofResult(stdout, stderr);
}

function lsofResult(stdout: string, stderr: string): LsofResult {
  const unreadableMounts = parseUnreadableMountWarnings(stderr);
  if (!unreadableMounts) return { supported: false, stdout: "" };
  return unreadableMounts.length ? { supported: true, stdout, unreadableMounts } : { supported: true, stdout };
}

// 其他帳號掛載的磁碟映像等無法 stat 的檔案系統，會讓 lsof 每次都輸出這段警告；
// 只接受完整的警告區塊，其他 stderr 一律視為結果可能不完整。
export function parseUnreadableMountWarnings(stderr: string): string[] | undefined {
  const mounts: string[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.trim()) continue;
    const mount = /^lsof: WARNING: can't stat\(\) [\w.-]+ file system (\/.*)$/.exec(line)?.[1];
    if (mount !== undefined) {
      mounts.push(mount);
      continue;
    }
    if (!mounts.length || !/^\s+(?:Output information may be incomplete\.|assuming "dev=[0-9a-fA-F]+" from mount table)$/.test(line)) {
      return undefined;
    }
  }
  return mounts;
}

// 掛載點與查詢路徑任一方向包含時，該路徑的開檔資訊可能不完整。
async function overlapsUnreadableMount(mounts: string[] | undefined, targets: string[]): Promise<boolean> {
  if (!mounts?.length) return false;
  for (const target of targets) {
    let canonical: string;
    try {
      canonical = await fs.realpath(target);
    } catch {
      return true;
    }
    for (const candidate of new Set([path.resolve(target), canonical])) {
      if (mounts.some((mount) => containsPath(mount, candidate) || containsPath(candidate, mount))) return true;
    }
  }
  return false;
}
