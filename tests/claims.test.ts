import { mkdir, writeFile, readFile, lstat, link, access, chmod, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimPaths, snapshotClaimIdentity } from "../src/fs/claims.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { withOperation, listOperations, inspectOperation, wrapOperationTrash } from "../src/recovery/operations.js";
import { moveToSystemTrash } from "../src/fs/trash.js";
import { rename } from "node:fs/promises";
import { cleanEntries } from "../src/cleaners/clean.js";

describe("anchored private claims", () => {
  it("mutates only a private copy and preserves a late hard-link alias", async () => {
    const home = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-"));
    try {
      const source = path.join(home, "source.db");
      const alias = path.join(home, "alias.db");
      await writeFile(source, "original");
      const identity = snapshotClaimIdentity(source);
      await link(source, alias);
      const claim = await claimPaths(home, [{ path: source, identity }]);
      expect(await readFile(claim.files.get(source)!, "utf8")).toBe("original");
      await mkdir(path.join(claim.directory, "work"), { mode: 0o700 });
      const work = path.join(claim.directory, "work", "source.db");
      await writeFile(work, "selected deletion", { mode: 0o600 });
      await claim.publish(new Map([[source, work]]));
      expect(await readFile(source, "utf8")).toBe("selected deletion");
      expect(await readFile(alias, "utf8")).toBe("original");
      expect((await lstat(source)).nlink).toBe(1);
      expect(await readFile(claim.files.get(source)!, "utf8")).toBe("original");
    } finally { await fixtureTrash(home, { recursive: true, force: true }); }
  });

  it("restores a mismatched leaf without discarding the replacement", async () => {
    const home = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-"));
    try {
      const source = path.join(home, "source");
      await writeFile(source, "replacement");
      const identity = snapshotClaimIdentity(source);
      identity.inode += 1;
      await expect(claimPaths(home, [{ path: source, identity }])).rejects.toThrow(/identity|changed/i);
      expect(await readFile(source, "utf8")).toBe("replacement");
    } finally { await fixtureTrash(home, { recursive: true, force: true }); }
  });

  it("never overwrites a new leaf during publish or rollback", async () => {
    const home = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-"));
    try {
      const source = path.join(home, "source");
      await writeFile(source, "original");
      const claim = await claimPaths(home, [{ path: source, identity: snapshotClaimIdentity(source) }]);
      await writeFile(source, "new concurrent object");
      await mkdir(path.join(claim.directory, "work"), { mode: 0o700 });
      const work = path.join(claim.directory, "work", "source");
      await writeFile(work, "edited", { mode: 0o600 });
      await expect(claim.publish(new Map([[source, work]]))).rejects.toThrow(/publish|exists/i);
      await expect(claim.rollback()).rejects.toThrow(/rollback|exists/i);
      expect(await readFile(source, "utf8")).toBe("new concurrent object");
      expect(await readFile(claim.files.get(source)!, "utf8")).toBe("original");
      await access(path.join(claim.directory, "claim.json"));
    } finally { await fixtureTrash(home, { recursive: true, force: true }); }
  });

  it("checks absent sidecars even when there is no replacement to publish", async () => {
    const home = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-"));
    try {
      const source = path.join(home, "source.db");
      const sidecar = `${source}-wal`;
      await writeFile(source, "original");
      const claim = await claimPaths(home, [{ path: source, identity: snapshotClaimIdentity(source) }, { path: sidecar }]);
      await writeFile(sidecar, "concurrent sidecar");
      await expect(claim.publish(new Map())).rejects.toThrow(/publish|appeared/i);
      expect(await readFile(sidecar, "utf8")).toBe("concurrent sidecar");
      expect(await readFile(claim.files.get(source)!, "utf8")).toBe("original");
    } finally { await fixtureTrash(home, { recursive: true, force: true }); }
  });

  it("guards the first missing optional parent without creating it", async () => {
    const home = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-"));
    try {
      const missing = path.join(home, "optional", "sqlite", "source.db");
      const claim = await claimPaths(home, [{ path: missing }]);
      expect(claim.files.size).toBe(0);
      await expect(access(path.join(home, "optional"))).rejects.toMatchObject({ code: "ENOENT" });
      await mkdir(path.join(home, "optional"));
      await expect(claim.publish(new Map())).rejects.toThrow(/appeared/i);
    } finally { await fixtureTrash(home, { recursive: true, force: true }); }
  });

  it("refuses staging below an unsafe writable home before moving a source", async () => {
    const home = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-"));
    try {
      const source = path.join(home, "source");
      await writeFile(source, "preserved");
      await chmod(home, 0o777);
      await expect(claimPaths(home, [{ path: source, identity: snapshotClaimIdentity(source) }])).rejects.toThrow(/writable|trusted/i);
      expect(await readFile(source, "utf8")).toBe("preserved");
    } finally { await chmod(home, 0o700); await fixtureTrash(home, { recursive: true, force: true }); }
  });

  it("links durable claim recovery before the Trash helper sees a verified private path", async () => {
    const home = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-"));
    try {
      const source = path.join(home, "source");
      await writeFile(source, "approved");
      const expected = new Map([[source, snapshotClaimIdentity(source)]]);
      await withOperation({ home, kind: "clean", target: ["codex"] }, async () => {
        await wrapOperationTrash((paths, identities) => moveToSystemTrash(paths, identities!, {
          run: async (_binary, files) => {
            expect(files[0]).toContain("/.ai-cli-cleaner/recovery/");
            expect(files[0]).toContain("/original/000-source");
            const [summary] = await listOperations(home);
            const inspected = await inspectOperation(summary!.id, home);
            expect(inspected.claims).toHaveLength(1);
            expect(inspected.claims[0]?.state).toBe("claimed");
            expect(inspected.operation.claims?.[0]?.paths).toEqual([source]);
            await rename(files[0]!, path.join(home, "trash-result"));
          }
        }))([source], expected);
      });
      const [summary] = await listOperations(home);
      expect((await inspectOperation(summary!.id, home)).claims[0]?.state).toBe("trashed");
      expect(await readFile(path.join(home, "trash-result"), "utf8")).toBe("approved");
    } finally { await fixtureTrash(home, { recursive: true, force: true }); }
  });

  it("carries the original approved identity across operation journal waits", async () => {
    const home = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-"));
    try {
      const source = path.join(home, "source");
      await writeFile(source, "approved");
      const expected = new Map([[source, snapshotClaimIdentity(source)]]);
      await rename(source, path.join(home, "approved-original"));
      await writeFile(source, "unapproved replacement");
      let invoked = false;
      await expect(withOperation({ home, kind: "clean", target: ["codex"] }, () =>
        wrapOperationTrash((paths, identities) => moveToSystemTrash(paths, identities!, {
          run: async () => { invoked = true; }
        }))([source], expected))).rejects.toThrow(/identity changed/);
      expect(invoked).toBe(false);
      expect(await readFile(source, "utf8")).toBe("unapproved replacement");
      expect(await readFile(path.join(home, "approved-original"), "utf8")).toBe("approved");
      const [summary] = await listOperations(home);
      expect((await inspectOperation(summary!.id, home)).claims[0]?.state).toBe("restored");
    } finally { await fixtureTrash(home, { recursive: true, force: true }); }
  });

  it.each(["directory", "symlink"])("rejects a replaced source ancestor during publish (%s)", async (kind) => {
    const home = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-"));
    try {
      const parent = path.join(home, "provider");
      const outside = path.join(home, "outside");
      await mkdir(parent); await mkdir(outside);
      const source = path.join(parent, "source");
      await writeFile(source, "original");
      const claim = await claimPaths(home, [{ path: source, identity: snapshotClaimIdentity(source) }]);
      await mkdir(path.join(claim.directory, "work"), { mode: 0o700 });
      const work = path.join(claim.directory, "work", "source");
      await writeFile(work, "changed", { mode: 0o600 });
      await rename(parent, `${parent}-original`);
      if (kind === "directory") await mkdir(parent);
      else await symlink(outside, parent);
      await writeFile(path.join(kind === "directory" ? parent : outside, "source"), "unapproved");
      await expect(claim.publish(new Map([[source, work]]))).rejects.toThrow(/parent directory/i);
      expect(await readFile(path.join(kind === "directory" ? parent : outside, "source"), "utf8")).toBe("unapproved");
      expect(await readFile(claim.files.get(source)!, "utf8")).toBe("original");
    } finally { await fixtureTrash(home, { recursive: true, force: true }); }
  });

  it("reports a held source as failed when Trash fails after the safe claim", async () => {
    const home = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-"));
    try {
      const source = path.join(home, "source");
      await writeFile(source, "preserved in holding");
      const identity = snapshotClaimIdentity(source);
      const entry = { providerId: "codex" as const, providerName: "Codex", pattern: source, path: source,
        exists: true, sizeBytes: identity.sizeBytes!, identity: { ...identity, kind: "file" as const,
          sizeBytes: identity.sizeBytes!, modifiedMs: identity.modifiedMs! } };
      const result = await withOperation({ home, kind: "clean", target: ["codex"] }, () => cleanEntries([entry], {
        trash: wrapOperationTrash((paths, expected) => moveToSystemTrash(paths, expected!, {
          run: async () => { throw new Error("synthetic helper failure"); }
        }))
      }));
      expect(result.deleted).toEqual([]);
      expect(result.failures).toHaveLength(1);
      const [summary] = await listOperations(home);
      const inspected = await inspectOperation(summary!.id, home);
      expect(inspected.operation.status).toBe("partial");
      const claim = inspected.claims[0]!;
      const target = claim.targets![0] as { slot: string };
      expect(await readFile(path.join(claim.directory, "original", target.slot), "utf8")).toBe("preserved in holding");
    } finally { await fixtureTrash(home, { recursive: true, force: true }); }
  });

  it("links temporary-copy cleanup inside a home operation without claiming it as a home source", async () => {
    const home = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-"));
    const temporary = await fixtureTemp(path.join(tmpdir(), "cleaner-claim-copy-"));
    let directory: string | undefined;
    try {
      const source = path.join(temporary, "copy");
      await writeFile(source, "private preflight copy");
      await withOperation({ home, kind: "clean", target: ["codex"] }, async () => {
        await moveToSystemTrash([source], new Map([[source, snapshotClaimIdentity(source)]]), {
          run: async (_binary, files) => { await rename(files[0]!, path.join(temporary, "trash-result")); }
        });
      });
      const [summary] = await listOperations(home);
      const inspected = await inspectOperation(summary!.id, home);
      directory = inspected.claims[0]!.directory;
      expect(inspected.operation.claims?.[0]?.home).toBe(await realpath(tmpdir()));
      expect(inspected.claims[0]?.state).toBe("trashed");
      expect(await readFile(path.join(temporary, "trash-result"), "utf8")).toBe("private preflight copy");
    } finally {
      if (directory) await rename(directory, path.join(temporary, "completed-claim"));
      await fixtureTrash(home, { recursive: true, force: true });
      await fixtureTrash(temporary, { recursive: true, force: true });
    }
  });
});
