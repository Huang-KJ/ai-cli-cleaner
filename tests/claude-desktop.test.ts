import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClean } from "../src/cleaners/plan.js";
import { inspectOperation, listOperations, withOperation, wrapOperationTrash } from "../src/recovery/operations.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
const accountId = "20000000-0000-4000-8000-000000000001";
const orgId = "30000000-0000-4000-8000-000000000001";
const desktopId = "40000000-0000-4000-8000-000000000001";
const transcriptId = "50000000-0000-4000-8000-000000000001";
const anotherId = "60000000-0000-4000-8000-000000000001";
const closed = async () => ({ supported: true, openPaths: [] });

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) await fixtureTrash(home, { recursive: true, force: true });
});

async function makeHome(): Promise<string> {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-claude-desktop-"));
  homes.push(home);
  return home;
}

function desktopPath(home: string, id = desktopId, store = "Claude"): string {
  return path.join(home, "Library", "Application Support", store, "claude-code-sessions",
    accountId, orgId, `local_${id}.json`);
}

async function put(home: string, relative: string, content = "synthetic fixture"): Promise<string> {
  const file = path.join(home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

async function putRecord(
  home: string,
  options: { id?: string; cliId?: string; store?: string; fields?: Record<string, unknown> } = {}
): Promise<string> {
  const id = options.id ?? desktopId;
  const cliId = options.cliId ?? transcriptId;
  const file = desktopPath(home, id, options.store);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    sessionId: `local_${id}`,
    createdAt: 1_790_000_000_000,
    lastActivityAt: 1_790_000_001_000,
    cliSessionId: cliId,
    cwd: path.join(home, "project"),
    originCwd: path.join(home, "project"),
    title: "Synthetic Claude Code session",
    ...options.fields
  }));
  return file;
}

async function putTranscript(home: string, id = transcriptId): Promise<string> {
  return put(home, `.claude/projects/-fixture/${id}.jsonl`, '{"type":"user","synthetic":true}\n');
}

