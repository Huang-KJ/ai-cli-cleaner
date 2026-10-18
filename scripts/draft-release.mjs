import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseMetadata } from "./package-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const validSha = (value) => typeof value === "string" && value.length === 40 && /^[a-f0-9]{40}$/i.test(value);

export function assertReleaseCommit(tag, commit, head, reference, readTag) {
  if (!validSha(commit) || head !== commit) throw new Error("Checked-out HEAD does not match the workflow commit.");
  if (!reference || reference.ref !== `refs/tags/${tag}`) throw new Error("Could not verify the exact remote release tag.");
  const seen = new Set();
  let object = reference.object;
  // 限制巢狀標籤深度，未知物件、循環與移動的標籤均停止寫入。
  for (let depth = 0; depth <= 5; depth++) {
    if (!object || !validSha(object.sha)) throw new Error("Invalid remote release tag object.");
    if (object.type === "commit") {
      if (object.sha !== commit) throw new Error("The remote release tag moved or does not match the workflow commit.");
      return;
    }
    if (object.type !== "tag" || depth === 5 || seen.has(object.sha)) throw new Error("Could not safely resolve the remote release tag.");
    seen.add(object.sha);
    const annotated = readTag(object.sha);
    if (!annotated || annotated.sha !== object.sha) throw new Error("Invalid annotated release tag object.");
    object = annotated.object;
  }
}

export function draftReleaseCommands(pages, pkg, lock, tag, repository, commit) {
  const release = validateReleaseMetadata(pkg, lock, tag);
  if (tag === undefined || typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !validSha(commit)) throw new Error("Missing or invalid release repository/tag/commit.");
  // 完整頁面及唯一標籤均須確認，不能把讀取失敗視為版本不存在。
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every((page) => Array.isArray(page) &&
      page.every((item) => item && typeof item.tag_name === "string"))) throw new Error("Could not parse the Release API response.");
  const matches = pages.flat().filter((item) => item.tag_name === tag);
  const existing = matches[0];
  if (matches.length > 1 || (existing && (existing.draft !== true || existing.prerelease !== release.prerelease ||
      existing.published_at !== null || !Number.isSafeInteger(existing.id) || existing.id < 1))) {
    throw new Error("The existing release is not an unpublished draft with the expected stable/prerelease channel.");
  }
  const files = [path.join("release", release.filename), path.join("release", "SHA256SUMS")];
  return existing
    ? [["api", "--method", "PATCH", `repos/${repository}/releases/${existing.id}`,
      "-f", `tag_name=${tag}`, "-f", `target_commitish=${commit}`, "-f", `name=${typeof existing.name === "string" ? existing.name : tag}`,
      "-F", "draft=true", "-F", `prerelease=${release.prerelease}`],
    ["release", "upload", tag, ...files, "--repo", repository, "--clobber"]]
    : [["release", "create", tag, ...files, "--repo", repository, "--draft", "--target", commit,
      ...(release.prerelease ? ["--prerelease"] : []), "--verify-tag", "--generate-notes", "--title", tag]];
}

function main() {
  if (process.argv.length !== 2) throw new Error("This script does not accept arguments.");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const tag = process.env.RELEASE_TAG;
  const repository = process.env.GITHUB_REPOSITORY;
  const commit = process.env.GITHUB_SHA;
  validateReleaseMetadata(pkg, lock, tag);
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || tag === undefined ||
      !validSha(commit)) throw new Error("Missing or invalid release repository/tag/commit.");
  const run = (args) => execFileSync("gh", args, { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const pages = JSON.parse(run(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]));
  for (const command of draftReleaseCommands(pages, pkg, lock, tag, repository, commit)) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000 }).trim();
    const reference = JSON.parse(run(["api", `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`]));
    assertReleaseCommit(tag, commit, head, reference, (sha) => JSON.parse(run(["api", `repos/${repository}/git/tags/${sha}`])));
    const output = run(command);
    if (command[0] === "release") process.stdout.write(output);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
