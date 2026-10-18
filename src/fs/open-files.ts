import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { isMissingPath } from "./paths.js";
import { systemTools, toolEnvironment, trustedToolPath } from "./trusted-tools.js";

const execFileAsync = promisify(execFile);

export interface OpenFileCheck {
  supported: boolean;
  openPaths: string[];
}

export interface LsofResult {
  supported: boolean;
  stdout: string;
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
      const result = await runLsof(["-nP", "-Fn", "--", ...files.slice(offset, offset + 64)]);
      if (!result.supported) {
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
    if (!result.supported) {
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
    if (stderr.trim().length > 0) {
      return { supported: false, stdout: "" };
    }

    return { supported: true, stdout };
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
  if (stderr.trim().length > 0) {
    return { supported: false, stdout: "" };
  }
  const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
  return { supported: true, stdout };
}
