import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanEntries, type TrashFn } from "../src/cleaners/clean.js";
import { getManifests } from "../src/cleaners/manifests.js";
import type { CleanerManifest } from "../src/cleaners/types.js";
import { scanManifests } from "../src/fs/scan.js";

const tempHomes: string[] = [];

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((directory) =>
    fixtureTrash(directory, { recursive: true, force: true })
  ));
});

describe("Antigravity scan and clean", () => {
  it("finds IDE and CLI data without including preserved runtime files", async () => {
    const home = await makeHome();
    for (const product of ["antigravity-cli", "antigravity-ide"]) {
      const root = path.join(home, ".gemini", product);
      await mkdir(path.join(root, "brain", "conversation"), { recursive: true });
      await mkdir(path.join(root, "bin"), { recursive: true });
      await writeFile(path.join(root, "brain", "conversation", "artifact.md"), product);
      await writeFile(path.join(root, "bin", "runtime"), "keep");
    }
    const summary = await scanManifests(getManifests(["antigravity"]), { home });
    expect(summary.filter((entry) => entry.exists).map((entry) => entry.path))
      .toEqual(expect.arrayContaining([
        path.join(home, ".gemini", "antigravity-cli", "brain"),
        path.join(home, ".gemini", "antigravity-ide", "brain")
      ]));
    expect(summary.some((entry) => entry.path.endsWith(path.join("bin", "runtime"))))
      .toBe(false);
  });

  it("cleans the legacy CLI root's conversation data and keeps its identity, runtime, and logs", async () => {
    const home = await makeHome();
    const root = path.join(home, ".gemini", "antigravity");
    const removed = ["conversation_summaries.db", "conversation_summaries.db-wal", "agyhub_summaries_proto.pb", "brain", "conversations"]
      .map((name) => path.join(root, name));
    await mkdir(path.join(root, "brain", "conversation"), { recursive: true });
    await mkdir(path.join(root, "conversations"), { recursive: true });
    await writeFile(path.join(root, "brain", "conversation", "artifact.md"), "conversation");
    await writeFile(path.join(root, "conversations", "chat.pb"), "conversation");
    for (const name of ["conversation_summaries.db", "conversation_summaries.db-wal", "agyhub_summaries_proto.pb"]) {
      await writeFile(path.join(root, name), "summary");
    }
    const kept = new Map([
      ["installation_id", "id"], ["antigravity_state.pbtxt", "state"], [path.join("knowledge", "knowledge.lock"), ""],
      [path.join("bin", "agy"), "runtime"], [path.join("log", "cli-20261021.log"), "log"], [path.join("crashes", "report"), "crash"]
    ].map(([name, contents]) => [path.join(root, name), contents]));
    for (const [file, contents] of kept) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    // CLI 以符號連結指向目前的日誌；清理不得跟隨或因此中止。
    await symlink(path.join("log", "cli-20261021.log"), path.join(root, "cli.log"));

    const summary = await scanManifests(getManifests(["antigravity"]), { home });
    expect(summary.filter((entry) => entry.error)).toEqual([]);
    const legacy = summary.filter((entry) => entry.exists && entry.path.startsWith(`${root}${path.sep}`));
    expect(legacy.map((entry) => entry.path).sort()).toEqual([...removed].sort());

    const trashed = path.join(home, "trashed");
    await mkdir(trashed);
    const trash = vi.fn<TrashFn>(async (paths) => {
      for (const file of paths) await rename(file, path.join(trashed, path.basename(file)));
    });
    const result = await cleanEntries(legacy, { trash, checkOpenPaths: async () => ({ supported: true, openPaths: [] }) });
    expect(result.failures).toEqual([]);
    expect(result.deleted.map((entry) => entry.path).sort()).toEqual([...removed].sort());
    for (const [file, contents] of kept) expect(await readFile(file, "utf8")).toBe(contents);
    expect(await readFile(path.join(root, "cli.log"), "utf8")).toBe("log");
  });

  it("cleans conversation data while preserving unrelated logs and cache", async () => {
    const home = await makeHome();
    const root = path.join(home, ".gemini", "antigravity-cli");
    const brain = path.join(root, "brain");
    const log = path.join(root, "log", "active.log");
    const cache = path.join(home, "Library", "Caches", "com.google.antigravity", "cache");
    await mkdir(brain, { recursive: true });
    await mkdir(path.dirname(log), { recursive: true });
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(path.join(brain, "artifact.md"), "conversation");
    await writeFile(log, "keep log");
    await writeFile(cache, "keep cache");
    const summary = await scanManifests(getManifests(["antigravity"]), { home });
    const trash = vi.fn<TrashFn>(async (paths) => {
      for (const file of paths) await rename(file, path.join(home, "trashed-brain"));
    });
    const result = await cleanEntries(summary, {
      trash, checkOpenPaths: async () => ({ supported: true, openPaths: [] })
    });
    expect(result.failures).toEqual([]);
    expect(result.deleted.map((entry) => entry.path)).toEqual([brain]);
    const identity = summary.find((entry) => entry.path === brain)!.identity;
    expect(identity).toBeDefined();
    expect(trash).toHaveBeenCalledExactlyOnceWith([brain], new Map([[brain, identity]]));
    expect(trash.mock.calls[0]?.[1]?.get(brain)).toBe(identity);
    expect(await readFile(log, "utf8")).toBe("keep log");
    expect(await readFile(cache, "utf8")).toBe("keep cache");
    expect(await readFile(path.join(home, "trashed-brain", "artifact.md"), "utf8")).toBe("conversation");
  });

  it("rejects a broad delete path that contains preserved settings", async () => {
    const home = await makeHome();
    await mkdir(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(path.join(home, ".gemini", "antigravity-cli", "settings.json"), "{}");
    const manifest: CleanerManifest = {
      id: "antigravity",
      name: "Google Antigravity",
      deletePatterns: ["~/.gemini/antigravity-cli"],
      preservedPaths: ["~/.gemini/antigravity-cli/settings.json"]
    };
    const summary = await scanManifests([manifest], { home });
    expect(summary[0]?.error?.message).toMatch(/contains preserved data/);
  });

  it("rejects paths outside the home directory", async () => {
    const home = await makeHome();
    const manifest: CleanerManifest = {
      id: "antigravity",
      name: "Google Antigravity",
      deletePatterns: ["/opt/antigravity-cleaner-outside-root"],
      preservedPaths: []
    };
    const summary = await scanManifests([manifest], { home });
    expect(summary[0]?.error?.message).toMatch(/outside allowed roots/);
  });

  it("rejects a cleanup path whose parent symlink escapes the home directory", async () => {
    const home = await makeHome();
    const outside = await makeHome();
    await mkdir(path.join(home, ".gemini"), { recursive: true });
    await mkdir(path.join(outside, "brain"), { recursive: true });
    await symlink(outside, path.join(home, ".gemini", "antigravity-cli"));
    const manifest: CleanerManifest = {
      id: "antigravity",
      name: "Google Antigravity",
      deletePatterns: ["~/.gemini/antigravity-cli/brain"],
      preservedPaths: []
    };
    const summary = await scanManifests([manifest], { home });
    expect(summary[0]?.error?.message).toMatch(/outside allowed roots/);
  });
});

async function makeHome(): Promise<string> {
  const home = await fixtureTemp(path.join(tmpdir(), "antigravity-cleaner-"));
  tempHomes.push(home);
  return home;
}
