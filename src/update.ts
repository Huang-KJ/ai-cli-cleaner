import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { systemTrashBinary } from "./fs/trash.js";
import { toolEnvironment, trustedToolPath } from "./fs/trusted-tools.js";

const repository = "Huang-KJ/ai-cli-cleaner";
const api = `https://api.github.com/repos/${repository}`;
const packageName = "ai-cli-cleaner";
const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const metadataLimit = 2 * 1024 * 1024;
const totalMetadataLimit = 8 * 1024 * 1024;
const pageLimit = 10;
const archiveLimit = 40 * 1024 * 1024;
export interface RequestOptions { maxBytes: number; accept: string }
export type UpdateTransport = (url: string, options: RequestOptions) => Promise<Buffer>;
export type UpdateRunner = (args: string[], options?: { env: NodeJS.ProcessEnv }) => Promise<string>;
interface Asset { id: number; name: string; size: number; url: string }
export interface UpdateResult {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  releaseUrl: string;
  archive: Asset;
  checksums: Asset;
}
interface CheckOptions { currentVersion?: string; prerelease?: boolean; transport?: UpdateTransport }
interface InstallOptions {
  packageRoot?: string;
  transport?: UpdateTransport;
  run?: UpdateRunner;
  trash?: (paths: string[]) => Promise<void>;
  createTemp?: () => Promise<string>;
  uid?: number;
}
interface Version { core: bigint[]; prerelease: string[] }

const { parseVersion, compareVersions } = createRequire(import.meta.url)("../lib/version.cjs") as {
  parseVersion(value: string): Version | undefined;
  compareVersions(left: string, right: string): number;
};
export { compareVersions };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asset(value: unknown, name: string, limit: number): Asset {
  if (!record(value) || !Number.isSafeInteger(value.id) || Number(value.id) < 1 || value.name !== name ||
      !Number.isSafeInteger(value.size) || Number(value.size) < 1 || Number(value.size) > limit ||
      value.url !== `${api}/releases/assets/${value.id}`) throw new Error(`Invalid GitHub release asset: ${name}.`);
  return { id: Number(value.id), name, size: Number(value.size), url: String(value.url) };
}

async function bounded(transport: UpdateTransport, url: string, maxBytes: number, accept: string): Promise<Buffer> {
  const body = await transport(url, { maxBytes, accept });
  if (!Buffer.isBuffer(body) || body.length > maxBytes) throw new Error("GitHub response exceeded the size limit.");
  return body;
}

export async function checkForUpdate(options: CheckOptions = {}): Promise<UpdateResult> {
  const currentVersion = options.currentVersion ?? (JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version: string }).version;
  if (!parseVersion(currentVersion)) throw new Error("Invalid release version.");
  const transport = options.transport ?? request;
  let chosen: { value: Record<string, unknown>; number: string } | undefined;
  let totalBytes = 0;
  for (let page = 1; page <= pageLimit; page++) {
    const body = await bounded(transport, `${api}/releases?per_page=100&page=${page}`,
      Math.min(metadataLimit, totalMetadataLimit - totalBytes), "application/vnd.github+json");
    totalBytes += body.length;
    let releases: unknown;
    try { releases = JSON.parse(body.toString("utf8")); } catch { throw new Error("GitHub returned invalid release metadata."); }
    if (!Array.isArray(releases) || releases.length > 100) throw new Error("GitHub returned invalid release metadata.");
    for (const value of releases) {
      if (!record(value) || value.draft !== false || typeof value.published_at !== "string" ||
          !Number.isFinite(Date.parse(value.published_at)) || typeof value.tag_name !== "string") continue;
      const number = value.tag_name.replace(/^v/, "");
      const parsed = parseVersion(number);
      if (!parsed || typeof value.prerelease !== "boolean" || (!options.prerelease && (value.prerelease || parsed.prerelease.length))) continue;
      if (!chosen || compareVersions(number, chosen.number) > 0) chosen = { value, number };
    }
    if (releases.length < 100) break;
    if (page === pageLimit || totalBytes >= totalMetadataLimit) {
      throw new Error("GitHub release history exceeded the update check limit. Check the repository releases manually; the latest version could not be determined safely.");
    }
  }
  if (!chosen) throw new Error(`No published ${options.prerelease ? "" : "stable "}GitHub release is available. Private repositories and draft releases cannot be updated anonymously. Try --prerelease for a published preview, or install a published release manually.`);
  const rawUrl = `https://github.com/${repository}/releases/tag/${chosen.value.tag_name}`;
  const releaseUrl = `https://github.com/${repository}/releases/tag/${encodeURIComponent(String(chosen.value.tag_name))}`;
  if (![rawUrl, releaseUrl].includes(String(chosen.value.html_url)) || !Array.isArray(chosen.value.assets)) throw new Error("Invalid GitHub release metadata.");
  const archiveName = `${packageName}-${chosen.number}.tgz`;
  const selected = (name: string, limit: number) => {
    const matches = chosen.value.assets as unknown[];
    const found = matches.filter((entry) => record(entry) && entry.name === name);
    if (found.length !== 1) throw new Error(`Expected one GitHub release asset named ${name}.`);
    return asset(found[0], name, limit);
  };
  return {
    currentVersion, latestVersion: chosen.number,
    available: compareVersions(chosen.number, currentVersion) > 0,
    releaseUrl, archive: selected(archiveName, archiveLimit), checksums: selected("SHA256SUMS", 64 * 1024)
  };
}

