import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory, readPrivateFile } from "../recovery/storage.js";
import { recordPathClaim } from "../recovery/operations.js";
import { containsPath } from "./paths.js";
import { toolEnvironment, trustedToolPath } from "./trusted-tools.js";

export interface ClaimIdentity {
  device: number;
  inode: number;
  kind?: "file" | "directory" | "symlink" | "other";
  mode?: number;
  nlink?: number;
  sizeBytes?: number;
  modifiedMs?: number;
}
export interface ClaimTarget { path: string; identity?: ClaimIdentity }
export interface PathClaim {
  directory: string;
  files: Map<string, string>;
  publish(replacements: Map<string, string>): Promise<void>;
  rollback(): Promise<void>;
  markTrashed(): Promise<void>;
}
interface Anchor { device: string; inode: string; kind: "directory"; private?: boolean; trusted?: boolean }
type Anchors = Record<string, Anchor>;
const { verifyClaimArtifact } = createRequire(import.meta.url)("../../lib/claim-helper.cjs") as {
  verifyClaimArtifact(root: string): string;
};

// 僅供已核准的新建私有物件；provider來源必須沿用原始計畫的身分。
export function snapshotClaimIdentity(file: string): ClaimIdentity {
  const info = lstatSync(file);
  if (!Number.isSafeInteger(info.dev) || !Number.isSafeInteger(info.ino)) throw new Error("Filesystem identity exceeds the supported exact integer range.");
  return { device: info.dev, inode: info.ino, mode: info.mode, nlink: info.nlink,
    kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "other",
    sizeBytes: info.size, modifiedMs: info.mtimeMs };
}

function encode(identity: ClaimIdentity): Record<string, string> {
  if (![identity.device, identity.inode].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Filesystem identity exceeds the supported exact integer range.");
  }
  return { device: String(identity.device), inode: String(identity.inode),
    ...(identity.kind ? { kind: identity.kind } : {}), ...(identity.mode === undefined ? {} : { mode: String(identity.mode) }) };
}

function capture(directory: string, anchors: Anchors, privateRoot: string, trusted = false): void {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = snapshotClaimIdentity(current);
    if (info.kind !== "directory") throw new Error("Claim parents must be physical directories without symbolic links.");
    const prior = anchors[current];
    if (prior && (prior.device !== String(info.device) || prior.inode !== String(info.inode))) throw new Error("Claim parent identity changed during preparation.");
    anchors[current] = { device: String(info.device), inode: String(info.inode), kind: "directory",
      ...(containsPath(privateRoot, current) ? { private: true } : {}), ...(trusted || prior?.trusted ? { trusted: true } : {}) };
  }
}

async function run(request: Record<string, unknown>, directory: string): Promise<void> {
  const binary = verifyClaimArtifact(fileURLToPath(new URL("../../", import.meta.url)));
  const input = JSON.stringify(request);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(binary, [], { env: toolEnvironment(), timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${stderr.trim() || "Native claim operation failed."} Recovery directory: ${directory}`, { cause: error }));
      else resolve();
    });
    child.stdin?.end(input);
  });
}

export async function claimPaths(
  home: string,
  targets: ClaimTarget[],
  options: { directory?: string } = {}
): Promise<PathClaim> {
  if (process.platform !== "darwin") throw new Error("Native path claims are only supported on macOS.");
  const canonical = realpathSync(home);
  const privateRoot = path.join(canonical, ".ai-cli-cleaner");
  const directory = options.directory
    ? path.join(canonical, path.relative(home, options.directory))
    : path.join(canonical, ".ai-cli-cleaner", "recovery", randomUUID());
  if (!containsPath(privateRoot, directory) || directory === privateRoot) throw new Error("Claim storage must be inside private cleaner recovery storage.");
  await privateDirectory(canonical, directory, true);
  await trustedToolPath(directory, "directory");
  const anchors: Anchors = {};
  capture(directory, anchors, privateRoot, true);
  const mapped = new Map<string, string>();
  const seen = new Set<string>();
  const records = targets.map((target, index) => {
    if (!path.isAbsolute(target.path) || path.resolve(target.path) !== target.path || !containsPath(home, target.path) || path.resolve(target.path) === path.resolve(home)) {
      throw new Error("Claim sources must be normalized paths inside the approved home.");
    }
    const source = path.join(canonical, path.relative(home, target.path));
    if (seen.has(source) || [...seen].some((other) => containsPath(other, source) || containsPath(source, other))) throw new Error("Claim sources cannot overlap.");
    seen.add(source);
    let parent = path.dirname(source);
    let missingLeaf: string | undefined;
    if (!target.identity) {
      for (;;) {
        try { snapshotClaimIdentity(parent); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          missingLeaf = path.basename(parent);
          parent = path.dirname(parent);
        }
      }
    }
    capture(parent, anchors, privateRoot);
    const slot = `${String(index).padStart(3, "0")}-${path.basename(source)}`;
    if (target.identity) mapped.set(target.path, path.join(directory, "original", slot));
    return { source, slot, ...(target.identity ? { identity: encode(target.identity) } : {}),
      ...(missingLeaf ? { missingParent: parent, missingLeaf } : {}) };
  });
  await recordPathClaim(directory, targets.map((target) => target.path), home);
  try { await run({ operation: "claim", directory, anchors, targets: records }, directory); }
  catch (error) {
    let metadataChanged = true;
    try {
      const record = JSON.parse((await readPrivateFile(canonical, path.join(directory, "claim.json"))).toString("utf8")) as { state?: string };
      metadataChanged = record.state !== "restored";
    } catch (inspectionError) {
      if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") metadataChanged = false;
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { metadataChanged, unconfirmedTrash: metadataChanged, recoveryPath: directory });
  }
  return {
    directory,
    files: mapped,
    publish: async (replacements) => {
      const values: Record<string, unknown> = {};
      const workAnchors: Anchors = {};
      for (const [source, work] of replacements) {
        if (!targets.some((target) => target.path === source) || !containsPath(path.join(directory, "work"), work) || work === path.join(directory, "work")) {
          throw new Error("Publish files must match approved sources and private work storage.");
        }
        capture(path.dirname(work), workAnchors, privateRoot);
        values[path.join(canonical, path.relative(home, source))] = { path: work, identity: encode(snapshotClaimIdentity(work)) };
      }
      await run({ operation: "publish", directory, anchors, replacements: values, workAnchors }, directory);
    },
    rollback: () => run({ operation: "rollback", directory, anchors }, directory),
    markTrashed: () => run({ operation: "trashed", directory, anchors }, directory)
  };
}
