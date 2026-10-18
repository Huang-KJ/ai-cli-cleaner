import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  containsPath,
  expandHome,
  getCanonicalPath,
  getSQLiteBasePath,
  getPathSnapshot,
  getPathSize,
  pathExists,
  resolvePattern,
  SQLITE_SIDECAR_SUFFIXES
} from "../src/fs/paths.js";

const tempHomes: string[] = [];

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((dir) => fixtureTrash(dir, { recursive: true, force: true })));
});

describe("path helpers", () => {
  it("recognizes only the path itself and its descendants", () => {
    expect(containsPath("/tmp/home", "/tmp/home")).toBe(true);
    expect(containsPath("/tmp/home", "/tmp/home/child")).toBe(true);
    expect(containsPath("/tmp/home", "/tmp/home/..cache")).toBe(true);
    expect(containsPath("/tmp/home", "/tmp/home-other")).toBe(false);
    expect(containsPath("/tmp/home", "/tmp")).toBe(false);
  });

  it("expands tilde paths with the provided home", () => {
    expect(expandHome("~/.gemini/antigravity-cli/history.jsonl", "/tmp/home")).toBe(
      path.join("/tmp/home", ".gemini/antigravity-cli/history.jsonl")
    );
  });

  it("keeps environment-like names literal inside the home", () => {
    expect(expandHome("~/sessions/$HOME/${USER}.jsonl", "/tmp/home"))
      .toBe("/tmp/home/sessions/$HOME/${USER}.jsonl");
  });

  it("resolves wildcard patterns to matching files", async () => {
    const home = await makeTempHome();
    const dataDir = path.join(home, ".gemini", "antigravity-cli");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "conversation_summaries.db"), "a");
    await writeFile(path.join(dataDir, "conversation_summaries.db-wal"), "b");
    await writeFile(path.join(dataDir, "conversation_summaries.db.backup"), "backup");
    await writeFile(path.join(dataDir, "conversation_summaries.db-corrupt-20260729"), "corrupt");
    await writeFile(path.join(dataDir, "settings.json"), "settings");

    const paths = await resolvePattern("~/.gemini/antigravity-cli/conversation_summaries.db*", home);

    expect(paths.map((item) => path.basename(item))).toEqual([
      "conversation_summaries.db",
      "conversation_summaries.db-wal"
    ]);
  });

  it("does not treat SQLite backups as database sidecars", async () => {
    const home = await makeTempHome();
    const dataDir = path.join(home, ".gemini", "antigravity-cli");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "conversation_summaries.db.bak"), "backup");
    await writeFile(path.join(dataDir, "conversation_summaries.db-journal"), "journal");

    const paths = await resolvePattern("~/.gemini/antigravity-cli/conversation_summaries.db*", home);

    expect(paths.map((item) => path.basename(item))).toEqual(["conversation_summaries.db-journal"]);
  });

  it("recognizes only supported SQLite database and sidecar suffixes", () => {
    expect(SQLITE_SIDECAR_SUFFIXES).toEqual(["-wal", "-shm", "-journal"]);
    expect(getSQLiteBasePath("/tmp/state.sqlite")).toBe("/tmp/state.sqlite");
    expect(getSQLiteBasePath("/tmp/state.db-wal")).toBe("/tmp/state.db");
    expect(getSQLiteBasePath("/tmp/state.sqlite-journal")).toBe("/tmp/state.sqlite");
    expect(getSQLiteBasePath("/tmp/state.db.bak")).toBeUndefined();
    expect(getSQLiteBasePath("/tmp/state.db-corrupt-20261015")).toBeUndefined();
    expect(getSQLiteBasePath("/tmp/state.db*")).toBeUndefined();
  });

  it("falls back when a wildcard parent directory is missing", async () => {
    const home = await makeTempHome();

    await expect(resolvePattern("~/.missing/*.txt", home)).resolves.toEqual([
      path.join(home, ".missing", "*.txt")
    ]);
  });

  it("rejects relative paths and unsupported environment roots", async () => {
    await expect(resolvePattern("relative/session.jsonl")).rejects.toThrow(/non-absolute/);
    await expect(resolvePattern("$TMPDIR/antigravity")).rejects.toThrow(/non-absolute/);
  });

  it("returns false and zero size for missing paths", async () => {
    const missing = path.join(await makeTempHome(), "missing");

    await expect(pathExists(missing)).resolves.toBe(false);
    await expect(getPathSize(missing)).resolves.toBe(0);
  });

  it("returns no snapshot when the scanned root does not exist", async () => {
    const missing = path.join(await makeTempHome(), "missing");

    await expect(getPathSnapshot(missing)).resolves.toBeUndefined();
  });

  it("counts a disappearing child as zero for size and rejects a snapshot", async () => {
    const home = await makeTempHome();
    const directory = path.join(home, "sessions");
    const child = path.join(directory, "thread.jsonl");
    await mkdir(directory);
    await writeFile(child, "session");

    const originalOpendir = fs.opendir.bind(fs);
    const readdirSpy = vi.spyOn(fs, "opendir").mockImplementation((async (target: string) => {
      const opened = await originalOpendir(target);
      return {
        async *[Symbol.asyncIterator]() {
          for await (const entry of opened) {
            if (target === directory) await fixtureTrash(child);
            yield entry;
          }
        }
      };
    }) as typeof fs.opendir);

    try {
      await expect(getPathSize(directory)).resolves.toBe(0);
      await writeFile(child, "session");
      await expect(getPathSnapshot(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("does not follow symbolic links when measuring or snapshotting", async () => {
    const home = await makeTempHome();
    const target = path.join(home, "target");
    const linked = path.join(home, "linked");
    await mkdir(target);
    await writeFile(path.join(target, "large-file"), "x".repeat(256));
    await symlink(target, linked);
    const linkedStat = await fs.lstat(linked);

    await expect(getPathSize(target)).resolves.toBe(256);
    await expect(getPathSize(linked)).resolves.toBe(linkedStat.size);
    await expect(getPathSnapshot(linked)).resolves.toMatchObject({
      identity: { kind: "symlink" },
      sizeBytes: linkedStat.size
    });
  });

  it("treats a non-directory parent as a missing path", async () => {
    const home = await makeTempHome();
    const parent = path.join(home, "not-a-directory");
    const child = path.join(parent, "child");
    await writeFile(parent, "file");

    await expect(pathExists(child)).resolves.toBe(false);
    await expect(getPathSize(child)).resolves.toBe(0);
  });

  it("measures size and a stable fingerprint in a single snapshot", async () => {
    const home = await makeTempHome();
    await mkdir(path.join(home, "nested"));
    await writeFile(path.join(home, "one"), "12345");
    await writeFile(path.join(home, "nested", "two"), "123");
    const snapshot = await getPathSnapshot(home);
    expect(snapshot?.sizeBytes).toBe(8);
    expect(snapshot?.sizeBytes).toBe(await getPathSize(home));
    expect(snapshot?.identity.treeFingerprint).toBe((await getPathSnapshot(home))?.identity.treeFingerprint);
    await writeFile(path.join(home, "nested", "two"), "1234");
    expect((await getPathSnapshot(home))?.identity.treeFingerprint).not.toBe(snapshot?.identity.treeFingerprint);
  });

  it("keeps wide-directory fingerprints stable across enumeration order and detects late changes", async () => {
    const directory = await makeTempHome();
    await Promise.all(Array.from({ length: 150 }, (_, index) =>
      writeFile(path.join(directory, `${String(index).padStart(3, "0")}.jsonl`), "fixture\n")));
    const before = await getPathSnapshot(directory);
    expect(before?.sizeBytes).toBe(1200);
    await expect(getPathSize(directory, { concurrency: 3 })).resolves.toBe(1200);
    const original = fs.opendir.bind(fs);
    const spy = vi.spyOn(fs, "opendir").mockImplementation((async (target: string) => {
      const entries: import("node:fs").Dirent[] = [];
      for await (const entry of await original(target)) entries.push(entry);
      return { async *[Symbol.asyncIterator]() { yield* entries.reverse(); } };
    }) as typeof fs.opendir);
    try {
      expect((await getPathSnapshot(directory))?.identity.treeFingerprint)
        .toBe(before?.identity.treeFingerprint);
      await writeFile(path.join(directory, "149.jsonl"), "changed fixture\n");
      expect((await getPathSnapshot(directory))?.identity.treeFingerprint)
        .not.toBe(before?.identity.treeFingerprint);
    } finally { spy.mockRestore(); }
  });

  it("resolves missing descendants through a canonical parent", async () => {
    const home = await makeTempHome();
    const actual = path.join(home, "actual");
    const linked = path.join(home, "linked");
    await mkdir(actual);
    await symlink(actual, linked);

    const canonicalActual = await getCanonicalPath(actual);
    await expect(getCanonicalPath(path.join(linked, "missing.txt"))).resolves.toBe(
      path.join(canonicalActual, "missing.txt")
    );
  });

  it("rejects invalid path-size concurrency", async () => {
    await expect(getPathSize(await makeTempHome(), { concurrency: 0 })).rejects.toThrow(
      /positive integer/
    );
  });
});

async function makeTempHome(): Promise<string> {
  const dir = await fixtureTemp(path.join(tmpdir(), "ai-cli-cleaner-test-"));
  tempHomes.push(dir);
  return dir;
}
