import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateExactStoragePath } from "../src/conversations/owned-paths.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

async function storageFixture(): Promise<{ home: string; root: string }> {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-owned-paths-"));
  homes.push(home);
  const root = path.join(home, ".codex");
  await fs.mkdir(path.join(root, "sessions", "2026", "11"), { recursive: true });
  return { home, root };
}

const validate = (root: string, parts: string[], kind: "file" | "directory" | "either" = "directory") =>
  validateExactStoragePath(path.join(root, ...parts), root, parts, kind);

// 快速路徑只能接受完整檢查也會接受的路徑；其餘結果與拒絕原因必須維持不變。
describe("exact storage path validation", () => {
  it("returns the canonical path for a real nested directory under a linked temporary home", async () => {
    const { home, root } = await storageFixture();
    const canonicalHome = await fs.realpath(home);
    await expect(validate(root, ["sessions", "2026", "11"])).resolves.toEqual({
      status: "valid", path: path.join(canonicalHome, ".codex", "sessions", "2026", "11")
    });
  });

  it("refuses a symbolic link in an intermediate component, even when it is dangling", async () => {
    const { root } = await storageFixture();
    await fs.mkdir(path.join(root, "elsewhere", "11"), { recursive: true });
    await fs.symlink(path.join(root, "elsewhere"), path.join(root, "sessions", "linked"));
    await fs.symlink(path.join(root, "absent"), path.join(root, "sessions", "dangling"));
    await expect(validate(root, ["sessions", "linked", "11"])).resolves.toMatchObject({
      status: "invalid", reason: expect.stringContaining("Refusing a symbolic link data path")
    });
    await expect(validate(root, ["sessions", "dangling", "11"])).resolves.toMatchObject({
      status: "invalid", reason: expect.stringContaining("Refusing a symbolic link data path")
    });
  });

  it("refuses a linked storage root", async () => {
    const { home, root } = await storageFixture();
    const linked = path.join(home, ".linked-codex");
    await fs.symlink(root, linked);
    await expect(validate(linked, ["sessions"])).resolves.toMatchObject({
      status: "invalid", reason: expect.stringContaining("symbolic link or non-directory storage root")
    });
  });

  it("keeps the kind, intermediate-file, and missing outcomes", async () => {
    const { root } = await storageFixture();
    await fs.writeFile(path.join(root, "sessions", "file.jsonl"), "");
    await expect(validate(root, ["sessions", "file.jsonl"], "file")).resolves.toMatchObject({ status: "valid" });
    await expect(validate(root, ["sessions", "file.jsonl"])).resolves.toMatchObject({
      status: "invalid", reason: expect.stringContaining("must be a directory")
    });
    await expect(validate(root, ["sessions", "2026"], "file")).resolves.toMatchObject({
      status: "invalid", reason: expect.stringContaining("must be a regular file")
    });
    await expect(validate(root, ["sessions", "file.jsonl", "child"])).resolves.toMatchObject({
      status: "invalid", reason: expect.stringContaining("not a directory")
    });
    await expect(validate(root, ["sessions", "absent", "11"])).resolves.toEqual({ status: "missing" });
  });
});