function installEnvironment(stage?: string): NodeJS.ProcessEnv {
  return { ...toolEnvironment(), npm_config_userconfig: stage ? path.join(stage, "user.npmrc") : "/dev/null",
    npm_config_globalconfig: stage ? path.join(stage, "global.npmrc") : "/var/empty/ai-cleaner-global.npmrc", npm_config_update_notifier: "false" };
}

async function bindNpm(prefix: string): Promise<UpdateRunner> {
  try {
    const node = await trustedToolPath(process.execPath, "executable");
    const installed = path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    let script = installed;
    try { await fs.lstat(path.join(prefix, "lib", "node_modules", "npm")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      script = path.resolve(path.dirname(node), "../lib/node_modules/npm/bin/npm-cli.js");
    }
    const npm = await trustedToolPath(script, "file");
    const npmRoot = await trustedToolPath(path.resolve(script, "../.."), "directory", false, true);
    if (path.join(npmRoot, "bin", "npm-cli.js") !== npm) throw new Error("Invalid npm package entrypoint.");
    return async (args, options) => {
      if (await trustedToolPath(node, "executable") !== node || await trustedToolPath(npm, "file") !== npm) {
        throw new Error("The bound npm toolchain changed; update canceled.");
      }
      const result = await exec(node, [npm, ...args], { cwd: prefix, env: options?.env ?? installEnvironment(),
        timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
      return result.stdout.trim();
    };
  } catch (error) {
    throw new Error("Cannot bind a trusted npm toolchain. Install npm 12 in this global prefix or alongside the running Node.js, then retry.", { cause: error });
  }
}

function verifyArchive(archive: Buffer, expected: string): void {
  let tar: Buffer;
  try { tar = gunzipSync(archive, { maxOutputLength: 120 * 1024 * 1024 }); } catch { throw new Error("Invalid or oversized release archive."); }
  let manifest: unknown;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid release archive entry.");
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length || !fullName.startsWith("package/") || fullName.includes("\\") || fullName.split("/").includes("..") ||
        ![0, 48, 53].includes(header[156]!)) throw new Error("Invalid release archive entry.");
    if (fullName === "package/package.json") {
      if (manifest !== undefined || size > 64 * 1024 || ![0, 48].includes(header[156]!)) throw new Error("Invalid release package manifest.");
      try { manifest = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString("utf8")); } catch { throw new Error("Invalid release package manifest."); }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!record(manifest) || manifest.name !== packageName || manifest.version !== expected) throw new Error("Release package name or version does not match GitHub metadata.");
}

export async function installUpdate(result: UpdateResult, options: InstallOptions = {}): Promise<void> {
  if ((options.uid ?? process.getuid?.()) === 0 || process.env.SUDO_UID) throw new Error("Run updates as your normal user, without sudo. Use a user-owned npm global prefix.");
  if (compareVersions(result.latestVersion, result.currentVersion) <= 0 || !result.available) throw new Error("No newer release is available; refusing to reinstall or downgrade.");
  const archive = asset(result.archive, `${packageName}-${result.latestVersion}.tgz`, archiveLimit);
  const checksums = asset(result.checksums, "SHA256SUMS", 64 * 1024);
  const packageRoot = options.packageRoot ?? root;
  const info = await fs.lstat(packageRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Self-update requires a regular npm global installation, not npm link.");
  try { await fs.lstat(path.join(packageRoot, ".git")); throw new Error("Source checkouts cannot self-update. Install a GitHub release globally first."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const current = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as unknown;
  if (!record(current) || current.name !== packageName || current.version !== result.currentVersion) throw new Error("The installed package changed; run the update check again.");
  const canonicalRoot = await trustedToolPath(packageRoot, "directory");
  const owningPrefix = path.resolve(canonicalRoot, "../../..");
  if (path.join(owningPrefix, "lib", "node_modules", packageName) !== canonicalRoot) {
    throw new Error("Self-update requires a regular npm global installation.");
  }
  // 可信父路徑讓其他帳號無法在 npm 重新開啟 archive 前替換整個 stage。
  const temporaryRoot = await trustedToolPath(tmpdir(), "directory");
  const run = options.run ?? await bindNpm(owningPrefix);
  // 只查詢安裝位置；下載及安裝階段不使用帳號設定。
  const prefix = (await run(["prefix", "--global", "--prefix", owningPrefix], { env: installEnvironment() })).trim();
  const globalRoot = (await run(["root", "--global", "--prefix", owningPrefix], { env: installEnvironment() })).trim();
  if (!path.isAbsolute(prefix) || !path.isAbsolute(globalRoot) || await fs.realpath(packageRoot) !== await fs.realpath(path.join(globalRoot, packageName)) ||
      path.resolve(globalRoot) !== path.join(path.resolve(prefix), "lib", "node_modules")) throw new Error("Self-update requires this package to be installed in the active npm global prefix. Reinstall it using the npm that owns this command.");
  await fs.access(prefix, 2);
  const globalInfo = await fs.lstat(path.join(globalRoot, packageName));
  if (!globalInfo.isDirectory() || globalInfo.isSymbolicLink()) throw new Error("Self-update does not support npm link installations.");
  const npmVersion = (await run(["--version"], { env: installEnvironment() })).trim();
  if (!/^12\.\d+\.\d+$/.test(npmVersion)) throw new Error("Self-update requires npm 12. Install npm 12, then retry.");
  const transport = options.transport ?? request;
  const sums = await bounded(transport, checksums.url, checksums.size, "application/octet-stream");
  if (sums.length !== checksums.size) throw new Error("GitHub checksum asset size does not match metadata.");
  const matches = sums.toString("utf8").split(/\r?\n/).map((line) => /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line)).filter((entry) => entry?.[2] === archive.name);
  if (matches.length !== 1) throw new Error("Expected exactly one archive checksum in SHA256SUMS.");
  const bytes = await bounded(transport, archive.url, archive.size, "application/octet-stream");
  if (bytes.length !== archive.size || createHash("sha256").update(bytes).digest("hex") !== matches[0]![1]!.toLowerCase()) throw new Error("Release archive checksum verification failed. Nothing was installed.");
  verifyArchive(bytes, result.latestVersion);
  const stage = await (options.createTemp?.() ?? fs.mkdtemp(path.join(temporaryRoot, "ai-cleaner-update-")));
  const stageInfo = await fs.lstat(stage);
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink() || stageInfo.uid !== process.getuid?.() ||
      (stageInfo.mode & 0o7777) !== 0o700 || path.dirname(await fs.realpath(stage)) !== temporaryRoot ||
      !path.basename(stage).startsWith("ai-cleaner-update-")) throw new Error("Invalid update staging directory.");
  await trustedToolPath(stage, "directory");
  let cleanup = options.trash;
  try {
    if (!cleanup) {
      // 更新會取代目前套件，先保留已驗證的垃圾桶執行檔。
      const source = systemTrashBinary();
      const binary = path.join(stage, "trash");
      await fs.copyFile(source, binary, fs.constants.COPYFILE_EXCL);
      systemTrashBinary();
      const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      if (hash(await fs.readFile(binary)) !== hash(await fs.readFile(source))) throw new Error("Native Trash copy verification failed.");
      await fs.chmod(binary, 0o700);
      cleanup = async (paths) => { await exec(binary, paths, { env: toolEnvironment(), timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }); };
    }
    const file = path.join(stage, archive.name);
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    await fs.writeFile(path.join(stage, "user.npmrc"), "", { flag: "wx", mode: 0o600 });
    await fs.writeFile(path.join(stage, "global.npmrc"), "", { flag: "wx", mode: 0o600 });
    await run(["install", "--global", "--prefix", prefix, "--ignore-scripts", "--offline", "--engine-strict", "--no-audit", "--no-fund", "--allow-file=all", "--cache", path.join(stage, "npm-cache"), "--", file], { env: installEnvironment(stage) });
    const installed: unknown = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (!record(installed) || installed.name !== packageName || installed.version !== result.latestVersion) throw new Error("npm did not install the expected package version. Inspect the installation before retrying.");
  } finally {
    const finalInfo = await fs.lstat(stage);
    if (finalInfo.dev !== stageInfo.dev || finalInfo.ino !== stageInfo.ino || finalInfo.isSymbolicLink()) throw new Error("Update staging directory changed; cleanup was refused.");
    if (!cleanup) throw new Error(`Update staging could not be cleaned safely; move this directory to Trash manually: ${stage}`);
    try {
      await cleanup([stage]);
      const remaining = await fs.lstat(stage).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (remaining) throw new Error("The staging directory still exists.");
    } catch (error) { throw new Error(`Update staging cleanup failed. Move this directory to Trash manually: ${stage}`, { cause: error }); }
  }
}

function request(url: string, options: RequestOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { active?.destroy(new Error("GitHub update request timed out.")); }, 30_000);
    let active: ReturnType<typeof https.get> | undefined;
    const finish = (error?: Error, value?: Buffer) => { clearTimeout(deadline); error ? reject(error) : resolve(value!); };
    const get = (target: string, redirects: number) => {
      let parsed: URL;
      try { parsed = new URL(target); } catch { finish(new Error("Invalid GitHub download URL.")); return; }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
          !((redirects === 0 && parsed.hostname === "api.github.com" && parsed.pathname.startsWith(`/repos/${repository}/releases`)) ||
            (redirects > 0 && parsed.hostname === "release-assets.githubusercontent.com"))) {
        finish(new Error("GitHub redirected the download to an untrusted host.")); return;
      }
      active = https.get(parsed, { headers: { Accept: options.accept, "User-Agent": "ai-cli-cleaner", "X-GitHub-Api-Version": "2022-11-28" } }, (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          if (!response.headers.location || redirects >= 3) { finish(new Error("Invalid GitHub download redirect.")); return; }
          try { get(new URL(response.headers.location, parsed).href, redirects + 1); }
          catch { finish(new Error("Invalid GitHub download redirect.")); }
          return;
        }
        if (status !== 200) {
          response.destroy();
          const message = status === 404 ? "No public GitHub release is accessible. Private repositories and draft releases cannot be updated anonymously. Install a published release manually." : status === 403 || status === 429 ? "GitHub rate limited the update check. Retry later." : `GitHub update request failed (HTTP ${status}).`;
          finish(new Error(message)); return;
        }
        if (Number(response.headers["content-length"]) > options.maxBytes) { response.destroy(); finish(new Error("GitHub response exceeded the size limit.")); return; }
        const chunks: Buffer[] = [];
        let count = 0;
        response.on("data", (chunk: Buffer) => {
          count += chunk.length;
          if (count > options.maxBytes) { response.destroy(); finish(new Error("GitHub response exceeded the size limit.")); }
          else chunks.push(chunk);
        });
        response.on("end", () => finish(undefined, Buffer.concat(chunks)));
        response.on("error", (error) => finish(error));
        response.on("aborted", () => finish(new Error("GitHub download was interrupted.")));
      });
      active.on("error", (error) => finish(error));
    };
    get(url, 0);
  });
}
