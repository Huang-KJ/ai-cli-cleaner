import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import native from "../lib/native-helper.cjs";
import claims from "../lib/claim-helper.cjs";
import version from "../lib/version.cjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function validateReleaseMetadata(pkg, lock, tag) {
  const parsed = version.parseVersion(pkg?.version);
  if (pkg?.name !== "ai-cli-cleaner" || !parsed) throw new Error("Invalid package name or version format.");
  if (lock?.name !== pkg.name || lock.version !== pkg.version ||
      lock.packages?.[""]?.name !== pkg.name || lock.packages?.[""]?.version !== pkg.version) {
    throw new Error("package.json and lockfile versions do not match.");
  }
  if (tag !== undefined && tag !== `v${pkg.version}`) throw new Error("Package version does not match the release tag.");
  return { version: pkg.version, prerelease: parsed.prerelease.length > 0, filename: `${pkg.name}-${pkg.version}.tgz` };
}

function run(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(binary)} failed with status ${result.status ?? result.signal}`);
}

async function existing(file) {
  try { return await fs.lstat(file); }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function trash(files) {
  if (!files.length) return;
  const helper = native.verifyNativeArtifact();
  run(helper, files);
  for (const file of files) {
    if (await existing(file)) throw new Error(`Trash operation did not complete: ${file}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--validate") || args.length > 1) throw new Error("Unsupported arguments; only --validate is accepted.");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
  const tag = process.env.RELEASE_TAG ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
  const release = validateReleaseMetadata(pkg, lock, tag);
  if (args.includes("--validate")) {
    console.log(`Version validation passed: ${pkg.version}`);
    return;
  }
  if (process.platform !== "darwin") throw new Error("Release checks and packaging must run on macOS.");
  native.verifyNativeArtifact();
  claims.verifyClaimArtifact();
  // 通過完整檢查後才產生可發布成品，不提供略過檢查的參數。
  run(process.execPath, ["scripts/audit-dependencies.cjs"]);
  run("npm", ["run", "check"]);
  const output = path.join(root, "release");
  await fs.mkdir(output, { recursive: true });
  const outputStat = await fs.lstat(output);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || await fs.realpath(output) !== path.join(await fs.realpath(root), "release")) {
    throw new Error("release must be a real directory inside the project.");
  }
  const stage = await fs.mkdtemp(path.join(output, ".staging-"));
  try {
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", stage]);
    const filename = release.filename;
    const archive = path.join(stage, filename);
    const archiveStat = await fs.lstat(archive);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw new Error("npm did not create the expected package archive.");
    const digest = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
    const checksum = path.join(stage, "SHA256SUMS");
    await fs.writeFile(checksum, `${digest}  ${filename}\n`, { flag: "wx" });
    const destinations = [path.join(output, filename), path.join(output, "SHA256SUMS")];
    const previous = [];
    for (const file of destinations) {
      const stat = await existing(file);
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to replace a non-regular release artifact: ${file}`);
      previous.push(file);
    }
    await trash(previous);
    await fs.rename(archive, destinations[0]);
    await fs.rename(checksum, destinations[1]);
    console.log(`Release artifact: ${destinations[0]}\nSHA-256: ${digest}`);
  } finally {
    await trash([stage]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
