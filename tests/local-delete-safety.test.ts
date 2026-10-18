import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteConversations } from "../src/conversations/delete.js";
import { discoverConversations } from "../src/conversations/discover.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const homes: string[] = [];
const codexId = "11111111-1111-4111-8111-111111111111";
const copilotId = "session-local-delete-test";

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

describe("local conversation deletion safety", () => {
  it("preserves the original single-Codex error identity and recovery details", async () => {
    const home = await makeHome();
    const rollout = await createCodexRollout(home, codexId);
    const stateDatabase = path.join(home, ".codex", "state_5.sqlite");
    createCodexDatabase(stateDatabase, codexId, rollout);
    const conversation = codexConversation(codexId, [rollout], {
      stateDatabase, sessionIndex: path.join(home, ".codex", "session_index.jsonl")
    });
    const original = Object.assign(new Error("synthetic occupancy failure"), {
      name: "RecoveryError", code: "E_SYNTHETIC", recoveryPath: path.join(home, "owned-recovery")
    });
    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations([conversation], {
      ...options(home, trash), checkOpenPaths: async () => { throw original; }
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toBe(original);
    expect(result.failures[0]?.error.name).toBe("RecoveryError");
    expect((result.failures[0]?.error as Error & { code?: string }).code).toBe("E_SYNTHETIC");
    expect(result.failures[0]?.error.message).toBe(original.message);
    expect(result.failures[0]?.recoveryPath).toBe(original.recoveryPath);
    expect(result.failures[0]?.deletedPaths).toBeUndefined();
    expect(trash).not.toHaveBeenCalled();
  });

  it("rejects malformed Codex JSON before calling Trash", async () => {
    const home = await makeHome();
    const rollout = await createCodexRollout(home, codexId);
    const stateDatabase = path.join(home, ".codex", "state_5.sqlite");
    createCodexDatabase(stateDatabase, codexId, rollout);
    const globalState = path.join(home, ".codex", ".codex-global-state.json");
    const malformed = "{invalid json\n";
    await fs.writeFile(globalState, malformed);
    const conversation = codexConversation(codexId, [rollout], {
      stateDatabase,
      sessionIndex: path.join(home, ".codex", "session_index.jsonl"),
      globalStateFiles: [globalState]
    });
    const trash = vi.fn(async () => undefined);

    const result = await deleteConversations([conversation], options(home, trash));

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(/JSON|position|Unexpected/i);
    expect(trash).not.toHaveBeenCalled();
    await expect(fs.readFile(globalState, "utf8")).resolves.toBe(malformed);
    await expect(fs.readFile(rollout, "utf8")).resolves.toContain(codexId);
  });

  it("rejects an unsupported Codex SQLite schema before calling Trash", async () => {
    const home = await makeHome();
    const rollout = await createCodexRollout(home, codexId);
    const stateDatabase = path.join(home, ".codex", "state_5.sqlite");
    const database = new DatabaseSync(stateDatabase);
    try {
      database.exec("CREATE TABLE threads (id TEXT)");
      database.prepare("INSERT INTO threads (id) VALUES (?)").run(codexId);
    } finally {
      database.close();
    }
    const conversation = codexConversation(codexId, [rollout], {
      stateDatabase,
      sessionIndex: path.join(home, ".codex", "session_index.jsonl")
    });
    const trash = vi.fn(async () => undefined);

    const result = await deleteConversations([conversation], options(home, trash));

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(/threads is missing required column rollout_path/);
    expect(trash).not.toHaveBeenCalled();
    await expect(fs.readFile(rollout, "utf8")).resolves.toContain(codexId);
  });

  it("rejects an unsupported Copilot sessions schema before calling Trash", async () => {
    const home = await makeHome();
    const sessionDirectory = path.join(home, ".copilot", "session-state", copilotId);
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(path.join(sessionDirectory, "events.jsonl"), "session event\n");
    const sessionStoreDatabase = path.join(home, ".copilot", "session-store.db");
    const database = new DatabaseSync(sessionStoreDatabase);
    try {
      database.exec("CREATE TABLE sessions (session_key TEXT)");
      database.prepare("INSERT INTO sessions (session_key) VALUES (?)").run(copilotId);
    } finally {
      database.close();
    }
    const conversation = copilotConversation(sessionDirectory, sessionStoreDatabase);
    const trash = vi.fn(async () => undefined);

    const result = await deleteConversations([conversation], options(home, trash));

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(/sessions is missing a complete session ID column/);
    expect(trash).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(sessionDirectory, "events.jsonl"), "utf8"))
      .resolves.toBe("session event\n");
  });

  it("rejects a Copilot session-state root symlink and preserves stale-session metadata", async () => {
    const home = await makeHome();
    const copilotRoot = path.join(home, ".copilot");
    const sessionRoot = path.join(copilotRoot, "session-state");
    const sessionDirectory = path.join(sessionRoot, copilotId);
    const sessionStore = path.join(copilotRoot, "session-store.db");
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(path.join(sessionDirectory, "events.jsonl"), "session event\n");
    createCopilotDatabase(sessionStore);

    const initial = await discoverConversations(["copilot"], { home });
    const conversation = initial.conversations.find((item) => item.id === copilotId);
    expect(conversation?.disabledReason).toBeUndefined();

    const external = path.join(home, "outside-session-state");
    await fs.mkdir(path.join(external, copilotId), { recursive: true });
    await fs.rename(sessionRoot, `${sessionRoot}.saved`);
    await fs.symlink(external, sessionRoot, "dir");

    const rediscovery = await discoverConversations(["copilot"], { home });
    expect(rediscovery.conversations).toEqual([]);
    expect(rediscovery.warnings.join(" ")).toMatch(/storage root|symbolic link/);

    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations([conversation!], options(home, trash));
    expect(result.deleted).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
    const database = new DatabaseSync(sessionStore, { readOnly: true });
    try {
      expect(database.prepare("SELECT id FROM sessions").all()).toEqual([{ id: copilotId }]);
    } finally {
      database.close();
    }
  });

  it("refuses local cleanup when open-file checks are unavailable", async () => {
    const home = await makeHome();
    const sessionDirectory = path.join(home, ".copilot", "session-state", copilotId);
    const sessionStore = path.join(home, ".copilot", "session-store.db");
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(path.join(sessionDirectory, "events.jsonl"), "session event\n");
    createCopilotDatabase(sessionStore);
    const conversation = copilotConversation(sessionDirectory, sessionStore);
    const trash = vi.fn(async () => undefined);

    const result = await deleteConversations([conversation], {
      ...options(home, trash),
      checkOpenPaths: async () => ({ supported: false, openPaths: [] })
    });

    expect(result.failures).toHaveLength(1);
    expect(result.deleted).toEqual([]);
    expect(trash).not.toHaveBeenCalled();
    expect(result.openFileCheckUnsupported).toBe(true);
  });

  it("rejects a project directory under HOME as local conversation data", async () => {
    const home = await makeHome();
    const project = path.join(home, "Projects", "keep-this-project");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "README.txt"), "keep\n");
    const conversation = codexConversation(codexId, [project], {
      stateDatabase: path.join(home, ".codex", "state_5.sqlite"),
      sessionIndex: path.join(home, ".codex", "session_index.jsonl")
    });
    const trash = vi.fn(async () => undefined);

    const result = await deleteConversations([conversation], options(home, trash));

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(/outside .codex\/sessions or archived_sessions/);
    expect(trash).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(project, "README.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("reports paths moved before a later Trash failure and leaves metadata unchanged", async () => {
    const home = await makeHome();
    const first = await createCodexRollout(home, codexId, "first.jsonl");
    const second = await createCodexRollout(home, codexId, "second.jsonl");
    const stateDatabase = path.join(home, ".codex", "state_5.sqlite");
    createCodexDatabase(stateDatabase, codexId, first);
    const sessionIndex = path.join(home, ".codex", "session_index.jsonl");
    const indexBefore = `${JSON.stringify({ id: codexId, thread_name: "selected" })}\n`;
    await fs.writeFile(sessionIndex, indexBefore);
    const conversation = codexConversation(codexId, [first, second], {
      stateDatabase,
      sessionIndex
    });
    const mockTrash = path.join(home, "mock-trash");
    let calls = 0;
    const trash = vi.fn(async (paths: string[]) => {
      calls += 1;
      if (calls > 1) throw new Error("mock Trash failure on second path");
      await fs.mkdir(mockTrash, { recursive: true });
      await fs.rename(paths[0]!, path.join(mockTrash, "first.jsonl"));
    });

    const result = await deleteConversations([conversation], options(home, trash));

    expect(trash).toHaveBeenCalledTimes(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.deletedPaths).toEqual([first]);
    expect(result.failures[0]?.metadataChanged).toBe(false);
    expect(result.failures[0]?.error.message).toMatch(/mock Trash failure/);
    const recovery = result.failures[0]?.recoveryPath;
    expect(recovery).toBeDefined();
    const manifest = JSON.parse(await fs.readFile(path.join(recovery!, "manifest.json"), "utf8")) as {
      conversationIds: string[]; files: Array<{ originalPath: string; backupPath: string }>;
    };
    expect(manifest.conversationIds).toEqual([codexId]);
    const indexBackup = manifest.files.find((file) => file.originalPath === sessionIndex)!;
    expect(path.dirname(indexBackup.backupPath)).toBe(recovery);
    await expect(fs.readFile(indexBackup.backupPath, "utf8")).resolves.toBe(indexBefore);
    await expect(fs.stat(first)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(mockTrash, "first.jsonl"), "utf8")).resolves.toContain(codexId);
    await expect(fs.readFile(second, "utf8")).resolves.toContain(codexId);
    await expect(fs.readFile(sessionIndex, "utf8")).resolves.toBe(indexBefore);
    const checked = new DatabaseSync(stateDatabase, { readOnly: true });
    try {
      expect(checked.prepare("SELECT id FROM threads").all()).toEqual([{ id: codexId }]);
    } finally {
      checked.close();
    }
  });
});

