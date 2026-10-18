import { lstatSync, promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import setup from "./helpers/global-setup.js";

const fixtureRoots: string[] = [];
const fixtureTrashVariable = "AI_CLEANER_FIXTURE_TRASH";

function projectFixture() {
  const provided = new Map<string, string>();
  const project = {
    provide: (key: string, value: string) => provided.set(key, value)
  } as unknown as TestProject;
  return { project, provided };
}

function globalFixtureSink(): string {
  const sink = process.env[fixtureTrashVariable];
  if (!sink) throw new Error("Vitest did not provide its fixture Trash directory.");
  return sink;
}

function exists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtureRoots.splice(0).map((root) => fixtureTrash(root, { force: true, recursive: true })));
});

describe("Vitest fixture sink lifecycle", () => {
  it("moves a self-created sink to native Trash after tests", async () => {
    const globalSink = globalFixtureSink();
    vi.stubEnv(fixtureTrashVariable, undefined);
    const fixture = projectFixture();
    let sink: string | undefined;
    try {
      const teardown = setup(fixture.project);
      if (!teardown) throw new Error("A self-created fixture sink must have a teardown.");
      sink = fixture.provided.get("fixtureTrash");
      if (!sink) throw new Error("Global setup did not provide its fixture sink.");
      expect(path.dirname(sink)).toBe(realpathSync(tmpdir()));
      await fs.writeFile(path.join(sink, "synthetic.txt"), "synthetic fixture");

      await teardown();

      await expect(fs.lstat(sink)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.stubEnv(fixtureTrashVariable, globalSink);
      if (sink && exists(sink)) {
        const cleanupRoot = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-lifecycle-cleanup-"));
        fixtureRoots.push(cleanupRoot);
        await fs.rename(sink, path.join(cleanupRoot, "self-created-sink"));
      }
    }
  }, 30_000);

  it("uses an external sink without taking ownership of its cleanup", async () => {
    const external = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-fixture-trash-external-"));
    fixtureRoots.push(external);
    vi.stubEnv(fixtureTrashVariable, external);
    const fixture = projectFixture();

    const teardown = setup(fixture.project);

    expect(fixture.provided.get("fixtureTrash")).toBe(realpathSync(external));
    expect(teardown).toBeUndefined();
    expect(exists(external)).toBe(true);
    await fs.writeFile(path.join(external, "caller-owned.txt"), "synthetic fixture");
    expect(await fs.readFile(path.join(external, "caller-owned.txt"), "utf8")).toBe("synthetic fixture");
  });

  it("refuses to trash a sink whose filesystem identity changed", async () => {
    const globalSink = globalFixtureSink();
    const cleanupRoot = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-lifecycle-identity-"));
    fixtureRoots.push(cleanupRoot);
    vi.stubEnv(fixtureTrashVariable, undefined);
    const fixture = projectFixture();
    let sink: string | undefined;
    const original = path.join(cleanupRoot, "original-sink");
    const replacement = path.join(cleanupRoot, "replacement-sink");
    try {
      const teardown = setup(fixture.project);
      if (!teardown) throw new Error("A self-created fixture sink must have a teardown.");
      sink = fixture.provided.get("fixtureTrash");
      if (!sink) throw new Error("Global setup did not provide its fixture sink.");
      await fs.rename(sink, original);
      await fs.mkdir(sink);

      await expect(teardown()).rejects.toThrow("Refusing to move a changed fixture Trash directory");
      expect(exists(sink)).toBe(true);
      expect(exists(original)).toBe(true);
    } finally {
      vi.stubEnv(fixtureTrashVariable, globalSink);
      if (sink && exists(sink) && !exists(replacement)) await fs.rename(sink, replacement);
    }
  });
});
