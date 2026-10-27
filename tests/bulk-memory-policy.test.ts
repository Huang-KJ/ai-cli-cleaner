import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getManifests, manifests } from "../src/cleaners/manifests.js";
import { prepareClean } from "../src/cleaners/plan.js";
import { scanManifests } from "../src/fs/scan.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
const closed = async () => ({ supported: true, openPaths: [] });
afterEach(async () => {
  for (const home of homes.splice(0)) await fixtureTrash(home, { force: true, recursive: true });
});

async function makeHome(): Promise<string> {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-memory-policy-"));
  homes.push(home);
  return home;
}

async function put(home: string, relative: string, text = "retained synthetic memory"): Promise<string> {
  const file = path.join(home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  return file;
}

describe("bulk memory opt-in policy", () => {
  it("preserves every known memory store and SQLite sidecar when all providers are selected", async () => {
    const home = await makeHome();
    const memories: string[] = [];
    for (const database of ["memories_1.sqlite", "memories_v2_1.sqlite"]) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        memories.push(await put(home, `.codex/${database}${suffix}`));
      }
    }
    memories.push(await put(home, ".codex/memories/MEMORY.md"));
    memories.push(await put(home, ".grok/memory/default.md"));
    memories.push(await put(home, ".claude/agent-memory/reviewer/MEMORY.md"));
    memories.push(await put(home, ".claude/projects/-fixture/memory/MEMORY.md"));
    const grok = await put(home, ".grok/sessions/session.json");
    const claude = await put(home, ".claude/projects/-fixture/session.jsonl");
    const before = new Map(await Promise.all(memories.map(async (file) => [file, {
      bytes: await fs.readFile(file), inode: (await fs.lstat(file)).ino
    }] as const)));
    const plan = await prepareClean(manifests.map((manifest) => manifest.id), {
      home, checkOpenPaths: closed,
      trash: async (files) => { for (const file of files) await fixtureTrash(file); }
    });
    expect(plan.entries.map((entry) => entry.path).sort()).toEqual([path.dirname(grok), claude].sort());
    expect((await plan.execute()).failures).toEqual([]);
    for (const [file, original] of before) {
      expect(await fs.readFile(file)).toEqual(original.bytes);
      expect((await fs.lstat(file)).ino).toBe(original.inode);
    }
    expect((await fs.lstat(path.dirname(claude))).isDirectory()).toBe(true);
  });

  it("includes both memory database generations and all supported sidecars only when opted in", async () => {
    const home = await makeHome();
    const paths: string[] = [];
    for (const database of ["memories_1.sqlite", "memories_v2_1.sqlite"]) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) paths.push(await put(home, `.codex/${database}${suffix}`));
    }
    const retained = await scanManifests(getManifests(["codex"]), { home });
    expect(retained.filter((entry) => entry.exists)).toEqual([]);
    const included = await scanManifests(getManifests(["codex"], { includeMemories: true }), { home });
    expect(included.filter((entry) => entry.exists).map((entry) => entry.path).sort()).toEqual(paths.sort());
    expect(included.filter((entry) => entry.exists).every((entry) => entry.sqliteGroup?.members.length === 4)).toBe(true);
  });

  it("moves Grok and Claude memory only with includeMemories", async () => {
    const home = await makeHome();
    const grok = await put(home, ".grok/memory/default.md");
    const claude = await put(home, ".claude/projects/-fixture/memory/MEMORY.md");
    const agent = await put(home, ".claude/agent-memory/reviewer/MEMORY.md");
    const plan = await prepareClean(["grok", "claude"], {
      home, includeMemories: true, checkOpenPaths: closed,
      trash: async (files) => { for (const file of files) await fixtureTrash(file); }
    });
    expect(plan.entries.map((entry) => entry.path).sort()).toEqual([
      path.dirname(grok), path.join(home, ".claude/projects"), path.join(home, ".claude/agent-memory")
    ].sort());
    expect((await plan.execute()).failures).toEqual([]);
    for (const file of [grok, claude, agent]) await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
