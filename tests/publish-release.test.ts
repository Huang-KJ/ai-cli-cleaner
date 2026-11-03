import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const { verifyReleaseArchive, publishCommands } = await import(new URL("../scripts/publish-release.mjs", import.meta.url).href) as {
  verifyReleaseArchive: (filename: string, archive: Buffer, checksums: string) => string;
  publishCommands: (release: { filename: string }, integrity: string, publishedIntegrity: string | undefined,
    tag: string, repository: string) => [string, string[]][];
};
const repository = "Huang-KJ/ai-cli-cleaner";
const filename = "ai-cli-cleaner-1.2.3.tgz";
const archive = Buffer.from("synthetic archive");
const checksums = `${createHash("sha256").update(archive).digest("hex")}  ${filename}\n`;
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;

describe("automatic npm publication contract", () => {
  it("returns npm's sha512 integrity only for the archive named in SHA256SUMS", () => {
    expect(verifyReleaseArchive(filename, archive, checksums)).toBe(integrity);
    expect(() => verifyReleaseArchive(filename, Buffer.from("other bytes"), checksums)).toThrow("does not match SHA256SUMS");
    expect(() => verifyReleaseArchive("ai-cli-cleaner-1.2.4.tgz", archive, checksums)).toThrow("does not match SHA256SUMS");
    expect(() => verifyReleaseArchive(filename, archive, `${checksums}extra\n`)).toThrow("does not match SHA256SUMS");
  });

  it("publishes the verified archive under latest before publishing the GitHub draft", () => {
    expect(publishCommands({ filename }, integrity, undefined, "v1.2.3", repository)).toEqual([
      ["npm", ["publish", `./release/${filename}`, "--tag", "latest", "--access", "public"]],
      ["gh", ["release", "edit", "v1.2.3", "--repo", repository, "--draft=false"]]
    ]);
  });

  it("only publishes the GitHub draft when a rerun finds identical bytes on npm", () => {
    expect(publishCommands({ filename }, integrity, integrity, "v1.2.3", repository)).toEqual([
      ["gh", ["release", "edit", "v1.2.3", "--repo", repository, "--draft=false"]]
    ]);
  });

  it("stops before any write when npm has different bytes for the version", () => {
    expect(() => publishCommands({ filename }, integrity, "sha512-other", "v1.2.3", repository)).toThrow("different contents");
  });
});
