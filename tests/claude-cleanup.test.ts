import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getManifests } from "../src/cleaners/manifests.js";
import { prepareClean } from "../src/cleaners/plan.js";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { scanManifests } from "../src/fs/scan.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
const session = "10000000-0000-4000-8000-000000000001";
const closed = async () => ({ supported: true, openPaths: [] });

afterEach(async () => {
  for (const home of homes.splice(0)) await fixtureTrash(home, { recursive: true, force: true });
});

async function makeHome(): Promise<string> {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-claude-"));
  homes.push(home);
  return home;
}

async function put(home: string, relative: string, content = "synthetic fixture"): Promise<string> {
  const file = path.join(home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

describe("Claude Code cleanup", () => {
  it("moves known history, auto memory, and artifacts while preserving configuration and source files", async () => {
    const home = await makeHome();
    const manifest = getManifests(["claude"], { includeMemories: true })[0]!;
    const targets: string[] = [];
    for (const pattern of manifest.deletePatterns) {
      const relative = pattern.slice(2);
      const leaf = /\.(?:json|jsonl)$/.test(relative) ? relative : `${relative}/fixture.txt`;
      targets.push(await put(home, leaf));
    }
    const transcript = await put(home, `.claude/projects/-fixture/${session}.jsonl`);
    const memory = await put(home, ".claude/projects/-fixture/memory/MEMORY.md");
    const agentMemory = await put(home, ".claude/agent-memory/example/MEMORY.md");
    const subagent = await put(home, `.claude/projects/-fixture/${session}/subagents/agent-a.jsonl`);
    const preserved = await Promise.all([
      put(home, ".claude.json", '{"account":"fixture","mcpServers":{}}'),
      put(home, ".claude/.credentials.json"),
      put(home, ".claude/settings.json"),
      put(home, ".claude/CLAUDE.md"),
      put(home, ".claude/skills/example/SKILL.md"),
      put(home, ".claude/plugins/installed_plugins.json"),
      put(home, ".claude/agents/example.md"),
      put(home, ".claude/jobs/state.json"),
      put(home, ".claude/backups/claude.json.backup"),
      put(home, "work/project/src/main.ts")
    ]);
    const moved: string[] = [];
    const plan = await prepareClean(["claude"], {
      home, includeMemories: true, checkOpenPaths: closed,
      trash: async (files) => {
        for (const file of files) { await fixtureTrash(file); moved.push(file); }
      }
    });
    expect(plan.entries.every((entry) => entry.providerId === "claude")).toBe(true);
    const result = await plan.execute();
    expect(result.failures).toEqual([]);
    expect(moved).toHaveLength(manifest.deletePatterns.length);
    for (const file of [...targets, transcript, memory, agentMemory, subagent]) {
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const file of preserved) expect((await fs.lstat(file)).isFile()).toBe(true);
  });

  it("preserves project and agent memory by default while moving sibling transcripts and artifacts", async () => {
    const home = await makeHome();
    const transcript = await put(home, `.claude/projects/-fixture/${session}.jsonl`);
    const artifact = await put(home, `.claude/projects/-fixture/${session}/subagents/agent-a.jsonl`);
    const memory = await put(home, ".claude/projects/-fixture/memory/MEMORY.md", "retained project knowledge");
    const agentMemory = await put(home, ".claude/agent-memory/example/MEMORY.md", "retained agent knowledge");
    const projects = path.join(home, ".claude/projects");
    const project = path.dirname(path.dirname(memory));
    const projectInfo = await fs.lstat(project);
    const memoryInfo = await fs.lstat(memory);
    const moved: string[] = [];
    const plan = await prepareClean(["claude"], {
      home, checkOpenPaths: closed, trash: async (files) => {
        for (const file of files) { await fixtureTrash(file); moved.push(file); }
      }
    });
    expect(plan.entries.map((entry) => entry.path).sort()).toEqual([
      transcript, path.dirname(path.dirname(artifact))
    ].sort());
    expect((await plan.execute()).failures).toEqual([]);
    expect(await fs.readFile(memory, "utf8")).toBe("retained project knowledge");
    expect(await fs.readFile(agentMemory, "utf8")).toBe("retained agent knowledge");
    expect((await fs.lstat(project)).ino).toBe(projectInfo.ino);
    expect((await fs.lstat(memory)).ino).toBe(memoryInfo.ino);
    expect((await fs.lstat(projects)).isDirectory()).toBe(true);
    expect(moved).not.toContain(project);
    expect(moved).not.toContain(projects);
    expect((await prepareClean(["claude"], { home, trash: vi.fn(), checkOpenPaths: closed })).entries).toEqual([]);
  });

  it("refuses memory added after preview and retains every file", async () => {
    const home = await makeHome();
    const transcript = await put(home, `.claude/projects/-fixture/${session}.jsonl`);
    const trash = vi.fn();
    const plan = await prepareClean(["claude"], { home, trash, checkOpenPaths: closed });
    const memory = await put(home, ".claude/projects/-fixture/memory/MEMORY.md", "new memory");
    await expect(plan.execute()).rejects.toThrow(/Preserved memory path or its container changed/);
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(memory, "utf8")).toBe("new memory");
    expect((await fs.lstat(transcript)).isFile()).toBe(true);
  });

  it("rechecks preserved memory immediately before each movement", async () => {
    const home = await makeHome();
    const transcript = await put(home, `.claude/projects/-fixture/${session}.jsonl`);
    const trash = vi.fn();
    let armed = false;
    let checks = 0;
    const plan = await prepareClean(["claude"], {
      home, trash, checkOpenPaths: async () => {
        if (armed && ++checks === 2) await put(home, ".claude/projects/-fixture/memory/MEMORY.md", "racing memory");
        return closed();
      }
    });
    armed = true;
    const result = await plan.execute();
    expect(result.failures[0]?.message).toMatch(/Preserved memory path or its container changed/);
    expect(trash).not.toHaveBeenCalled();
    expect((await fs.lstat(transcript)).isFile()).toBe(true);
    expect(await fs.readFile(path.join(home, ".claude/projects/-fixture/memory/MEMORY.md"), "utf8")).toBe("racing memory");
  });

  it.each(["memory", "project", "root"])("refuses a replaced %s container despite unchanged transcript identity", async (kind) => {
    const home = await makeHome();
    const transcript = await put(home, `.claude/projects/-fixture/${session}.jsonl`);
    await put(home, ".claude/projects/-fixture/memory/MEMORY.md");
    const trash = vi.fn();
    const plan = await prepareClean(["claude"], { home, trash, checkOpenPaths: closed });
    const project = path.dirname(transcript);
    const replaced = kind === "memory" ? path.join(project, "memory") : kind === "project" ? project : path.dirname(project);
    const retired = path.join(home, "retained-original");
    await fs.rename(replaced, retired);
    await fs.mkdir(replaced);
    if (kind === "project") await fs.rename(path.join(retired, path.basename(transcript)), transcript);
    if (kind === "root") {
      await fs.mkdir(project);
      await fs.rename(path.join(retired, path.basename(project), path.basename(transcript)), transcript);
    }
    await expect(plan.execute()).rejects.toThrow(/Preserved memory path or its container changed/);
    expect(trash).not.toHaveBeenCalled();
    expect((await fs.lstat(transcript)).isFile()).toBe(true);
  });

  it("refuses symbolic links at preserved memory paths", async () => {
    const home = await makeHome();
    const outside = await makeHome();
    await put(home, `.claude/projects/-fixture/${session}.jsonl`);
    const memory = await put(outside, "memory/MEMORY.md", "external memory");
    await fs.symlink(path.dirname(memory), path.join(home, ".claude/projects/-fixture/memory"));
    await expect(prepareClean(["claude"], { home, trash: vi.fn(), checkOpenPaths: closed }))
      .rejects.toThrow(/Preserved memory is not a physical directory/);
    expect(await fs.readFile(memory, "utf8")).toBe("external memory");
  });

  it("lists known transcripts without reading their internal format and refuses individual deletion", async () => {
    const home = await makeHome();
    const file = await put(home, `.claude/projects/-fixture/${session}.jsonl`, "not parsed as JSON");
    await put(home, ".grok/sessions/other.jsonl");
    const discovery = await discoverConversations(["claude"], { home });
    expect(discovery.conversations).toHaveLength(1);
    expect(discovery.conversations[0]).toMatchObject({
      providerId: "claude", id: session, title: session, dataPaths: [file],
      disabledReason: expect.stringContaining("clean --target claude")
    });
    const trash = vi.fn();
    const checkOpenPaths = vi.fn(closed);
    // 即使呼叫者移除 UI 的停用標記，底層也必須拒絕。
    const result = await deleteConversations([{ ...discovery.conversations[0]!, disabledReason: undefined }], {
      home, trash, checkOpenPaths
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]?.error.message).toMatch(/clean --target claude/);
    expect(trash).not.toHaveBeenCalled();
    expect(checkOpenPaths).not.toHaveBeenCalled();
    expect(await fs.readFile(file, "utf8")).toBe("not parsed as JSON");
  });

  it("returns no unrelated provider conversations when Claude has no data", async () => {
    const home = await makeHome();
    await put(home, ".grok/sessions/other.jsonl");
    expect(await discoverConversations(["claude"], { home })).toEqual({ conversations: [], warnings: [] });
  });

  it("rejects redirected storage during discovery and bulk planning", async () => {
    const home = await makeHome();
    const outside = await makeHome();
    const retained = await put(outside, `projects/-fixture/${session}.jsonl`);
    await fs.symlink(outside, path.join(home, ".claude"));
    const discovery = await discoverConversations(["claude"], { home });
    expect(discovery.conversations).toEqual([]);
    expect(discovery.warnings.join(" ")).toMatch(/redirected/);
    const scanned = await scanManifests(getManifests(["claude"]), { home });
    expect(scanned.some((entry) => entry.error)).toBe(true);
    await expect(prepareClean(["claude"], { home, trash: vi.fn(), checkOpenPaths: closed }))
      .rejects.toThrow(/outside|redirected/);
    expect(await fs.readFile(retained, "utf8")).toBe("synthetic fixture");
  });

  it("rejects open records and changes made after the preview", async () => {
    const home = await makeHome();
    const history = await put(home, ".claude/history.jsonl");
    const trash = vi.fn();
    await expect(prepareClean(["claude"], {
      home, trash, checkOpenPaths: async () => ({ supported: true, openPaths: [history] })
    })).rejects.toThrow(/Open files/);
    const plan = await prepareClean(["claude"], { home, trash, checkOpenPaths: closed });
    await fs.writeFile(history, "changed fixture");
    await expect(plan.execute()).rejects.toThrow(/Path changed/);
    expect(trash).not.toHaveBeenCalled();
  });
});
