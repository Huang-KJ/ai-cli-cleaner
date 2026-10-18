import { describe, expect, it } from "vitest";

const { draftReleaseCommands, assertReleaseCommit } = await import(new URL("../scripts/draft-release.mjs", import.meta.url).href) as {
  draftReleaseCommands: (pages: unknown, pkg: unknown, lock: unknown, tag: string | undefined, repository: string, commit: string) => string[][];
  assertReleaseCommit: (tag: string, commit: string, head: string, reference: unknown, readTag: (sha: string) => unknown) => void;
};
const repository = "Huang-KJ/ai-cli-cleaner";
const commit = "a".repeat(40);
const name = "ai-cli-cleaner";
const metadata = (version: string) => ({ pkg: { name, version }, lock: { name, version, packages: { "": { name, version } } } });
function plan(version: string, pages: unknown = [[]]) {
  const { pkg, lock } = metadata(version);
  return draftReleaseCommands(pages, pkg, lock, `v${version}`, repository, commit);
}
const existing = (prerelease: boolean) => ({ id: 42, tag_name: prerelease ? "v1.2.3-beta.1" : "v1.2.3",
  name: "Prepared release", draft: true, prerelease, published_at: null, target_commitish: "b".repeat(40) });

describe("unpublished GitHub release channel contract", () => {
  it("prepares a stable draft without marking it prerelease", () => {
    const commands = plan("1.2.3");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual(["release", "create", "v1.2.3", "release/ai-cli-cleaner-1.2.3.tgz", "release/SHA256SUMS",
      "--repo", repository, "--draft", "--target", commit, "--verify-tag", "--generate-notes", "--title", "v1.2.3"]);
  });

  it("prepares a beta draft and retains build metadata in tag and artifact name", () => {
    const commands = plan("1.2.3-beta.1+build.01");
    expect(commands[0]).toContain("--prerelease");
    expect(commands[0]).toContain("--draft");
    expect(commands[0]).toContain("v1.2.3-beta.1+build.01");
    expect(commands[0]).toContain("release/ai-cli-cleaner-1.2.3-beta.1+build.01.tgz");
  });

  it.each([false, true])("updates a matching unpublished channel (%s) after the first API page", (prerelease) => {
    const item = existing(prerelease);
    const commands = plan(prerelease ? "1.2.3-beta.1" : "1.2.3", [[{ tag_name: "v0.1.0" }], [item]]);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(["api", "--method", "PATCH", `repos/${repository}/releases/42`,
      "-f", `tag_name=${item.tag_name}`, "-f", `target_commitish=${commit}`, "-f", "name=Prepared release",
      "-F", "draft=true", "-F", `prerelease=${prerelease}`]);
    expect(commands[1]).toEqual(["release", "upload", item.tag_name,
      `release/ai-cli-cleaner-${item.tag_name.slice(1)}.tgz`, "release/SHA256SUMS", "--repo", repository, "--clobber"]);
  });

  it.each([
    { ...existing(false), prerelease: true },
    { ...existing(false), draft: false, published_at: "2026-10-14T00:00:00Z" },
    { ...existing(false), published_at: "2026-10-14T00:00:00Z" },
    { ...existing(false), id: 0 }
  ])("refuses mismatched, published, or malformed existing releases", (item) => {
    expect(() => plan("1.2.3", [[item]])).toThrow("not an unpublished draft");
  });

  it("refuses duplicate versions instead of choosing an arbitrary draft", () => {
    expect(() => plan("1.2.3", [[existing(false)], [existing(false)]])).toThrow("not an unpublished draft");
  });

  it.each([null, {}, [], [null], [[null]], [[{ id: 42 }]]])("refuses incomplete API responses", (pages) => {
    expect(() => plan("1.2.3", pages)).toThrow("Could not parse");
  });

  it("requires exact version/tag alignment and a verified workflow commit", () => {
    const { pkg, lock } = metadata("1.2.3");
    expect(() => draftReleaseCommands([[]], pkg, lock, "v9.0.0", repository, commit)).toThrow("release tag");
    expect(() => draftReleaseCommands([[]], pkg, lock, undefined, repository, commit)).toThrow("repository/tag/commit");
    expect(() => draftReleaseCommands([[]], pkg, lock, "v1.2.3", repository, "main")).toThrow("repository/tag/commit");
  });
});

describe("release commit guard", () => {
  const tag = "v1.2.3+build.01";
  const ref = (type: string, sha: string) => ({ ref: `refs/tags/${tag}`, object: { type, sha } });
  const unused = () => { throw new Error("Unexpected tag lookup"); };

  it("accepts an exact lightweight tag without further requests", () => {
    expect(() => assertReleaseCommit(tag, commit, commit, ref("commit", commit), unused)).not.toThrow();
  });

  it("resolves annotated tags to the exact checked-out commit", () => {
    const first = "b".repeat(40), second = "c".repeat(40);
    const reads: string[] = [];
    assertReleaseCommit(tag, commit, commit, ref("tag", first), (sha) => {
      reads.push(sha);
      return sha === first ? { sha, object: { type: "tag", sha: second } } : { sha, object: { type: "commit", sha: commit } };
    });
    expect(reads).toEqual([first, second]);
  });

  it("refuses stale local HEAD and a moved remote tag", () => {
    expect(() => assertReleaseCommit(tag, commit, "b".repeat(40), ref("commit", commit), unused)).toThrow("HEAD does not match");
    expect(() => assertReleaseCommit(tag, commit, commit, ref("commit", "b".repeat(40)), unused)).toThrow("remote release tag moved");
  });

  it("rechecks a moved tag instead of reusing earlier verification", () => {
    const reference = ref("commit", commit);
    assertReleaseCommit(tag, commit, commit, reference, unused);
    reference.object.sha = "b".repeat(40);
    expect(() => assertReleaseCommit(tag, commit, commit, reference, unused)).toThrow("remote release tag moved");
  });

  it("refuses another ref, malformed SHA, or unknown object type", () => {
    expect(() => assertReleaseCommit(tag, commit, commit, { ...ref("commit", commit), ref: "refs/heads/main" }, unused)).toThrow("exact remote");
    expect(() => assertReleaseCommit(tag, commit, commit, ref("commit", commit + "\n"), unused)).toThrow("Invalid remote");
    expect(() => assertReleaseCommit(tag, commit + "\n", commit, ref("commit", commit), unused)).toThrow("HEAD does not match");
    expect(() => assertReleaseCommit(tag, commit, commit, ref("tree", commit), unused)).toThrow("safely resolve");
  });

  it("refuses cyclic, mismatched, or excessively nested annotated tags", () => {
    const annotated = "b".repeat(40);
    expect(() => assertReleaseCommit(tag, commit, commit, ref("tag", annotated), (sha) => ({ sha, object: { type: "tag", sha } }))).toThrow("safely resolve");
    expect(() => assertReleaseCommit(tag, commit, commit, ref("tag", annotated), () => ({ sha: commit }))).toThrow("Invalid annotated");
    let calls = 0;
    expect(() => assertReleaseCommit(tag, commit, commit, ref("tag", annotated), (sha) => {
      calls++;
      return { sha, object: { type: "tag", sha: calls.toString(16).padStart(40, "0") } };
    })).toThrow("safely resolve");
    expect(calls).toBe(5);
  });
});
