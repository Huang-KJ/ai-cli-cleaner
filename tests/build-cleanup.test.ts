import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const { cleanBuild } = await import(new URL("../scripts/clean-build.mjs", import.meta.url).href);
const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-build-fixture-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fixtureTrash(root, { force: true, recursive: true });
});

describe("recoverable build cleanup", () => {
  it("uses the native helper with the literal directory and preserves its bytes on failure", async () => {
    const root = await fixture();
    const directory = path.join(root, "dist [literal]*");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "index.js"), "previous build");
    const calls: Array<[string, string[]]> = [];
    await expect(cleanBuild(directory, { run: async (binary: string, paths: string[]) => {
      calls.push([binary, paths]);
      throw new Error("helper failure");
    } })).rejects.toThrow("helper failure");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatch(/vendor\/macos-trash$/);
    expect(calls[0]![1]).toEqual([directory]);
    expect(await fs.readFile(path.join(directory, "index.js"), "utf8")).toBe("previous build");
  });

  it("rejects a dist symlink while retaining its target", async () => {
    const root = await fixture();
    const target = path.join(root, "retained");
    const alias = path.join(root, "dist");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "index.js"), "retained");
    await fs.symlink(target, alias);
    await expect(cleanBuild(alias)).rejects.toThrow(/symlinks are not allowed/);
    expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("retained");
  });

  it("does nothing when dist does not exist", async () => {
    const root = await fixture();
    await expect(cleanBuild(path.join(root, "missing"))).resolves.toBeUndefined();
  });
});
