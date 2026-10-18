import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCodexConversationMetadata } from "../src/conversations/codex-metadata.js";
import { deleteConversations } from "../src/conversations/delete.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fixtureTrash(directory, { recursive: true, force: true })
  ));
});

describe("multi-agent conversation discovery and deletion", () => {
  it("deletes only the selected Codex thread and exact metadata references", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    const selectedId = "11111111-1111-4111-8111-111111111111";
    const otherId = "22222222-2222-4222-8222-222222222222";
    const selectedRollout = path.join(root, "sessions", `${selectedId}.jsonl`);
    const otherRollout = path.join(root, "sessions", `${otherId}.jsonl`);
    await fs.mkdir(path.dirname(selectedRollout), { recursive: true });
    await fs.writeFile(selectedRollout, JSON.stringify({ payload: { id: selectedId } }) + "\n");
    const otherContents = JSON.stringify({ payload: { id: otherId } }) + "\n";
    await fs.writeFile(otherRollout, otherContents);
    const stateDatabase = path.join(root, "state_5.sqlite");
    createCodexStateDatabase(stateDatabase, selectedId, otherId, selectedRollout, otherRollout);
    const sessionIndex = path.join(root, "session_index.jsonl");
    await fs.writeFile(sessionIndex, [
      JSON.stringify({ id: selectedId, thread_name: "selected" }),
      JSON.stringify({ id: otherId, thread_name: "other" })
    ].join("\n") + "\n");
    const globalState = path.join(root, ".codex-global-state.json");
    await fs.writeFile(globalState, JSON.stringify({
      "pinned-thread-ids": [selectedId, otherId],
      "thread-project-assignments": { [selectedId]: "remove", [otherId]: "keep" },
      customSetting: selectedId,
      unrelated: `prefix-${selectedId}-suffix`
    }));
    const conversation = localConversation("codex", selectedId, [selectedRollout], {
      kind: "codex",
      stateDatabase,
      sessionIndex,
      globalStateFiles: [globalState]
    });

    const result = await deleteConversations([conversation], localOptions(home));
    expect(result.failures).toEqual([]);
    await expect(fs.stat(selectedRollout)).rejects.toThrow();
    await expect(fs.readFile(otherRollout, "utf8")).resolves.toBe(otherContents);

    const database = new DatabaseSync(stateDatabase, { readOnly: true });
    try {
      expect(database.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual([{ id: otherId }]);
      expect(database.prepare("SELECT thread_id FROM thread_items ORDER BY thread_id").all())
        .toEqual([{ thread_id: otherId }]);
    } finally {
      database.close();
    }
    expect(await fs.readFile(sessionIndex, "utf8")).not.toContain(selectedId);
    const rewritten = JSON.parse(await fs.readFile(globalState, "utf8")) as Record<string, unknown>;
    expect(rewritten).toMatchObject({
      "pinned-thread-ids": [otherId],
      "thread-project-assignments": { [otherId]: "keep" },
      customSetting: selectedId,
      unrelated: `prefix-${selectedId}-suffix`
    });
  });

  it("deletes only the selected Copilot session rows and directory", async () => {
    const home = await makeHome();
    const root = path.join(home, ".copilot");
    const selectedId = "session-selected";
    const otherId = "session-other";
    const selectedDirectory = path.join(root, "session-state", selectedId);
    const otherDirectory = path.join(root, "session-state", otherId);
    await fs.mkdir(selectedDirectory, { recursive: true });
    await fs.mkdir(otherDirectory, { recursive: true });
    await fs.writeFile(path.join(selectedDirectory, "events.jsonl"), "selected\n");
    await fs.writeFile(path.join(otherDirectory, "events.jsonl"), "other\n");
    const sessionStoreDatabase = path.join(root, "session-store.db");
    createCopilotDatabase(sessionStoreDatabase, selectedId, otherId);
    const conversation = localConversation("copilot", selectedId, [selectedDirectory], {
      kind: "copilot",
      sessionStoreDatabase
    });

    const result = await deleteConversations([conversation], localOptions(home));
    expect(result.failures).toEqual([]);
    await expect(fs.stat(selectedDirectory)).rejects.toThrow();
    await expect(fs.readFile(path.join(otherDirectory, "events.jsonl"), "utf8"))
      .resolves.toBe("other\n");

    const database = new DatabaseSync(sessionStoreDatabase, { readOnly: true });
    try {
      expect(database.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: otherId }]);
      expect(database.prepare("SELECT session_id FROM events ORDER BY session_id").all())
        .toEqual([{ session_id: otherId }]);
    } finally {
      database.close();
    }
  });

  it("clears all Codex thread metadata while preserving project and app settings", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    const sqliteRoot = path.join(root, "sqlite");
    await fs.mkdir(sqliteRoot, { recursive: true });
    const globalState = path.join(root, ".codex-global-state.json");
    await fs.writeFile(globalState, JSON.stringify({
      "pinned-thread-ids": ["thread-1"],
      "thread-project-assignments": { "thread-1": "project-1" },
      "local-projects": { "project-1": { path: "/project" } },
      theme: "dark"
    }));
    const appDatabase = path.join(sqliteRoot, "codex-dev.db");
    const database = new DatabaseSync(appDatabase);
    try {
      database.exec("CREATE TABLE local_thread_catalog (thread_id TEXT)");
      database.exec("CREATE TABLE local_app_server_feature_enablement (feature TEXT)");
      database.prepare("INSERT INTO local_thread_catalog VALUES (?)").run("thread-1");
      database.prepare("INSERT INTO local_app_server_feature_enablement VALUES (?)").run("keep");
    } finally {
      database.close();
    }

    const plan = await prepareCodexConversationMetadata(home, localOptions(home).trash);
    await plan.validate();
    await plan.execute();
    const state = JSON.parse(await fs.readFile(globalState, "utf8")) as Record<string, unknown>;
    expect(state).toMatchObject({
      "pinned-thread-ids": [],
      "thread-project-assignments": {},
      "local-projects": { "project-1": { path: "/project" } },
      theme: "dark"
    });
    const checked = new DatabaseSync(appDatabase, { readOnly: true });
    try {
      expect(checked.prepare("SELECT COUNT(*) AS count FROM local_thread_catalog").get())
        .toEqual({ count: 0 });
      expect(checked.prepare("SELECT feature FROM local_app_server_feature_enablement").all())
        .toEqual([{ feature: "keep" }]);
    } finally {
      checked.close();
    }
  });
});

