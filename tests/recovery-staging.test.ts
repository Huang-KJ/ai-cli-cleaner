import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClean } from "../src/cleaners/plan.js";
import type { ProviderId } from "../src/cleaners/types.js";
import { deleteConversations } from "../src/conversations/delete.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const homes: string[] = [];
const providers: ProviderId[] = ["codex", "copilot", "antigravity", "opencode", "grok"];
const closed = async () => ({ supported: true, openPaths: [] as string[] });

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

interface RecoveryManifest {
  files: Array<{ originalPath: string; backupPath: string; sha256: string }>;
}

async function fixture(provider: ProviderId) {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-staging-")));
  homes.push(home);
  const id = "selected";
  const root = provider === "antigravity" ? path.join(home, ".gemini", "antigravity-cli")
    : provider === "opencode" ? path.join(home, ".local", "share", "opencode")
      : path.join(home, `.${provider}`);
  await fs.mkdir(root, { recursive: true });
  const metadata: string[] = [];
  let data: string;
  let strategy: ConversationRecord["deleteStrategy"];
  if (provider === "codex") {
    data = path.join(root, "sessions", `${id}.jsonl`);
    await fs.mkdir(path.dirname(data));
    await fs.writeFile(data, JSON.stringify({ payload: { id } }) + "\n");
    const database = path.join(root, "state_5.sqlite");
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    db.prepare("INSERT INTO threads VALUES (?, ?)").run(id, data);
    db.close();
    const index = path.join(root, "session_index.jsonl");
    await fs.writeFile(index, JSON.stringify({ id }) + "\n");
    metadata.push(database, index);
    strategy = { kind: "local", metadata: { kind: "codex", stateDatabase: database, sessionIndex: index } };
  } else if (provider === "copilot") {
    data = path.join(root, "session-state", id);
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, "events.jsonl"), "selected transcript\n");
    const database = path.join(root, "session-store.db");
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('selected')");
    db.close();
    metadata.push(database);
    strategy = { kind: "local", metadata: { kind: "copilot", sessionStoreDatabase: database } };
  } else if (provider === "antigravity") {
    data = path.join(root, "brain", id);
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, "artifact.md"), "selected artifact\n");
    const database = path.join(root, "conversation_summaries.db");
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY); INSERT INTO conversation_summaries VALUES ('selected')");
    db.close();
    const history = path.join(root, "history.jsonl");
    await fs.writeFile(history, JSON.stringify({ conversationId: id }) + "\n");
    metadata.push(database, history);
    strategy = { kind: "local", metadata: { kind: "antigravity", summaryDatabase: database, historyFile: history } };
  } else if (provider === "opencode") {
    data = path.join(root, "storage", "session_diff", `${id}.json`);
    await fs.mkdir(path.dirname(data), { recursive: true });
    await fs.writeFile(data, "[]\n");
    const database = path.join(root, "opencode.db");
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT);
      INSERT INTO session VALUES ('selected', NULL);`);
    db.close();
    metadata.push(database);
    strategy = { kind: "indexed" };
  } else {
    data = path.join(root, "sessions", "group", id);
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, "summary.json"), JSON.stringify({ info: { id } }));
    await fs.writeFile(path.join(data, "updates.jsonl"), "selected transcript\n");
    const active = path.join(root, "active_sessions.json");
    await fs.writeFile(active, JSON.stringify([{ session_id: id, pid: 2147483647, cwd: "/fixtures", opened_at: "2026-10-05" }]));
    metadata.push(active);
    strategy = { kind: "indexed" };
  }
  const originals = await Promise.all(metadata.map((file) => fs.readFile(file)));
  const conversation: ConversationRecord = {
    key: `${provider}:${id}`, providerId: provider, providerName: provider, id, title: id,
    sizeBytes: 1, dataPaths: provider === "opencode" ? [] : [data], guardPaths: [],
    warnings: [], deleteStrategy: strategy
  };
  return { home, metadata, originals, data, conversation };
}

async function bundles(home: string): Promise<string[]> {
  const root = path.join(home, ".ai-cli-cleaner", "recovery");
  return (await fs.readdir(root)).map((name) => path.join(root, name));
}

async function readManifest(directory: string): Promise<RecoveryManifest> {
  return JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as RecoveryManifest;
}

describe("recovery staging before source Trash", () => {
  for (const provider of providers) {
    it.each(["file", "symlink"])(`${provider} rejects a recovery root %s before any source movement`, async (kind) => {
      const item = await fixture(provider);
      const root = path.join(item.home, ".ai-cli-cleaner");
      await fs.mkdir(root);
      const recovery = path.join(root, "recovery");
      if (kind === "file") await fs.writeFile(recovery, "keep recovery obstacle");
      else await fs.symlink(item.home, recovery, "dir");
      const trash = vi.fn(async () => undefined);
      const result = await deleteConversations([item.conversation], { home: item.home, trash, checkOpenPaths: closed });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error.message).toMatch(/Recovery/);
      expect(trash).not.toHaveBeenCalled();
      await expect(fs.lstat(item.data)).resolves.toBeDefined();
      expect(await Promise.all(item.metadata.map((file) => fs.readFile(file)))).toEqual(item.originals);
    });

    it(`${provider} stages the complete manifest before a source Trash failure`, async () => {
      const item = await fixture(provider);
      const trash = vi.fn(async () => { throw new Error("source Trash failed"); });
      const result = await deleteConversations([item.conversation], { home: item.home, trash, checkOpenPaths: closed });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error.message).toContain("source Trash failed");
      const recovery = result.failures[0]?.recoveryPath;
      expect(recovery).toBeDefined();
      const manifest = await readManifest(recovery!);
      expect(manifest.files.map((file) => file.originalPath).sort()).toEqual([...item.metadata].sort());
      for (const file of manifest.files) {
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        await expect(fs.readFile(file.backupPath)).resolves.toBeDefined();
      }
      await expect(fs.lstat(item.data)).resolves.toBeDefined();
      expect(await Promise.all(item.metadata.map((file) => fs.readFile(file)))).toEqual(item.originals);
      expect(await bundles(item.home)).toEqual([recovery]);
    });

    it(`${provider} reuses exactly one staged bundle on success`, async () => {
      const item = await fixture(provider);
      const staged: string[] = [];
      const moved: string[] = [];
      const trash = async (files: string[]) => {
        if (files.includes(await fs.realpath(item.data).catch(() => item.data))) {
          const current = await bundles(item.home);
          expect(current).toHaveLength(1);
          staged.push(...current);
          const manifest = await readManifest(current[0]!);
          expect(manifest.files.map((file) => file.originalPath).sort()).toEqual([...item.metadata].sort());
        }
        for (const file of files) {
          const target = path.join(item.home, "trash", String(moved.length));
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.rename(file, target);
          moved.push(file);
        }
      };
      const result = await deleteConversations([item.conversation], { home: item.home, trash, checkOpenPaths: closed });
      expect(result.failures).toEqual([]);
      expect(result.deleted).toHaveLength(1);
      expect(staged).toHaveLength(1);
      expect(moved.filter((file) => file.includes("/.ai-cli-cleaner/recovery/"))).toEqual(staged);
      expect(await bundles(item.home)).toEqual([]);
    });
  }

  it.each(["codex", "copilot", "antigravity", "grok"] as const)("%s skips recovery staging when metadata does not change", async (provider) => {
    const item = await fixture(provider);
    if (provider === "grok") await fs.writeFile(item.metadata[0]!, "[]\n");
    else {
      const database = new DatabaseSync(item.metadata[0]!);
      const table = provider === "codex" ? "threads" : provider === "copilot" ? "sessions" : "conversation_summaries";
      try {
        database.exec(`DELETE FROM ${table}`);
      } finally {
        database.close();
      }
      if (item.metadata[1]) await fs.writeFile(item.metadata[1], "");
    }
    const before = await Promise.all(item.metadata.map((file) => fs.readFile(file)));
    await fs.mkdir(path.join(item.home, ".ai-cli-cleaner"));
    const obstacle = path.join(item.home, ".ai-cli-cleaner", "recovery");
    await fs.writeFile(obstacle, "unused recovery obstacle");
    const trash = vi.fn(async (files: string[]) => {
      expect(files).toEqual([item.data]);
      await fs.rename(item.data, path.join(item.home, "trashed-source"));
    });
    const result = await deleteConversations([item.conversation], { home: item.home, trash, checkOpenPaths: closed });
    expect(result.failures).toEqual([]);
    expect(result.deleted).toHaveLength(1);
    expect(trash).toHaveBeenCalledTimes(1);
    expect(await Promise.all(item.metadata.map((file) => fs.readFile(file)))).toEqual(before);
    expect(await fs.readFile(obstacle, "utf8")).toBe("unused recovery obstacle");
  });

  it("bulk Codex refuses a recovery obstacle before moving any rollout", async () => {
    const item = await fixture("codex");
    const global = path.join(item.home, ".codex", ".codex-global-state.json");
    const contents = JSON.stringify({ "pinned-thread-ids": [item.conversation.id] });
    await fs.writeFile(global, contents);
    await fs.mkdir(path.join(item.home, ".ai-cli-cleaner"));
    await fs.writeFile(path.join(item.home, ".ai-cli-cleaner", "recovery"), "obstacle");
    const trash = vi.fn(async () => undefined);
    const plan = await prepareClean(["codex"], { home: item.home, trash, checkOpenPaths: closed });
    await expect(plan.execute()).rejects.toThrow(/Recovery/);
    expect(trash).not.toHaveBeenCalled();
    await expect(fs.readFile(item.data, "utf8")).resolves.toContain(item.conversation.id);
    expect(await fs.readFile(global, "utf8")).toBe(contents);
  });

  it("bulk Codex reports its staged backup when moving source data fails", async () => {
    const item = await fixture("codex");
    const global = path.join(item.home, ".codex", ".codex-global-state.json");
    const contents = JSON.stringify({ "pinned-thread-ids": [item.conversation.id] });
    await fs.writeFile(global, contents);
    const trash = vi.fn(async () => { throw new Error("bulk source Trash failed"); });
    const plan = await prepareClean(["codex"], { home: item.home, trash, checkOpenPaths: closed });
    const result = await plan.execute();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toContain("bulk source Trash failed");
    const recovery = result.failures[0]?.recoveryPath;
    expect(recovery).toBeDefined();
    expect((await readManifest(recovery!)).files.map((file) => file.originalPath)).toEqual([global]);
    expect(await fs.readFile(global, "utf8")).toBe(contents);
    await expect(fs.readFile(item.data, "utf8")).resolves.toContain(item.conversation.id);
  });

  it("bulk Codex does not report a trashed recovery path when its final check fails", async () => {
    const item = await fixture("codex");
    const global = path.join(item.home, ".codex", ".codex-global-state.json");
    await fs.writeFile(global, JSON.stringify({ "pinned-thread-ids": [item.conversation.id] }));
    let count = 0;
    const movedBundles: string[] = [];
    const trash = async (files: string[]) => {
      for (const file of files) {
        const target = path.join(item.home, "trash", String(count++));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(file, target);
        if (file.includes("/.ai-cli-cleaner/recovery/")) {
          movedBundles.push(file);
          await fs.mkdir(path.dirname(item.data), { recursive: true });
          await fs.writeFile(item.data, "new rollout after cleanup");
        }
      }
    };
    const plan = await prepareClean(["codex"], { home: item.home, trash, checkOpenPaths: closed });
    const result = await plan.execute();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toMatch(/Conversation data remains:/);
    expect(result.failures[0]?.recoveryPath).toBeUndefined();
    expect(movedBundles).toHaveLength(1);
    await expect(fs.lstat(movedBundles[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(item.data, "utf8")).toBe("new rollout after cleanup");
  });

  it("Antigravity reports the bundle directory when writing its manifest fails", async () => {
    const item = await fixture("antigravity");
    const write = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/manifest.json")) throw new Error("manifest write failed");
      return write(...args);
    });
    const trash = vi.fn(async () => undefined);
    try {
      const result = await deleteConversations([item.conversation], { home: item.home, trash, checkOpenPaths: closed });
      expect(result.failures[0]?.error.message).toBe("manifest write failed");
      const recovery = result.failures[0]?.recoveryPath;
      expect(recovery).toBeDefined();
      expect(await bundles(item.home)).toEqual([recovery]);
      expect(await fs.readdir(recovery!)).toHaveLength(item.metadata.length);
      expect(trash).not.toHaveBeenCalled();
      await expect(fs.lstat(item.data)).resolves.toBeDefined();
      expect(await Promise.all(item.metadata.map((file) => fs.readFile(file)))).toEqual(item.originals);
    } finally {
      spy.mockRestore();
    }
  });

  it("Antigravity refuses paths added during staging before the first source Trash", async () => {
    const item = await fixture("antigravity");
    const added = path.join(item.home, ".gemini", "antigravity-cli", "conversations", "selected.pb");
    const write = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await write(...args);
      if (String(args[0]).endsWith("/manifest.json")) {
        await fs.mkdir(path.dirname(added), { recursive: true });
        await write(added, "new selected artifact");
      }
    });
    const trash = vi.fn(async () => undefined);
    try {
      const result = await deleteConversations([item.conversation], { home: item.home, trash, checkOpenPaths: closed });
      expect(result.failures[0]?.error.message).toMatch(/added or removed after discovery/);
      const recovery = result.failures[0]?.recoveryPath;
      expect(recovery).toBeDefined();
      expect((await readManifest(recovery!)).files.map((file) => file.originalPath).sort()).toEqual([...item.metadata].sort());
      expect(trash).not.toHaveBeenCalled();
      await expect(fs.lstat(item.data)).resolves.toBeDefined();
      expect(await fs.readFile(added, "utf8")).toBe("new selected artifact");
      expect(await Promise.all(item.metadata.map((file) => fs.readFile(file)))).toEqual(item.originals);
    } finally {
      spy.mockRestore();
    }
  });
});
