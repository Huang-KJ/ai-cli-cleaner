import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { assertAntigravityPathsUnchanged } from "../src/conversations/discover-antigravity.js";

const homes: string[] = [];
const id = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

describe("conversation discovery completeness", () => {
  it.each([
    { directory: "conversations", name: `${id}.json`, folder: false },
    { directory: "html_artifacts", name: `${id}.pb.bak`, folder: false },
    { directory: "conversations", name: `copy-${id}.pb`, folder: false },
    { directory: "brain", name: `${id}.snapshot`, folder: true }
  ])("refuses uncovered Antigravity storage item $directory/$name", async (item) => {
    const fixture = await antigravityFixture();
    const unknown = path.join(fixture.cli, item.directory, item.name);
    await fs.mkdir(path.dirname(unknown), { recursive: true });
    if (item.folder) await fs.mkdir(unknown);
    else await fs.writeFile(unknown, "uncovered conversation content");
    const before = await fs.readFile(fixture.database);

    const discovery = await discoverConversations(["antigravity"], { home: fixture.home });
    const selected = discovery.conversations.find((item) => item.id === id)!;
    expect(selected.disabledReason).toMatch(/unaccounted-for or unsupported data/);
    expect(discovery.warnings.join("\n")).toContain(unknown);
    expect(selected.dataPaths).not.toContain(unknown);

    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations([selected], { home: fixture.home, trash, checkOpenPaths: closed });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(fixture.database)).toEqual(before);
    expect(await fs.readFile(fixture.history, "utf8")).toBe(fixture.historyText);
    expect(await fs.readFile(fixture.artifact, "utf8")).toBe("known artifact");
    expect((await fs.lstat(unknown)).isDirectory()).toBe(item.folder);
  });

  it("disables an Antigravity ID discovered only from an unsupported item", async () => {
    const home = await makeHome();
    const unknown = path.join(home, ".gemini", "antigravity-ide", "conversations", `${id}.json`);
    await fs.mkdir(path.dirname(unknown), { recursive: true });
    await fs.writeFile(unknown, "unsupported transcript");
    const discovery = await discoverConversations(["antigravity"], { home });
    expect(discovery.conversations).toHaveLength(1);
    expect(discovery.conversations[0]!.disabledReason).toMatch(/unaccounted-for or unsupported data/);
    expect(discovery.conversations[0]!.dataPaths).toEqual([]);
    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations(discovery.conversations, { home, trash, checkOpenPaths: closed });
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(unknown, "utf8")).toBe("unsupported transcript");
  });

  it("merges supported Antigravity CLI and IDE artifacts with the same ID", async () => {
    const fixture = await antigravityFixture();
    const ideArtifact = path.join(fixture.home, ".gemini", "antigravity-ide", "conversations", `${id}.pb`);
    await fs.mkdir(path.dirname(ideArtifact), { recursive: true });
    await fs.writeFile(ideArtifact, "IDE artifact");
    const discovery = await discoverConversations(["antigravity"], { home: fixture.home });
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations).toHaveLength(1);
    const selected = discovery.conversations[0]!;
    expect(selected.disabledReason).toBeUndefined();
    expect(selected.dataPaths).toEqual(expect.arrayContaining([path.dirname(fixture.artifact), ideArtifact]));
    const trashRoot = path.join(fixture.home, "fake-trash");
    await fs.mkdir(trashRoot);
    let moved = 0;
    const trash = vi.fn(async (files: string[]) => {
      for (const file of files) await fs.rename(file, path.join(trashRoot, `${moved++}-${path.basename(file)}`));
    });
    const result = await deleteConversations([selected], { home: fixture.home, trash, checkOpenPaths: closed });
    expect(result.failures).toEqual([]);
    expect(result.deleted).toEqual([selected]);
    await expect(fs.lstat(ideArtifact)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(fixture.artifact)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an unknown Antigravity artifact added after discovery", async () => {
    const fixture = await antigravityFixture();
    const discovery = await discoverConversations(["antigravity"], { home: fixture.home });
    const selected = discovery.conversations[0]!;
    expect(selected.disabledReason).toBeUndefined();
    const unknown = path.join(fixture.cli, "conversations", `${id}.json`);
    await fs.mkdir(path.dirname(unknown), { recursive: true });
    await fs.writeFile(unknown, "new unsupported artifact");
    const before = await fs.readFile(fixture.database);
    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations([selected], { home: fixture.home, trash, checkOpenPaths: closed });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(fixture.database)).toEqual(before);
    expect(await fs.readFile(fixture.history, "utf8")).toBe(fixture.historyText);
    expect(await fs.readFile(fixture.artifact, "utf8")).toBe("known artifact");
    expect(await fs.readFile(unknown, "utf8")).toBe("new unsupported artifact");
  });

  it.each(["added", "missing"])("refuses a supported Antigravity item %s after discovery", async (change) => {
    const fixture = await antigravityFixture();
    const discovery = await discoverConversations(["antigravity"], { home: fixture.home });
    const selected = discovery.conversations[0]!;
    let retained = fixture.artifact;
    if (change === "added") {
      const added = path.join(fixture.home, ".gemini", "antigravity-ide", "conversations", `${id}.pb`);
      await fs.mkdir(path.dirname(added), { recursive: true });
      await fs.writeFile(added, "new supported artifact");
    } else {
      const relocated = path.join(fixture.home, "relocated-brain");
      await fs.rename(path.dirname(fixture.artifact), relocated);
      retained = path.join(relocated, "artifact.md");
    }
    const before = await fs.readFile(fixture.database);
    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations([selected], { home: fixture.home, trash, checkOpenPaths: closed });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(fixture.database)).toEqual(before);
    expect(await fs.readFile(fixture.history, "utf8")).toBe(fixture.historyText);
    expect(await fs.readFile(retained, "utf8")).toBe("known artifact");
  });

  it("checks exact supported paths for a non-UUID synthetic Antigravity ID", async () => {
    const fixture = await antigravityFixture();
    const discovery = await discoverConversations(["antigravity"], { home: fixture.home });
    const synthetic = "synthetic-session";
    const directory = path.join(fixture.cli, "brain", synthetic);
    await fs.mkdir(directory);
    const selected = { ...discovery.conversations[0]!, id: synthetic, dataPaths: [directory] };
    await expect(assertAntigravityPathsUnchanged(selected, fixture.home)).resolves.toBeUndefined();
    const added = path.join(fixture.cli, "conversations", `${synthetic}.pb`);
    await fs.mkdir(path.dirname(added), { recursive: true });
    await fs.writeFile(added, "synthetic artifact");
    await expect(assertAntigravityPathsUnchanged(selected, fixture.home)).rejects.toThrow(/added or removed after discovery/);
  });

  it.each(["same-group", "other-group"])("disables every Grok copy with the same ID in %s", async (location) => {
    const home = await makeHome();
    const first = await grokSession(home, "group-a", "first", "id");
    const second = await grokSession(home, location === "same-group" ? "group-a" : "group-b", "second", "session_id");
    const registry = path.join(home, ".grok", "active_sessions.json");
    await fs.writeFile(registry, "[]\n");
    const discovery = await discoverConversations(["grok"], { home });
    expect(discovery.conversations).toHaveLength(2);
    expect(discovery.conversations.every((item) => item.disabledReason?.includes(
      "Grok conversation ID appears in multiple data directories"
    ))).toBe(true);
    expect(discovery.warnings.join("\n")).toContain(first);
    expect(discovery.warnings.join("\n")).toContain(second);
    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations(discovery.conversations, { home, trash, checkOpenPaths: closed });
    expect(result.deleted).toEqual([]);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(registry, "utf8")).toBe("[]\n");
    expect(await fs.readFile(path.join(first, "transcript.jsonl"), "utf8")).toBe("session transcript");
    expect(await fs.readFile(path.join(second, "transcript.jsonl"), "utf8")).toBe("session transcript");
  });

  it("refuses a duplicate Grok directory added after discovery", async () => {
    const home = await makeHome();
    const first = await grokSession(home, "group-a", "first", "id");
    const discovery = await discoverConversations(["grok"], { home });
    expect(discovery.conversations).toHaveLength(1);
    expect(discovery.conversations[0]!.disabledReason).toBeUndefined();
    const second = await grokSession(home, "group-b", "second", "session_id");
    const registry = path.join(home, ".grok", "active_sessions.json");
    await fs.writeFile(registry, "[]\n");
    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations(discovery.conversations, { home, trash, checkOpenPaths: closed });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(registry, "utf8")).toBe("[]\n");
    expect(await fs.readFile(path.join(first, "transcript.jsonl"), "utf8")).toBe("session transcript");
    expect(await fs.readFile(path.join(second, "transcript.jsonl"), "utf8")).toBe("session transcript");
  });
});