describe("Claude Desktop Code sidebar cleanup", () => {
  it("previews without moving files, then trashes the transcript before its Desktop index", async () => {
    const home = await makeHome();
    const transcript = await putTranscript(home);
    const index = await putRecord(home, { fields: { worktreePath: path.join(home, "worktrees", "project") } });
    const memory = await put(home, ".claude/projects/-fixture/memory/MEMORY.md", "synthetic memory");
    const config = await put(home, ".claude/settings.json", '{"synthetic":true}');
    const worktreeSource = await put(home, "worktrees/project/src/main.ts", "synthetic source");
    const archivedIndex = await put(home,
      `Library/Application Support/Claude/claude-code-sessions/${accountId}/${orgId}/archived-sessions.idx`,
      "synthetic archived-session index\n");
    const deletedMarker = await put(home,
      `Library/Application Support/Claude/claude-code-sessions/${accountId}/${orgId}/deleted_${transcriptId}`,
      "synthetic deleted marker\n");
    const archivedBytes = await fs.readFile(archivedIndex);
    const markerBytes = await fs.readFile(deletedMarker);
    const trash = vi.fn(async (files: string[]) => {
      for (const file of files) await fixtureTrash(file);
    });

    const plan = await prepareClean(["claude"], { home, trash, checkOpenPaths: closed });
    expect(plan.entries.map((entry) => entry.path)).toContain(index);
    expect(plan.entries.map((entry) => entry.path)).toContain(transcript);
    expect(trash).not.toHaveBeenCalled();
    expect((await fs.lstat(index)).isFile()).toBe(true);
    expect((await fs.lstat(transcript)).isFile()).toBe(true);

    const result = await plan.execute();
    expect(result.failures).toEqual([]);
    expect(trash.mock.calls.flatMap(([files]) => files)).toEqual([transcript, index]);
    for (const file of [transcript, index]) await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(memory, "utf8")).toBe("synthetic memory");
    expect(await fs.readFile(config, "utf8")).toBe('{"synthetic":true}');
    expect(await fs.readFile(worktreeSource, "utf8")).toBe("synthetic source");
    expect(await fs.readFile(archivedIndex)).toEqual(archivedBytes);
    expect(await fs.readFile(deletedMarker)).toEqual(markerBytes);
  });

  it("cleans an eligible metadata-only ghost and supports the Claude-3p store layout", async () => {
    const home = await makeHome();
    const ghost = await putRecord(home, { cliId: anotherId });
    const thirdParty = await putRecord(home, { id: anotherId, cliId: transcriptId, store: "Claude-3p" });
    const trash = vi.fn(async (files: string[]) => {
      for (const file of files) await fixtureTrash(file);
    });

    const plan = await prepareClean(["claude"], { home, trash, checkOpenPaths: closed });
    expect(plan.entries.map((entry) => entry.path).sort()).toEqual([ghost, thirdParty].sort());
    expect(await plan.execute()).toMatchObject({ failures: [] });
    expect(trash.mock.calls.flatMap(([files]) => files).sort()).toEqual([ghost, thirdParty].sort());
  });

  it("retains remote and custom-config records while allowing local bridge mirrors", async () => {
    const home = await makeHome();
    const remoteFields = [
      { remoteTarget: "synthetic-remote" },
      { sshConfig: { host: "synthetic-host" } },
      { wslConfig: { distribution: "synthetic-distro" } },
      { backend: { kind: "ssh" } },
      { stagedTranscriptPath: path.join(home, "imported.jsonl") },
      { configDir: path.join(home, "custom-config") },
      { sessionType: "cowork" },
      { sessionType: "chat" },
      { sessionType: "future-kind" }
    ];
    const retained: string[] = [];
    for (let index = 0; index < remoteFields.length; index += 1) {
      const transcriptIdForRecord = `7000000${index}-0000-4000-8000-000000000001`;
      await putTranscript(home, transcriptIdForRecord);
      retained.push(await putRecord(home, { id: `7100000${index}-0000-4000-8000-000000000001`,
        cliId: transcriptIdForRecord, fields: remoteFields[index] }));
    }
    const mirroredTranscript = "80000000-0000-4000-8000-000000000001";
    await putTranscript(home, mirroredTranscript);
    const mirror = await putRecord(home, { id: "81000000-0000-4000-8000-000000000001", cliId: mirroredTranscript,
      fields: {
        bridgeSessionId: "synthetic-bridge",
        remoteSessionId: "synthetic-remote-id",
        gitAnchorsFolderRealpath: path.join(home, "synthetic-git-anchor"),
        remoteMcpServersConfig: [],
        remoteControlAutoEligible: true,
        remoteControlUserEnabled: false,
        steeredByRemoteClient: false
      } });
    const cowork = await put(home,
      "Library/Application Support/Claude/claude-ai-chat/synthetic-cowork.json", '{"synthetic":true}');
    const trash = vi.fn(async (files: string[]) => {
      for (const file of files) await fixtureTrash(file);
    });

    const plan = await prepareClean(["claude"], { home, trash, checkOpenPaths: closed });
    expect(plan.entries.map((entry) => entry.path)).toContain(mirror);
    for (const file of retained) expect(plan.entries.map((entry) => entry.path)).not.toContain(file);
    expect(plan.entries.map((entry) => entry.path)).not.toContain(cowork);
    expect(await plan.execute()).toMatchObject({ failures: [] });
    for (const file of [...retained, cowork]) expect((await fs.lstat(file)).isFile()).toBe(true);
    await expect(fs.lstat(mirror)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans worktree-linked metadata only when its local transcript matches, and retains worktree ghosts", async () => {
    const home = await makeHome();
    const linkedTranscriptId = "90000000-0000-4000-8000-000000000001";
    await putTranscript(home, linkedTranscriptId);
    const linked = await putRecord(home, { id: "91000000-0000-4000-8000-000000000001", cliId: linkedTranscriptId,
      fields: { worktreeName: "synthetic", worktreePath: path.join(home, "worktrees", "linked") } });
    const ghost = await putRecord(home, { id: "92000000-0000-4000-8000-000000000001", cliId: "93000000-0000-4000-8000-000000000001",
      fields: { startedWithWorktree: true } });
    const unnormalizedPath = await putRecord(home, { id: "96000000-0000-4000-8000-000000000001",
      cliId: "97000000-0000-4000-8000-000000000001",
      fields: { cwd: `${home}/project/../project` } });
    const trash = vi.fn(async (files: string[]) => {
      for (const file of files) await fixtureTrash(file);
    });

    const plan = await prepareClean(["claude"], { home, trash, checkOpenPaths: closed });
    expect(plan.entries.map((entry) => entry.path)).toContain(linked);
    expect(plan.entries.map((entry) => entry.path)).not.toContain(ghost);
    expect(plan.entries.map((entry) => entry.path)).not.toContain(unnormalizedPath);
    expect(await plan.execute()).toMatchObject({ failures: [] });
    await expect(fs.lstat(linked)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(ghost)).isFile()).toBe(true);
    expect((await fs.lstat(unnormalizedPath)).isFile()).toBe(true);
  });

  it.each(["invalid JSON", "invalid schema", "filename mismatch", "symlink", "hard link", "oversized record"])(
    "refuses %s metadata before calling Trash",
    async (kind) => {
      const home = await makeHome();
      const file = desktopPath(home);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const valid = { sessionId: `local_${desktopId}`, createdAt: 1, lastActivityAt: 2,
        cliSessionId: transcriptId, cwd: path.join(home, "project") };
      if (kind === "invalid JSON") await fs.writeFile(file, "{");
      else if (kind === "invalid schema") await fs.writeFile(file, JSON.stringify({ ...valid, createdAt: "yesterday" }));
      else if (kind === "filename mismatch") await fs.writeFile(file, JSON.stringify({ ...valid, sessionId: "local_99999999-0000-4000-8000-000000000001" }));
      else if (kind === "symlink") {
        const source = await put(home, "redirect-target.json", JSON.stringify(valid));
        await fs.symlink(source, file);
      } else if (kind === "hard link") {
        const source = await put(home, "hardlink-target.json", JSON.stringify(valid));
        await fs.link(source, file);
      } else {
        await fs.writeFile(file, JSON.stringify({ ...valid, title: "x".repeat(1024 * 1024) }));
      }
      const trash = vi.fn();
      await expect(prepareClean(["claude"], { home, trash, checkOpenPaths: closed })).rejects.toThrow();
      expect(trash).not.toHaveBeenCalled();
    }
  );

  it("rejects non-empty pending imports and unsafe custom data roots without Trash", async () => {
    const home = await makeHome();
    const staging = path.join(path.dirname(desktopPath(home)), "imported-staging");
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, "synthetic-import.json"), "synthetic pending import");
    const trash = vi.fn();
    await expect(prepareClean(["claude"], { home, trash, checkOpenPaths: closed })).rejects.toThrow(/import/);
    expect(trash).not.toHaveBeenCalled();

    vi.stubEnv("CLAUDE_USER_DATA_DIR", path.join(home, "custom-Claude"));
    await expect(prepareClean(["claude"], { home, trash, checkOpenPaths: closed })).rejects.toThrow(/custom CLAUDE_USER_DATA_DIR/);
    expect(trash).not.toHaveBeenCalled();
  });

  it.each(["new record", "replacement inode", "same-size content", "parent replacement"])(
    "rejects %s changes made after preview",
    async (change) => {
      const home = await makeHome();
      const file = await putRecord(home, { cliId: anotherId });
      const original = await fs.readFile(file, "utf8");
      const trash = vi.fn();
      const timestamp = new Date("2020-01-02T03:04:05.000Z");
      if (change === "same-size content") await fs.utimes(file, timestamp, timestamp);
      const plan = await prepareClean(["claude"], { home, trash, checkOpenPaths: closed });

      if (change === "new record") {
        await putRecord(home, { id: "94000000-0000-4000-8000-000000000001", cliId: anotherId });
      } else if (change === "replacement inode") {
        await fs.rename(file, `${file}.retained`);
        await fs.writeFile(file, original);
      } else if (change === "same-size content") {
        const before = await fs.lstat(file);
        const value = JSON.parse(original) as Record<string, unknown>;
        value.title = "Synthetic Claude Code sessioN";
        const changed = JSON.stringify(value);
        expect(changed).toHaveLength(original.length);
        await fs.writeFile(file, changed);
        await fs.utimes(file, timestamp, timestamp);
        expect(await fs.lstat(file)).toMatchObject({
          ino: before.ino,
          size: before.size,
          mtimeMs: before.mtimeMs
        });
      } else {
        const org = path.dirname(file);
        await fs.rename(org, `${org}.retained`);
        await fs.mkdir(org, { recursive: true });
        await fs.writeFile(file, original);
      }

      await expect(plan.execute()).rejects.toThrow(/changed|inventory/);
      expect(trash).not.toHaveBeenCalled();
    }
  );

  it("rejects an open Desktop index during preflight", async () => {
    const home = await makeHome();
    const index = await putRecord(home, { cliId: anotherId });
    const trash = vi.fn();
    await expect(prepareClean(["claude"], {
      home,
      trash,
      checkOpenPaths: async (paths) => ({ supported: true, openPaths: paths.includes(index) ? [index] : [] })
    })).rejects.toThrow(/Open files/);
    expect(trash).not.toHaveBeenCalled();
    expect((await fs.lstat(index)).isFile()).toBe(true);
  });

  it("leaves Desktop metadata intact when normal transcript Trash fails", async () => {
    const home = await makeHome();
    const transcript = await putTranscript(home);
    const index = await putRecord(home);
    const calls: string[][] = [];
    const trash = vi.fn(async (files: string[]) => {
      calls.push([...files]);
      if (files.includes(transcript)) throw new Error("synthetic transcript Trash failure");
      for (const file of files) await fixtureTrash(file);
    });
    const plan = await prepareClean(["claude"], { home, trash, checkOpenPaths: closed });
    const result = await plan.execute();
    expect(result.failures.length).toBeGreaterThan(0);
    expect(calls.flat()).toEqual([transcript]);
    expect((await fs.lstat(transcript)).isFile()).toBe(true);
    expect((await fs.lstat(index)).isFile()).toBe(true);
  });

  it.each(["new record", "recreated index"])("does not report success when %s appears during index Trash", async (change) => {
    const home = await makeHome();
    const index = await putRecord(home, { cliId: anotherId });
    const trash = vi.fn(async (files: string[]) => {
      if (change === "new record") {
        await putRecord(home, { id: "95000000-0000-4000-8000-000000000001", cliId: transcriptId });
        await fixtureTrash(files[0]!);
      } else {
        await fixtureTrash(files[0]!);
        await putRecord(home, { cliId: anotherId });
      }
    });
    const plan = await prepareClean(["claude"], { home, trash, checkOpenPaths: closed });
    const result = await plan.execute();
    expect(result.failures.length).toBeGreaterThan(0);
    expect(trash).toHaveBeenCalledTimes(1);
    if (change === "recreated index") expect((await fs.lstat(index)).isFile()).toBe(true);
  });

  it("journals and exposes the actual Desktop metadata path in operation inspection", async () => {
    const home = await makeHome();
    const index = await putRecord(home, { cliId: anotherId });
    await withOperation({ home, kind: "clean", target: ["claude"] }, async () => {
      const plan = await prepareClean(["claude"], {
        home,
        checkOpenPaths: closed,
        trash: wrapOperationTrash(async (files) => {
          for (const file of files) await fixtureTrash(file);
        })
      });
      expect(await plan.execute()).toMatchObject({ failures: [] });
    });
    const [summary] = await listOperations(home);
    expect(summary).toMatchObject({ target: ["claude"], status: "succeeded" });
    const inspected = await inspectOperation(summary!.id, home);
    expect(inspected.operation.plannedPaths).toContain(index);
    expect(inspected.operation.movedPaths).toContain(index);
  });
});
