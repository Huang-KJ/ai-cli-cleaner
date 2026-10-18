import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureTempSync, fixtureTrashSync } from "./helpers/fixture-trash.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = packageMetadata.version;
const { validateReleaseMetadata } = await import(new URL("../scripts/package-release.mjs", import.meta.url).href) as {
  validateReleaseMetadata: (pkg: unknown, lock: unknown, tag?: string) => { version: string; prerelease: boolean; filename: string };
};
const releaseMetadata = (value: string) => ({ pkg: { name: "ai-cli-cleaner", version: value },
  lock: { name: "ai-cli-cleaner", version: value, packages: { "": { name: "ai-cli-cleaner", version: value } } } });

function validate(tag: string) {
  return spawnSync(process.execPath, ["scripts/package-release.mjs", "--validate"], {
    cwd: root, encoding: "utf8", env: { ...process.env, RELEASE_TAG: tag }
  });
}

function validateGithubTag(tag: string) {
  const environment: NodeJS.ProcessEnv = { ...process.env, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: tag };
  delete environment.RELEASE_TAG;
  return spawnSync(process.execPath, ["scripts/package-release.mjs", "--validate"], {
    cwd: root, encoding: "utf8", env: environment
  });
}

function releaseSnapshot() {
  const directory = join(root, "release");
  let info;
  try { info = lstatSync(directory); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { kind: "other", dev: info.dev, ino: info.ino, mode: info.mode };
  }
  const artifacts = [`${packageMetadata.name}-${version}.tgz`, "SHA256SUMS"].map((name) => {
    try {
      const artifact = join(directory, name);
      const artifactInfo = lstatSync(artifact);
      return artifactInfo.isFile() && !artifactInfo.isSymbolicLink()
        ? { name, kind: "file", contents: readFileSync(artifact) }
        : { name, kind: "other", dev: artifactInfo.dev, ino: artifactInfo.ino, mode: artifactInfo.mode };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { name, kind: "missing" };
      throw error;
    }
  });
  return { kind: "directory", dev: info.dev, ino: info.ino, artifacts };
}

describe("release packaging validation", () => {
  it.each(["01.2.3", "1.2.03", "1.0.0-a..b", "1.0.0-01", "1.0.0\n"])("rejects invalid SemVer %s before packaging", (value) => {
    const { pkg, lock } = releaseMetadata(value);
    expect(() => validateReleaseMetadata(pkg, lock, `v${value}`)).toThrow("Invalid package name or version format");
  });

  it("aligns stable/beta metadata and rejects inconsistent lockfile versions", () => {
    const stable = releaseMetadata("1.2.3+build.01");
    expect(validateReleaseMetadata(stable.pkg, stable.lock, "v1.2.3+build.01")).toEqual({
      version: "1.2.3+build.01", prerelease: false, filename: "ai-cli-cleaner-1.2.3+build.01.tgz"
    });
    const beta = releaseMetadata("1.2.3-beta.1+build.01");
    expect(validateReleaseMetadata(beta.pkg, beta.lock).prerelease).toBe(true);
    expect(() => validateReleaseMetadata(beta.pkg, stable.lock)).toThrow("lockfile versions do not match");
  });

  it("uses the exact npm 12 archive filename for build metadata and private packages", () => {
    const scratch = fixtureTempSync(join(tmpdir(), "ai-cleaner-pack-version-"));
    const source = join(scratch, "source");
    mkdirSync(source);
    try {
      const { pkg, lock } = releaseMetadata("1.2.3-beta.2+build.01");
      writeFileSync(join(source, "package.json"), JSON.stringify({ ...pkg, private: true, files: [] }));
      const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--offline", "--json", "--cache", join(scratch, "cache")], {
        cwd: source, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL"
      });
      expect(result.status, result.stderr).toBe(0);
      const records = JSON.parse(result.stdout) as Record<string, { filename: string; version: string }>;
      expect(Object.values(records)).toHaveLength(1);
      expect(Object.values(records)[0]?.filename).toBe(validateReleaseMetadata(pkg, lock).filename);
      expect(Object.values(records)[0]?.version).toBe(pkg.version);
    } finally { fixtureTrashSync(scratch, { recursive: true, force: true }); }
  }, 25_000);

  it("blocks an unapproved audit before building or replacing release artifacts", () => {
    const previousRelease = releaseSnapshot();
    const scratch = fixtureTempSync(join(tmpdir(), "ai-cleaner-release-audit-"));
    const marker = join(scratch, "build-started");
    const binary = join(scratch, "npm");
    try {
      writeFileSync(binary, `#!/usr/bin/env node\nconst fs = require("node:fs");\nif (process.argv[2] === "audit") {\n  console.log(JSON.stringify({ vulnerabilities: { unexpected: { severity: "moderate", via: [{ severity: "high", url: "https://github.com/advisories/GHSA-unapproved" }] } } }));\n  process.exitCode = 1;\n} else { fs.writeFileSync(${JSON.stringify(marker)}, "started"); process.exitCode = 42; }\n`);
      chmodSync(binary, 0o700);
      const result = spawnSync(process.execPath, ["scripts/package-release.mjs"], {
        cwd: root, encoding: "utf8", timeout: 25_000,
        env: { ...process.env, PATH: `${scratch}${delimiter}${process.env.PATH}` }
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("High/critical dependency risks found: unexpected");
      expect(existsSync(marker)).toBe(false);
      expect(releaseSnapshot()).toEqual(previousRelease);
    } finally { fixtureTrashSync(scratch, { recursive: true, force: true }); }
  }, 30_000);
  it("accepts a matching version without building, installing, or packing", () => {
    const result = validate(`v${version}`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Version validation passed: ${version}`);
    expect(result.stdout).not.toMatch(/vitest|npm pack/);
  });

  it("accepts the matching GitHub tag when RELEASE_TAG is unset", () => {
    const result = validateGithubTag(`v${version}`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Version validation passed: ${version}`);
  });

  it("rejects a release tag for another version before running package scripts", () => {
    const result = validate("v999.0.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Package version does not match the release tag/);
    expect(result.stdout).toBe("");
  });

  it("rejects a mismatched GitHub tag when RELEASE_TAG is unset", () => {
    const result = validateGithubTag("v999.0.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Package version does not match the release tag/);
    expect(result.stdout).toBe("");
  });

  it("rejects unrecognised arguments rather than silently producing release artifacts", () => {
    const result = spawnSync(process.execPath, ["scripts/package-release.mjs", "--skip-check"], {
      cwd: root, encoding: "utf8"
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported arguments");
  });
});