async function makeHome(): Promise<string> {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-completeness-"));
  homes.push(home);
  return home;
}

async function closed() {
  return { supported: true, openPaths: [] as string[] };
}

async function antigravityFixture() {
  const home = await makeHome();
  const cli = path.join(home, ".gemini", "antigravity-cli");
  const artifact = path.join(cli, "brain", id, "artifact.md");
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, "known artifact");
  const history = path.join(cli, "history.jsonl");
  const historyText = `${JSON.stringify({ conversationId: id, display: "known conversation" })}\n`;
  await fs.writeFile(history, historyText);
  const database = path.join(cli, "conversation_summaries.db");
  const db = new DatabaseSync(database);
  try {
    db.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, last_modified_time TEXT, workspace_uris TEXT)");
    db.prepare("INSERT INTO conversation_summaries VALUES(?, ?, ?, ?, ?)")
      .run(id, "known conversation", "preview", "2026-10-04T00:00:00Z", "/fixture");
  } finally {
    db.close();
  }
  return { home, cli, artifact, history, historyText, database };
}

async function grokSession(home: string, group: string, directory: string, key: "id" | "session_id"): Promise<string> {
  const session = path.join(home, ".grok", "sessions", group, directory);
  await fs.mkdir(session, { recursive: true });
  await fs.writeFile(path.join(session, "summary.json"), JSON.stringify({ info: { [key]: id, cwd: "/fixture" }, title: directory }));
  await fs.writeFile(path.join(session, "transcript.jsonl"), "session transcript");
  return session;
}
