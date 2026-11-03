import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseCommit } from "./draft-release.mjs";
import { validateReleaseMetadata } from "./package-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// 只發布同一次執行打包並寫入 SHA256SUMS 的 archive，回傳 npm 用來比對內容的 sha512 完整性值。
export function verifyReleaseArchive(filename, archive, checksums) {
  if (checksums !== `${createHash("sha256").update(archive).digest("hex")}  ${filename}\n`) {
    throw new Error("The release archive does not match SHA256SUMS.");
  }
  return `sha512-${createHash("sha512").update(archive).digest("base64")}`;
}

// 重跑工作時，npm 上已有且內容相同的版本視為已發布；內容不同則停止，不公開 Draft。
export function publishCommands(release, integrity, publishedIntegrity, tag, repository) {
  if (publishedIntegrity !== undefined && publishedIntegrity !== integrity) {
    throw new Error("npm already has this version with different contents.");
  }
  return [
    ...(publishedIntegrity === undefined
      ? [["npm", ["publish", path.join("release", release.filename), "--tag", "latest", "--access", "public"]]]
      : []),
    ["gh", ["release", "edit", tag, "--repo", repository, "--draft=false"]]
  ];
}

function main() {
  if (process.argv.length !== 2) throw new Error("This script does not accept arguments.");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const tag = process.env.RELEASE_TAG;
  const repository = process.env.GITHUB_REPOSITORY;
  const commit = process.env.GITHUB_SHA;
  const release = validateReleaseMetadata(pkg, lock, tag);
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || tag === undefined ||
      !/^[a-f0-9]{40}$/i.test(commit ?? "")) throw new Error("Missing or invalid release repository/tag/commit.");
  const integrity = verifyReleaseArchive(release.filename, readFileSync(path.join(root, "release", release.filename)),
    readFileSync(path.join(root, "release", "SHA256SUMS"), "utf8"));
  const run = (binary, args) => execFileSync(binary, args, { cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  // npm 對尚未發布的版本回傳錯誤，因此先讀版本清單，其他錯誤仍會停止工作。
  const versions = [JSON.parse(run("npm", ["view", pkg.name, "versions", "--json"]))].flat();
  const published = versions.includes(release.version)
    ? run("npm", ["view", `${pkg.name}@${release.version}`, "dist.integrity"]).trim()
    : undefined;
  for (const [binary, args] of publishCommands(release, integrity, published, tag, repository)) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000 }).trim();
    const reference = JSON.parse(run("gh", ["api", `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`]));
    assertReleaseCommit(tag, commit, head, reference, (sha) => JSON.parse(run("gh", ["api", `repos/${repository}/git/tags/${sha}`])));
    process.stdout.write(run(binary, args));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
