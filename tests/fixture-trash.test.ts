import { promises as fs } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureTemp, fixtureTempSync, fixtureTrash, fixtureTrashSync } from "./helpers/fixture-trash.js";

const roots: string[] = [];
const makeRoot = async () => {
  const root = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-fixture-boundary-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  for (const root of roots.splice(0)) await fixtureTrash(root, { force: true, recursive: true });
});

describe("recoverable fixture cleanup", () => {
  it("preserves the contents and inode of a simulated deleted file", async () => {
    const root = await makeRoot();
    const file = path.join(root, "transcript.jsonl");
    await fs.writeFile(file, "private fixture");
    const before = await fs.stat(file);
    const moved = await fixtureTrash(file);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(moved!, "utf8")).toBe("private fixture");
    expect((await fs.stat(moved!)).ino).toBe(before.ino);
  });

  it("rejects unregistered directories, real home, and the temporary root", async () => {
    for (const target of [tmpdir(), homedir(), path.join(tmpdir(), "unregistered")]) {
      await expect(fixtureTrash(target, { force: true, recursive: true }))
        .rejects.toThrow("Refusing to move unregistered test fixture data.");
    }
  });

  it("moves a child symlink itself and refuses paths through an external symlink", async () => {
    const root = await makeRoot();
    const external = await makeRoot();
    const target = path.join(external, "retained.jsonl");
    await fs.writeFile(target, "retained");
    await fs.symlink(external, path.join(root, "alias"));
    await expect(fixtureTrash(path.join(root, "alias", "retained.jsonl")))
      .rejects.toThrow("Test path resolves through a symbolic link outside the registered temporary directory.");
    const moved = await fixtureTrash(path.join(root, "alias"));
    expect((await fs.lstat(moved!)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("retained");
  });

  it("refuses a registered root replaced by a symlink", async () => {
    const root = await makeRoot();
    const retained = `${root}-original`;
    await fs.rename(root, retained);
    await fs.symlink(homedir(), root);
    await expect(fixtureTrash(root, { recursive: true }))
      .rejects.toThrow("Test fixture root identity changed; refusing to move it.");
    // 復原 fixture 根目錄，讓正常清理保留全部內容。
    await fs.rename(root, path.join(retained, "replaced-link"));
    await fs.rename(retained, root);
  });

  it("ignores missing registered children only when force is enabled", async () => {
    const root = await makeRoot();
    const file = path.join(root, "missing.jsonl");
    await expect(fixtureTrash(file, { force: true })).resolves.toBeUndefined();
    await expect(fixtureTrash(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports synchronous callers without deleting bytes", async () => {
    const root = fixtureTempSync(path.join(tmpdir(), "ai-cleaner-fixture-sync-"));
    roots.push(root);
    const file = path.join(root, "archive.tgz");
    await fs.writeFile(file, "archive fixture");
    const moved = fixtureTrashSync(file);
    expect(await fs.readFile(moved!, "utf8")).toBe("archive fixture");
    expect(fixtureTrashSync(file, { force: true })).toBeUndefined();
  });
});