async function makeHome(): Promise<string> {
  const directory = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-agents-"));
  temporaryDirectories.push(directory);
  return directory;
}

function localConversation(
  providerId: "codex" | "copilot",
  id: string,
  dataPaths: string[],
  metadata: Extract<ConversationRecord["deleteStrategy"], { kind: "local" }>["metadata"]
): ConversationRecord {
  return {
    key: `${providerId}:${id}`,
    providerId,
    providerName: providerId === "codex" ? "Codex" : "GitHub Copilot CLI",
    id,
    title: id,
    sizeBytes: 1,
    dataPaths,
    guardPaths: [],
    deleteStrategy: { kind: "local", metadata },
    warnings: []
  };
}

function localOptions(home: string) {
  return {
    home,
    checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
    trash: async (paths: string[]) => {
      const trash = path.join(home, "mock-trash");
      await fs.mkdir(trash, { recursive: true });
      for (const [index, entry] of paths.entries()) {
        await fs.rename(entry, path.join(trash, `${Date.now()}-${index}-${path.basename(entry)}`));
      }
    }
  };
}

function createCodexStateDatabase(
  file: string,
  selectedId: string,
  otherId: string,
  selectedRollout: string,
  otherRollout: string
): void {
  const database = new DatabaseSync(file);
  try {
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    database.exec("CREATE TABLE thread_items (thread_id TEXT, item TEXT)");
    database.prepare("INSERT INTO threads VALUES (?, ?)").run(selectedId, selectedRollout);
    database.prepare("INSERT INTO threads VALUES (?, ?)").run(otherId, otherRollout);
    database.prepare("INSERT INTO thread_items VALUES (?, ?)").run(selectedId, "selected");
    database.prepare("INSERT INTO thread_items VALUES (?, ?)").run(otherId, "other");
  } finally {
    database.close();
  }
}

function createCopilotDatabase(file: string, selectedId: string, otherId: string): void {
  const database = new DatabaseSync(file);
  try {
    database.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)");
    database.exec("CREATE TABLE events (session_id TEXT, event TEXT)");
    database.prepare("INSERT INTO sessions VALUES (?, ?)").run(selectedId, "selected");
    database.prepare("INSERT INTO sessions VALUES (?, ?)").run(otherId, "other");
    database.prepare("INSERT INTO events VALUES (?, ?)").run(selectedId, "selected");
    database.prepare("INSERT INTO events VALUES (?, ?)").run(otherId, "other");
  } finally {
    database.close();
  }
}
