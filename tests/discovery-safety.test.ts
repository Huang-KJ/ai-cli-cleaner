import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";
import { validateAntigravityDataPath, validateOwnedConversationPaths } from "../src/conversations/owned-paths.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const homes: string[] = [];
const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const thirdId = "33333333-3333-4333-8333-333333333333";

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

describe("conversation discovery path safety", () => {
  it("keeps a missing Codex storage root silent", async () => {
    const result = await discoverConversations(["codex"], { home: await makeHome() });
    expect(result).toEqual({ conversations: [], warnings: [] });
  });

  it("warns and skips a redirected Codex session directory", async () => {
    const home = await makeHome();
    const external = path.join(home, "outside-sessions");
    await writeRollout(path.join(external, "rollout.jsonl"), id);
    await fs.mkdir(path.join(home, ".codex"));
    await fs.symlink(external, path.join(home, ".codex", "sessions"));
    const result = await discoverConversations(["codex"], { home });
    expect(result.conversations).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/symbolic link/);
  });

  it("warns and skips redirected Codex index files", async () => {
    const home = await makeHome();
    const external = path.join(home, "outside-index.jsonl");
    await fs.writeFile(external, `${JSON.stringify({ id, thread_name: "redirected" })}\n`);
    await fs.mkdir(path.join(home, ".codex"));
    await fs.symlink(external, path.join(home, ".codex", "session_index.jsonl"));
    const result = await discoverConversations(["codex"], { home });
    expect(result.conversations).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/symbolic link/);
    expect(await fs.readFile(external, "utf8")).toContain("redirected");
  });

  it("keeps real-home aliases and leap-day ownership consistent", async () => {
    const base = await makeHome();
    const actual = path.join(base, "actual-home");
    const home = path.join(base, "home-alias");
    await fs.mkdir(actual);
    await fs.symlink(actual, home);
    const rollout = path.join(home, ".codex", "sessions", "rollout.jsonl");
    await writeRollout(rollout, id);
    const valid = path.join(home, ".codex", "visualizations", "2024", "02", "29", id);
    const invalid = path.join(home, ".codex", "visualizations", "2026", "02", "29", id);
    await fs.mkdir(valid, { recursive: true });
    await fs.mkdir(invalid, { recursive: true });
    const result = await discoverConversations(["codex"], { home });
    expect(result.warnings).toEqual([]);
    const selected = result.conversations[0]!;
    expect(selected.dataPaths).toContain(valid);
    expect(selected.dataPaths).not.toContain(invalid);
    await expect(validateOwnedConversationPaths(selected, home)).resolves.toContain(await fs.realpath(valid));
    await expect(validateOwnedConversationPaths({ ...selected, dataPaths: [invalid] }, home)).rejects.toThrow(/outside .codex\/sessions|does not belong to the specified conversation/);
  });

  it.each(["", ".pb"])("requires the bare Antigravity brain ID to be a directory: %s", async (suffix) => {
    const home = await makeHome();
    const candidate = path.join(home, ".gemini", "antigravity-cli", "brain", `${id}${suffix}`);
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await fs.writeFile(candidate, "brain data");
    const result = await validateAntigravityDataPath(candidate, id, home);
    expect(result.status).toBe("invalid");
    expect(await fs.readFile(candidate, "utf8")).toBe("brain data");
  });

  it("disables a Codex row that points to a project or configuration file", async () => {
    const home = await makeHome();
    const config = path.join(home, ".codex", "settings.json");
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(config, `${JSON.stringify({ id })}\n`);
    await addCodexRow(home, id, config);

    const result = await discoverConversations(["codex"], { home });
    const conversation = result.conversations.find((item) => item.id === id);

    expect(conversation?.disabledReason).toMatch(/outside .codex\/sessions or archived_sessions/);
    expect(conversation?.dataPaths).not.toContain(config);
  });

  it("disables Codex rows with rollout symlink redirects or a different full ID", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    const linked = path.join(root, "sessions", "linked.jsonl");
    const projectRollout = path.join(home, "project", "rollout.jsonl");
    await fs.mkdir(path.dirname(linked), { recursive: true });
    await fs.mkdir(path.dirname(projectRollout), { recursive: true });
    await writeRollout(projectRollout, id);
    await fs.symlink(projectRollout, linked);
    await addCodexRow(home, id, linked);

    const mismatch = path.join(root, "sessions", "mismatch.jsonl");
    await writeRollout(mismatch, otherId);
    await addCodexRow(home, thirdId, mismatch);

    const result = await discoverConversations(["codex"], { home });
    const linkedConversation = result.conversations.find((item) => item.id === id);
    const mismatchConversation = result.conversations.find((item) => item.id === thirdId);

    expect(linkedConversation?.disabledReason).toMatch(/symbolic link/);
    expect(mismatchConversation?.disabledReason).toMatch(/ID does not match the conversation ID/);
    expect(linkedConversation?.dataPaths).not.toContain(linked);
    expect(mismatchConversation?.dataPaths).not.toContain(mismatch);
  });

  it("merges all valid rollouts when the database path is stale and indexes dated visuals once", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    const sessions = path.join(root, "sessions");
    const first = path.join(sessions, "2026", "09", "24", `${id}.jsonl`);
    const second = path.join(root, "archived_sessions", `${id}.jsonl`);
    const stale = path.join(sessions, "old", `${id}.jsonl`);
    const datedVisual = path.join(root, "visualizations", "2026", "09", "24", id);
    const snapshot = path.join(root, "shell_snapshots", `${id}.snapshot`);
    const unrelated = path.join(root, "visualizations", "2026", "09", "24", `${id}-copy`);
    await writeRollout(first, id);
    await writeRollout(second, id);
    await fs.mkdir(datedVisual, { recursive: true });
    await fs.writeFile(path.join(datedVisual, "index.html"), "visual");
    await fs.mkdir(path.dirname(snapshot), { recursive: true });
    await fs.writeFile(snapshot, "snapshot");
    await fs.mkdir(unrelated, { recursive: true });
    await fs.writeFile(path.join(unrelated, "keep.txt"), "keep");
    await addCodexRow(home, id, stale);

    const result = await discoverConversations(["codex"], { home });
    const conversation = result.conversations.find((item) => item.id === id);

    expect(conversation?.disabledReason).toBeUndefined();
    expect(conversation?.dataPaths).toEqual(expect.arrayContaining([first, second, datedVisual, snapshot]));
    expect(conversation?.dataPaths).not.toContain(unrelated);
    expect(conversation?.dataPaths.filter((entry) => entry.endsWith(".jsonl"))).toHaveLength(2);
    await expect(validateOwnedConversationPaths(conversation!, home)).resolves.toEqual(
      expect.arrayContaining([await fs.realpath(first), await fs.realpath(second), await fs.realpath(datedVisual), await fs.realpath(snapshot)])
    );
  });

  it("revalidates exact Copilot and Antigravity IDs and rejects other owned-looking paths", async () => {
    const home = await makeHome();
    const copilotRoot = path.join(home, ".copilot", "session-state");
    const copilotPath = path.join(copilotRoot, id);
    const copilotOther = path.join(copilotRoot, otherId);
    await fs.mkdir(copilotPath, { recursive: true });
    await fs.mkdir(copilotOther, { recursive: true });
    const copilot = localConversation("copilot", id, [copilotPath], { kind: "copilot" });
    await expect(validateOwnedConversationPaths(copilot, home)).resolves.toEqual([await fs.realpath(copilotPath)]);
    await expect(validateOwnedConversationPaths({ ...copilot, dataPaths: [copilotOther] }, home))
      .rejects.toThrow(/session-state directory for the specified ID/);
    const copilotLink = path.join(copilotRoot, thirdId);
    const outsideDirectory = path.join(home, "project", "copilot-data");
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.symlink(outsideDirectory, copilotLink);
    await expect(validateOwnedConversationPaths({ ...copilot, id: thirdId, dataPaths: [copilotLink] }, home))
      .rejects.toThrow(/symbolic link/);

    const antigravityPath = path.join(home, ".gemini", "antigravity-cli", "brain", id);
    await fs.mkdir(antigravityPath, { recursive: true });
    const antigravity = localConversation("antigravity", id, [antigravityPath], { kind: "antigravity" });
    await expect(validateOwnedConversationPaths(antigravity, home))
      .resolves.toEqual([await fs.realpath(antigravityPath)]);
    await expect(validateOwnedConversationPaths({
      ...antigravity,
      dataPaths: [path.join(home, ".gemini", "antigravity-cli", "cache", id)]
    }, home)).rejects.toThrow(/does not exactly match the conversation ID/);
  });

  it("bounds the rollout header read", async () => {
    const home = await makeHome();
    const rollout = path.join(home, ".codex", "sessions", `${id}.jsonl`);
    await fs.mkdir(path.dirname(rollout), { recursive: true });
    await fs.writeFile(rollout, `${"x".repeat(65 * 1024)}\n${JSON.stringify({ id })}\n`);
    await addCodexRow(home, id, rollout);

    const codex = await discoverConversations(["codex"], { home });
    expect(codex.conversations.find((item) => item.id === id)?.disabledReason).toMatch(/64 KiB/);

  });
});

async function makeHome(): Promise<string> {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-discovery-"));
  homes.push(home);
  return home;
}

async function writeRollout(file: string, conversationId: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { id: conversationId } })}\n`);
}

async function addCodexRow(home: string, conversationId: string, rolloutPath: string): Promise<void> {
  const file = path.join(home, ".codex", "state_5.sqlite");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    database.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    database.prepare("INSERT OR REPLACE INTO threads (id, rollout_path) VALUES (?, ?)")
      .run(conversationId, rolloutPath);
  } finally {
    database.close();
  }
}

function localConversation(
  providerId: "codex" | "copilot" | "antigravity",
  conversationId: string,
  dataPaths: string[],
  metadata: NonNullable<Extract<ConversationRecord["deleteStrategy"], { kind: "local" }>["metadata"]>
): ConversationRecord {
  return {
    key: `${providerId}:${conversationId}`,
    providerId,
    providerName: providerId,
    id: conversationId,
    title: conversationId,
    sizeBytes: 0,
    dataPaths,
    guardPaths: [],
    deleteStrategy: { kind: "local", metadata },
    warnings: []
  };
}
