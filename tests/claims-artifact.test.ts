import { cp, mkdir, writeFile, chmod, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const { verifyClaimArtifact } = createRequire(import.meta.url)("../lib/claim-helper.cjs") as {
  verifyClaimArtifact(root?: string): string;
};

describe("native claim provenance", () => {
  it("verifies the pinned source and universal executable without running either", () => {
    expect(verifyClaimArtifact()).toMatch(/vendor\/macos-claims$/);
  });
  it.each(["source", "binary", "provenance", "permissions", "symlink"])("rejects isolated %s changes", async (kind) => {
    const root = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-artifact-"));
    try {
      await mkdir(path.join(root, "native"));
      await mkdir(path.join(root, "vendor"));
      await cp(new URL("../native/claims.m", import.meta.url), path.join(root, "native", "claims.m"));
      await cp(new URL("../vendor/macos-claims", import.meta.url), path.join(root, "vendor", "macos-claims"));
      await cp(new URL("../vendor/claims-provenance.json", import.meta.url), path.join(root, "vendor", "claims-provenance.json"));
      if (kind === "source") await writeFile(path.join(root, "native", "claims.m"), "modified source");
      if (kind === "binary") await writeFile(path.join(root, "vendor", "macos-claims"), "modified executable");
      if (kind === "provenance") await writeFile(path.join(root, "vendor", "claims-provenance.json"), "{}");
      if (kind === "permissions") await chmod(path.join(root, "vendor", "macos-claims"), 0o600);
      if (kind === "symlink") {
        await fixtureTrash(path.join(root, "native", "claims.m"));
        await symlink(new URL("../native/claims.m", import.meta.url), path.join(root, "native", "claims.m"));
      }
      expect(() => verifyClaimArtifact(root)).toThrow(/Native claim artifact verification failed/);
    } finally { await fixtureTrash(root, { recursive: true, force: true }); }
  });
});