async function makeHome(): Promise<string> {
  const temporary = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-delete-safety-"));
  const home = await fs.realpath(temporary);
  homes.push(home);
  return home;
}

async function createCodexRollout(home: string, id: string, name = `${id}.jsonl`): Promise<string> {
  const file = path.join(home, ".codex", "sessions", name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`);
  return file;
}

function createCodexDatabase(file: string, id: string, rollout: string): void {
  const database = new DatabaseSync(file);
  try {
    database.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT)");
    database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(id, rollout);
  } finally {
    database.close();
  }
}

function createCopilotDatabase(file: string): void {
  const database = new DatabaseSync(file);
  try {
    database.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
    database.prepare("INSERT INTO sessions (id) VALUES (?)").run(copilotId);
  } finally {
    database.close();
  }
}

function codexConversation(
  id: string,
  dataPaths: string[],
  metadata: { stateDatabase: string; sessionIndex: string; globalStateFiles?: string[] }
): ConversationRecord {
  return {
    key: `codex:${id}`,
    providerId: "codex",
    providerName: "Codex",
    id,
    title: id,
    sizeBytes: 1,
    dataPaths,
    guardPaths: [],
    deleteStrategy: { kind: "local", metadata: { kind: "codex", ...metadata } },
    warnings: []
  };
}

function copilotConversation(
  sessionDirectory: string,
  sessionStoreDatabase: string
): ConversationRecord {
  return {
    key: `copilot:${copilotId}`,
    providerId: "copilot",
    providerName: "GitHub Copilot CLI",
    id: copilotId,
    title: copilotId,
    sizeBytes: 1,
    dataPaths: [sessionDirectory],
    guardPaths: [],
    deleteStrategy: { kind: "local", metadata: { kind: "copilot", sessionStoreDatabase } },
    warnings: []
  };
}

function options(home: string, trash: (paths: string[]) => Promise<void>) {
  return {
    home,
    checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
    trash
  };
}
