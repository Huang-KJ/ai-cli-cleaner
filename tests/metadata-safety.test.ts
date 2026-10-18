import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertMetadataInventoryUnchanged,
  assertMetadataTargetUnchanged,
  atomicRewrite,
  createMetadataInventory,
  createRecoveryBackup,
  rehearseMetadata,
  removeRecoveryBackup
} from "../src/conversations/metadata-safety.js";
import {
  prepareCodexConversationMetadata,
  prepareCodexThreadsMetadata
} from "../src/conversations/codex-metadata.js";
import { deleteConversations as deleteAntigravity } from "../src/conversations/delete.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fixtureTrash(directory, { recursive: true, force: true })
  ));
});

describe("metadata safety", () => {
  it("keeps a concurrent metadata edit and removes the temporary rewrite before replacement", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "session_index.jsonl");
    await fs.writeFile(file, "before\n", { mode: 0o600 });
    const inventory = await createMetadataInventory([file], root, home);
    const open = fs.open.bind(fs);
    const concurrent = vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (String(target).startsWith(`${file}.ai-cleaner-`)) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          await sync();
          await fs.writeFile(file, "concurrent edit\n");
        });
      }
      return handle;
    });

    try {
      await expect(atomicRewrite(file, "replacement\n", inventory)).rejects.toThrow(/Metadata changed after preflight/);
      expect(await fs.readFile(file, "utf8")).toBe("concurrent edit\n");
      expect(await fs.readdir(root)).toEqual(["session_index.jsonl"]);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      concurrent.mockRestore();
    }
  });

  it("clears local references for index-only, history-only and rollout-only IDs during bulk cleanup", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(path.join(root, "sessions"), { recursive: true });
    await fs.writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: "index-only", thread_name: "index" }) + "\n");
    await fs.writeFile(path.join(root, "history.jsonl"), JSON.stringify({ session_id: "history-only", text: "history" }) + "\n");
    await fs.writeFile(path.join(root, "sessions", "rollout.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "rollout-only" } }) + "\n");
    const globalState = path.join(root, ".codex-global-state.json");
    await fs.writeFile(globalState, JSON.stringify({
      "pinned-thread-ids": ["index-only", "history-only", "rollout-only", "remote"],
      "thread-project-assignments": { "index-only": "project", "history-only": "project", "rollout-only": "project", remote: "remote-project" },
      theme: "dark"
    }));
    const plan = await prepareCodexConversationMetadata(home, mockTrash);
    await plan.validate();
    await plan.execute();
    expect(JSON.parse(await fs.readFile(globalState, "utf8"))).toEqual({
      "pinned-thread-ids": ["remote"], "thread-project-assignments": { remote: "remote-project" }, theme: "dark"
    });
  });

  it("rejects bulk source database changes before files are moved", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "state_5.sqlite");
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT); INSERT INTO threads VALUES ('first', 'fixture')");
    database.close();
    const plan = await prepareCodexConversationMetadata(home, mockTrash);
    const writer = new DatabaseSync(file);
    writer.exec("INSERT INTO threads VALUES ('later', 'fixture')");
    writer.close();
    await expect(plan.validate()).rejects.toThrow(/Metadata changed after preflight/);
    const checked = new DatabaseSync(file, { readOnly: true });
    try {
      expect(checked.prepare("SELECT COUNT(*) AS count FROM threads").get()).toEqual({ count: 2 });
    } finally { checked.close(); }
  });

  it("reuses Codex rehearsal only while the metadata content remains unchanged", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "state_5.sqlite");
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT); INSERT INTO threads VALUES ('selected', 'fixture')");
    database.close();
    const created = vi.spyOn(fs, "mkdtemp");
    try {
      const plan = await prepareCodexThreadsMetadata(home, {
        stateDatabase: file, sessionIndex: path.join(root, "session_index.jsonl")
      }, ["selected"], mockTrash);
      await plan.validate();
      await plan.validate();
      await plan.execute();
      expect(created.mock.calls.filter(([prefix]) => String(prefix).includes("ai-cleaner-preflight-"))).toHaveLength(1);
      const checked = new DatabaseSync(file, { readOnly: true });
      try {
        expect(checked.prepare("SELECT * FROM threads").all()).toEqual([]);
      } finally { checked.close(); }
    } finally { created.mockRestore(); }
  });

  it("rejects SQLite byte changes even when size and modification time are preserved", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "state_5.sqlite");
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT); INSERT INTO threads VALUES ('selected', 'fixture')");
    database.close();
    const timestamp = new Date("2026-01-01T00:00:00Z");
    await fs.utimes(file, timestamp, timestamp);
    const plan = await prepareCodexThreadsMetadata(home, {
      stateDatabase: file, sessionIndex: path.join(root, "session_index.jsonl")
    }, ["selected"], mockTrash);
    const bytes = await fs.readFile(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await fs.writeFile(file, bytes);
    await fs.utimes(file, timestamp, timestamp);
    await expect(plan.validate()).rejects.toThrow(/Metadata contents changed after preflight/);
    await expect(plan.execute()).rejects.toThrow(/Metadata contents changed after preflight/);
  });

  it("keeps SQLite source sidecars absent while rehearsing private copies", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(root, { recursive: true });
    const databasePath = path.join(root, "state_5.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE threads (id TEXT)");
    database.close();

    const inventory = await createMetadataInventory([databasePath], root, home);
    await rehearseMetadata(inventory, async () => undefined);
    expect(await exists(`${databasePath}-shm`)).toBe(false);
    expect(await exists(`${databasePath}-wal`)).toBe(false);
    await rehearseMetadata(inventory, async () => undefined);
    await assertMetadataTargetUnchanged(databasePath, inventory);
  });

  it("still rejects changes to committed SQLite WAL data", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(root, { recursive: true });
    const databasePath = path.join(root, "state_5.sqlite");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA journal_mode = WAL; CREATE TABLE threads (id TEXT)");
      const inventory = await createMetadataInventory([databasePath], root, home);
      database.exec("INSERT INTO threads VALUES ('new-thread')");
      await expect(assertMetadataInventoryUnchanged(inventory))
        .rejects.toThrow(/Metadata .*changed after preflight/);
      await expect(assertMetadataTargetUnchanged(`${databasePath}-wal`, inventory))
        .rejects.toThrow(new RegExp(`${databasePath}-wal`));
    } finally {
      database.close();
    }
  });

  it("backs up committed WAL content with private file permissions", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(root, { recursive: true });
    const databasePath = path.join(root, "state_5.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
    database.prepare("INSERT INTO threads VALUES (?)").run("thread-wal");
    const walPath = `${databasePath}-wal`;
    expect(await exists(walPath)).toBe(true);

    const inventory = await createMetadataInventory([databasePath], root, home);
    const recovery = await createRecoveryBackup(home, inventory, [databasePath], "codex", ["thread-wal"]);
    expect(recovery).toBeDefined();
    const manifest = JSON.parse(await fs.readFile(recovery!.manifestPath, "utf8")) as {
      files: Array<{ originalPath: string; backupPath: string }>;
    };
    expect(manifest.files[0]?.originalPath).toBe(databasePath);

    const backupPath = manifest.files[0]?.backupPath;
    expect(backupPath).toBeDefined();
    const backedUp = new DatabaseSync(backupPath!, { readOnly: true });
    try {
      expect(backedUp.prepare("SELECT id FROM threads").all()).toEqual([{ id: "thread-wal" }]);
    } finally {
      backedUp.close();
    }
    expect((await fs.stat(recovery!.directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(recovery!.manifestPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(backupPath!)).mode & 0o777).toBe(0o600);

    await removeRecoveryBackup(recovery, mockTrash);
    database.close();
  });

  it("rejects provider roots that escape the trusted fake home through a parent symlink", async () => {
    const home = await makeHome();
    const outside = await makeHome();
    await fs.mkdir(path.join(outside, "antigravity-cli"), { recursive: true });
    await fs.symlink(outside, path.join(home, ".gemini"), "dir");

    await expect(createMetadataInventory(
      [path.join(home, ".gemini", "antigravity-cli", "history.jsonl")],
      path.join(home, ".gemini", "antigravity-cli"),
      home
    )).rejects.toThrow(/Provider root resolves outside the expected location/);
  });

  it("rejects metadata redirected through a symlink to another directory inside the provider root", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(path.join(root, "plugins"), { recursive: true });
    await fs.symlink(path.join(root, "plugins"), path.join(root, "sqlite"), "dir");

    await expect(createMetadataInventory(
      [path.join(root, "sqlite", "codex-dev.db")],
      root,
      home
    )).rejects.toThrow(/Refusing metadata that resolves outside the provider root/);
  });

  it("rejects a recovery root symlink before changing the linked directory permissions", async () => {
    const home = await makeHome();
    const outside = await makeHome();
    const metadataRoot = path.join(home, ".codex");
    await fs.mkdir(metadataRoot, { recursive: true });
    const file = path.join(metadataRoot, "settings.json");
    await fs.writeFile(file, "{}\n");
    const inventory = await createMetadataInventory([file], metadataRoot, home);
    const cleanerRoot = path.join(home, ".ai-cli-cleaner");
    await fs.symlink(outside, cleanerRoot, "dir");
    await fs.chmod(outside, 0o755);

    await expect(createRecoveryBackup(home, inventory, [file], "codex", []))
      .rejects.toThrow(/Recovery path must be a directory owned by the current user with mode 0700/);
    expect((await fs.stat(outside)).mode & 0o777).toBe(0o755);
  });

  it("rehearses JSON changes on a temporary copy and preserves unknown Codex fields and remote hosts", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(path.join(root, "sqlite"), { recursive: true });
    const state = path.join(root, "state_5.sqlite");
    const stateDb = new DatabaseSync(state);
    stateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    stateDb.prepare("INSERT INTO threads VALUES (?, ?)").run("local-thread", "rollout");
    stateDb.close();

    const appDatabase = path.join(root, "sqlite", "codex-dev.db");
    const appDb = new DatabaseSync(appDatabase);
    appDb.exec("CREATE TABLE local_thread_catalog (thread_id TEXT, host_id TEXT)");
    appDb.exec("CREATE TABLE local_app_server_feature_enablement (feature TEXT)");
    appDb.prepare("INSERT INTO local_thread_catalog VALUES (?, ?)").run("local-thread", "local");
    appDb.prepare("INSERT INTO local_thread_catalog VALUES (?, ?)").run("remote-thread", "remote:host");
    appDb.prepare("INSERT INTO local_app_server_feature_enablement VALUES (?)").run("keep");
    appDb.close();

    const globalState = path.join(root, ".codex-global-state.json");
    const source = {
      "pinned-thread-ids": ["local-thread", "remote-thread"],
      "thread-project-assignments": { "local-thread": "project-local", "remote-thread": "project-remote" },
      "app-server-migrated-pinned-thread-ids-by-host": {
        local: ["local-thread"], "remote:host": ["remote-thread"]
      },
      unknown: { "local-thread": "preserve" },
      theme: "dark"
    };
    await fs.writeFile(globalState, `${JSON.stringify(source, null, 2)}\n`);

    const plan = await prepareCodexConversationMetadata(home, mockTrash);
    expect(plan.paths).toEqual(expect.arrayContaining([appDatabase, globalState]));
    expect(plan.paths).not.toContain(state);
    expect(plan.operations.length).toBeGreaterThan(0);
    expect(JSON.parse(await fs.readFile(globalState, "utf8"))).toEqual(source);
    const result = await plan.execute();
    expect(result).toMatchObject({ metadataChanged: true });

    const rewritten = JSON.parse(await fs.readFile(globalState, "utf8")) as Record<string, unknown>;
    expect(rewritten).toMatchObject({
      "pinned-thread-ids": ["remote-thread"],
      "thread-project-assignments": { "remote-thread": "project-remote" },
      "app-server-migrated-pinned-thread-ids-by-host": {
        local: [], "remote:host": ["remote-thread"]
      },
      unknown: { "local-thread": "preserve" },
      theme: "dark"
    });
    const checked = new DatabaseSync(appDatabase, { readOnly: true });
    try {
      expect(checked.prepare("SELECT thread_id, host_id FROM local_thread_catalog").all())
        .toEqual([{ thread_id: "remote-thread", host_id: "remote:host" }]);
      expect(checked.prepare("SELECT feature FROM local_app_server_feature_enablement").all())
        .toEqual([{ feature: "keep" }]);
    } finally {
      checked.close();
    }
    expect(await fs.readdir(path.join(home, ".ai-cli-cleaner", "recovery"))).toEqual([]);
  });

  it("rejects unknown required SQLite schema before any source metadata changes", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(root, { recursive: true });
    const state = path.join(root, "state_5.sqlite");
    const database = new DatabaseSync(state);
    database.exec("CREATE TABLE unknown_threads (id TEXT)");
    database.close();
    const original = await fs.readFile(state);

    await expect(prepareCodexConversationMetadata(home, mockTrash)).rejects.toThrow(/threads/);
    expect(await fs.readFile(state)).toEqual(original);
  });

  it("retains a complete recovery bundle and restores originals after a private rewrite fails", async () => {
    const home = await makeHome();
    const root = path.join(home, ".codex");
    await fs.mkdir(root, { recursive: true });
    const stateDatabase = path.join(root, "state_5.sqlite");
    const state = new DatabaseSync(stateDatabase);
    state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    state.prepare("INSERT INTO threads VALUES (?, ?)").run("selected", "rollout");
    state.close();
    const sessionIndex = path.join(root, "session_index.jsonl");
    const originalIndex = `${JSON.stringify({ id: "selected", thread_name: "selected" })}\n`;
    await fs.writeFile(sessionIndex, originalIndex);
    const globalState = path.join(root, ".codex-global-state.json");
    const originalGlobal = `${JSON.stringify({ "pinned-thread-ids": ["selected"] }, null, 2)}\n`;
    await fs.writeFile(globalState, originalGlobal);
    const plan = await prepareCodexThreadsMetadata(home, {
      stateDatabase,
      sessionIndex,
      globalStateFiles: [globalState]
    }, ["selected"], mockTrash);
    const originalRename = fs.rename;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(destination).endsWith(`-${path.basename(globalState)}`)) throw new Error("simulated metadata write failure");
      return originalRename(source, destination);
    });

    let failure: (Error & { metadataChanged?: boolean; recoveryPath?: string }) | undefined;
    try {
      await plan.execute();
    } catch (error) {
      failure = error as Error & { metadataChanged?: boolean; recoveryPath?: string };
    } finally {
      renameSpy.mockRestore();
    }
    expect(failure?.message).toBe("simulated metadata write failure");
    expect(failure?.metadataChanged).toBe(false);
    expect(failure?.recoveryPath).toBeDefined();
    expect(await fs.readFile(sessionIndex, "utf8")).toBe(originalIndex);
    expect(await fs.readFile(globalState, "utf8")).toBe(originalGlobal);

    const manifestPath = path.join(failure!.recoveryPath!, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      files: Array<{ originalPath: string; backupPath: string }>;
    };
    for (const [file, original] of [[sessionIndex, originalIndex], [globalState, originalGlobal]]) {
      const entry = manifest.files.find((candidate) => candidate.originalPath === file);
      expect(entry).toBeDefined();
      expect(await fs.readFile(entry!.backupPath, "utf8")).toBe(original);
    }
    const stateBackup = manifest.files.find((candidate) => candidate.originalPath === stateDatabase);
    expect(stateBackup).toBeDefined();
    const restoredState = new DatabaseSync(stateBackup!.backupPath, { readOnly: true });
    try {
      expect(restoredState.prepare("SELECT id FROM threads").all()).toEqual([{ id: "selected" }]);
    } finally {
      restoredState.close();
    }
  });

  it("refuses malformed Antigravity metadata during dry-run without touching source files", async () => {
    const home = await makeHome();
    const root = path.join(home, ".gemini", "antigravity-cli");
    await fs.mkdir(path.join(root, "brain"), { recursive: true });
    const history = path.join(root, "history.jsonl");
    await fs.writeFile(history, "{broken-json\n");
    const original = await fs.readFile(history);
    const conversation: ConversationRecord = {
      key: "antigravity:thread-1",
      providerId: "antigravity",
      providerName: "Antigravity",
      id: "thread-1",
      title: "測試",
      sizeBytes: 0,
      dataPaths: [path.join(root, "brain", "thread-1")],
      guardPaths: [],
      deleteStrategy: {
        kind: "local",
        metadata: { kind: "antigravity", historyFile: history }
      },
      warnings: []
    };
    let trashCalled = false;
    const result = await deleteAntigravity([conversation], {
      home,
      dryRun: true,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: async () => { trashCalled = true; }
    });

    expect(result.failures[0]?.error.message).toMatch(/Invalid Antigravity JSONL at line 1/);
    expect(result.previewed).toEqual([]);
    expect(trashCalled).toBe(false);
    expect(await fs.readFile(history)).toEqual(original);
    expect(await exists(path.join(home, ".ai-cli-cleaner"))).toBe(false);
  });
});

async function makeHome(): Promise<string> {
  const directory = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-metadata-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function mockTrash(paths: string[]): Promise<void> {
  for (const file of paths) {
    const directory = path.resolve(file, "../../..", "mock-trash");
    await fs.mkdir(directory, { recursive: true });
    await fs.rename(file, path.join(directory, path.basename(file)));
  }
}
