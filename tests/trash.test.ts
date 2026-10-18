import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { access, readFile, writeFile, readdir, cp, chmod, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { moveToSystemTrash, systemTrashBinary, runTrashBatches } from "../src/fs/trash.js";

describe("system Trash", () => {
  it("verifies the native artifact and its complete license without executing it", () => {
    const child = spawnSync(process.execPath, ["lib/native-helper.cjs"], { encoding: "utf8", timeout: 10_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ version: "3.0.0", binarySha256: "cc802989bab3f97ce608b5b88838302dda65f1481bb8775b3c342830677bde68" });
  });

  it.each(["missing", "tampered", "license", "permissions", "symlink"])("rejects an invalid isolated native artifact (%s)", async (kind) => {
    const directory = await fixtureTemp(path.join(tmpdir(), "cleaner-native-artifact-"));
    try {
      const root = new URL("../", import.meta.url);
      await cp(new URL("vendor", root), path.join(directory, "vendor"), { recursive: true });
      const binary = path.join(directory, "vendor", "macos-trash");
      if (kind === "missing") await fixtureTrash(binary);
      if (kind === "tampered") await writeFile(binary, "invalid native executable");
      if (kind === "license") await writeFile(path.join(directory, "vendor", "license"), "MIT");
      if (kind === "permissions") await chmod(binary, 0o600);
      if (kind === "symlink") {
        await fixtureTrash(binary);
        await symlink(new URL("vendor/macos-trash", root), binary);
      }
      const { verifyNativeArtifact } = createRequire(import.meta.url)("../lib/native-helper.cjs");
      expect(() => verifyNativeArtifact(directory)).toThrow(/Native Trash artifact verification failed/);
    } finally { await fixtureTrash(directory, { recursive: true, force: true }); }
  });

  it("resolves the pinned native helper without invoking the package fallback", async () => {
    expect(systemTrashBinary()).toMatch(/vendor\/macos-trash$/);
    await access(systemTrashBinary(), constants.X_OK);
    const run = vi.fn(async () => undefined);
    await runTrashBatches(systemTrashBinary(), ["/fixture/name with spaces", "/fixture/[literal]*"], run);
    expect(run).toHaveBeenCalledExactlyOnceWith(systemTrashBinary(), ["/fixture/name with spaces", "/fixture/[literal]*"]);
  });

  it("passes deeply nested braces literally without loading the vulnerable glob dependency chain", () => {
    // 獨立程序攔截真實模組載入，避免測試環境的 module cache 掩蓋相依套件執行。
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      const blocked = ["trash", "globby", "fast-glob", "micromatch", "braces"];
      const loads = [];
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (blocked.includes(specifier)) throw new Error("Forbidden glob package import: " + specifier);
          return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
          if (blocked.some((name) => url.includes("/node_modules/" + name + "/"))) {
            loads.push(url);
            throw new Error("Forbidden glob package load: " + url);
          }
          return nextLoad(url, context);
        }
      });
      const { systemTrashBinary, runTrashBatches } = await import(process.argv[1]);
      const literal = "/fixture/" + "{".repeat(8192) + "literal" + "}".repeat(8192) + "[name]*.jsonl";
      const binary = systemTrashBinary();
      assert(binary.endsWith("/vendor/macos-trash"));
      const calls = [];
      await runTrashBatches(binary, [literal], async (target, paths) => calls.push({ target, paths }));
      assert.deepEqual(calls, [{ target: binary, paths: [literal] }]);
      assert.deepEqual(loads, []);
      // 確認攔截器確實生效；套件 API 的意外 import 必須使前面的驗證失敗。
      await assert.rejects(import("trash"), /Forbidden glob package import/);
      assert.equal(loads.length, 0);
      console.log(JSON.stringify({ literalPassed: true, globApiBlocked: true }));
    `, new URL("../dist/fs/trash.js", import.meta.url).href], {
      encoding: "utf8", timeout: 10_000
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ literalPassed: true, globApiBlocked: true });
  });

  it("preserves fixture data and stops on permission failures without creating fallback directories", async () => {
    const directory = await fixtureTemp(path.join(tmpdir(), "cleaner-trash-test-"));
    try {
      const file = path.join(directory, "private.jsonl");
      await writeFile(file, "private fixture");
      const run = vi.fn(async () => { throw new Error("couldn’t be moved to the trash because you don’t have permission"); });
      await expect(runTrashBatches(systemTrashBinary(), [file], run)).rejects.toThrow(/no fallback \.Trash directory was used/);
      expect(run).toHaveBeenCalledOnce();
      expect(await readFile(file, "utf8")).toBe("private fixture");
      expect(await readdir(directory)).toEqual(["private.jsonl"]);
    } finally {
      await fixtureTrash(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid paths and unsupported platforms before execution", async () => {
    const run = vi.fn(async () => undefined);
    await expect(moveToSystemTrash(["relative"], { run })).rejects.toThrow(/Trash operations require absolute paths/);
    await expect(moveToSystemTrash(["/"], { run })).rejects.toThrow(/Trash operations require absolute paths/);
    await expect(moveToSystemTrash(["/fixture"], { run, platform: "linux" })).rejects.toThrow(/macOS/);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops after a failed chunk so callers can report partial completion", async () => {
    const paths = Array.from({ length: 130 }, (_, index) => `/fixture/${index}`);
    const run = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("failed"));
    await expect(runTrashBatches(systemTrashBinary(), paths, run)).rejects.toThrow(/may have moved some items/);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[1]).toHaveLength(64);
  });

  it("requires approved identities even when a runner is injected", async () => {
    const run = vi.fn(async () => undefined);
    await expect(moveToSystemTrash(["/fixture"], { run })).rejects.toThrow(/approved filesystem identity/);
    expect(run).not.toHaveBeenCalled();
  });
});
