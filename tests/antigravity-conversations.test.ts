import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteConversations } from "../src/conversations/delete.js";
import { discoverAntigravityConversations } from "../src/conversations/discover-antigravity.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const tempHomes: string[] = [];
const selectedId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((directory) =>
    fixtureTrash(directory, { recursive: true, force: true })
  ));
});

describe("Antigravity conversation cleanup", () => {
  it("discovers exact conversation IDs across CLI and IDE storage", async () => {
    const home = await makeHome();
    const cli = path.join(home, ".gemini", "antigravity-cli");
    const ide = path.join(home, ".gemini", "antigravity-ide");
    await mkdir(path.join(cli, "brain", selectedId), { recursive: true });
    await mkdir(path.join(ide, "brain", otherId), { recursive: true });
    await mkdir(path.join(ide, "html_artifacts"), { recursive: true });
    await writeFile(path.join(cli, "brain", selectedId, "artifact.md"), "selected");
    await writeFile(path.join(ide, "brain", otherId, "artifact.md"), "other");
    await writeFile(path.join(ide, "html_artifacts", `${selectedId}.pb`), "html");
    await writeFile(path.join(cli, "history.jsonl"), JSON.stringify({
      conversationId: selectedId,
      display: "CLI 對話",
      workspace: "/tmp/project",
      timestamp: "2026-09-19T01:00:00.000Z"
    }) + "\n");
    createSummaryDatabase(path.join(cli, "conversation_summaries.db"), [
      [selectedId, "摘要標題"],
      [otherId, "另一個對話"]
    ]);

    const discovery = await discoverAntigravityConversations(home);

    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations.map((conversation) => conversation.id).sort())
      .toEqual([otherId, selectedId].sort());
    const selected = discovery.conversations.find((conversation) => conversation.id === selectedId);
    expect(selected).toMatchObject({
      providerId: "antigravity",
      title: "摘要標題",
      workspace: "/tmp/project"
    });
    expect(selected?.dataPaths).toEqual(expect.arrayContaining([
      path.join(cli, "brain", selectedId),
      path.join(ide, "html_artifacts", `${selectedId}.pb`)
    ]));
  });

  it("keeps Antigravity metadata when the only conversation item is a symlink", async () => {
    const home = await makeHome();
    const cli = path.join(home, ".gemini", "antigravity-cli");
    const outside = path.join(home, "outside-conversation");
    const linked = path.join(cli, "brain", selectedId);
    const historyFile = path.join(cli, "history.jsonl");
    const summaryDatabase = path.join(cli, "conversation_summaries.db");
    await mkdir(path.dirname(linked), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep.md"), "keep");
    await symlink(outside, linked, "dir");
    await writeFile(historyFile, `${JSON.stringify({ conversationId: selectedId, display: "symlink" })}\n`);
    createSummaryDatabase(summaryDatabase, [[selectedId, "symlink"]]);
    const metadataBefore = await Promise.all([historyFile, summaryDatabase].map((file) => readFile(file)));

    const discovery = await discoverAntigravityConversations(home);
    const conversation = discovery.conversations.find((item) => item.id === selectedId);
    expect(conversation?.disabledReason).toMatch(/symbolic link/);
    expect(conversation?.dataPaths).not.toContain(linked);

    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations([conversation!], {
      home,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash
    });
    expect(result.deleted).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
    expect(await Promise.all([historyFile, summaryDatabase].map((file) => readFile(file))))
      .toEqual(metadataBefore);
    await expect(readFile(path.join(outside, "keep.md"), "utf8")).resolves.toBe("keep");
  });

  it("disables mixed safe and symlinked Antigravity paths before metadata deletion", async () => {
    const home = await makeHome();
    const cli = path.join(home, ".gemini", "antigravity-cli");
    const safePath = path.join(cli, "brain", selectedId);
    const linked = path.join(cli, "html_artifacts", `${selectedId}.pb`);
    const outside = path.join(home, "outside-artifact.pb");
    const historyFile = path.join(cli, "history.jsonl");
    const summaryDatabase = path.join(cli, "conversation_summaries.db");
    await mkdir(safePath, { recursive: true });
    await mkdir(path.dirname(linked), { recursive: true });
    await writeFile(path.join(safePath, "artifact.md"), "keep");
    await writeFile(outside, "outside");
    await symlink(outside, linked);
    await writeFile(historyFile, `${JSON.stringify({ conversationId: selectedId, display: "mixed" })}\n`);
    createSummaryDatabase(summaryDatabase, [[selectedId, "mixed"]]);
    const metadataBefore = await Promise.all([historyFile, summaryDatabase].map((file) => readFile(file)));

    const discovery = await discoverAntigravityConversations(home);
    const conversation = discovery.conversations.find((item) => item.id === selectedId);
    expect(conversation?.disabledReason).toMatch(/symbolic link/);
    expect(conversation?.dataPaths).toContain(safePath);
    expect(conversation?.dataPaths).not.toContain(linked);

    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations([conversation!], {
      home,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash
    });
    expect(result.deleted).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
    expect(await Promise.all([historyFile, summaryDatabase].map((file) => readFile(file))))
      .toEqual(metadataBefore);
    await expect(readFile(path.join(safePath, "artifact.md"), "utf8")).resolves.toBe("keep");
  });

  it("keeps metadata when an Antigravity item disappears after enumeration", async () => {
    const home = await makeHome();
    const cli = path.join(home, ".gemini", "antigravity-cli");
    const dataPath = path.join(cli, "brain", selectedId);
    const historyFile = path.join(cli, "history.jsonl");
    const summaryDatabase = path.join(cli, "conversation_summaries.db");
    await mkdir(dataPath, { recursive: true });
    await writeFile(historyFile, `${JSON.stringify({ conversationId: selectedId, display: "vanishing" })}\n`);
    createSummaryDatabase(summaryDatabase, [[selectedId, "vanishing"]]);
    const metadataBefore = await Promise.all([historyFile, summaryDatabase].map((file) => readFile(file)));
    const originalLstat = fs.lstat.bind(fs);
    let removed = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation((async (target: string) => {
      const info = await originalLstat(target);
      if (target === dataPath && !removed) {
        removed = true;
        await fixtureTrash(dataPath, { recursive: true, force: true });
      }
      return info;
    }) as typeof fs.lstat);

    let discovery: Awaited<ReturnType<typeof discoverAntigravityConversations>>;
    try {
      discovery = await discoverAntigravityConversations(home);
    } finally {
      lstatSpy.mockRestore();
    }
    expect(removed).toBe(true);
    const conversation = discovery.conversations.find((item) => item.id === selectedId);
    expect(conversation?.disabledReason).toMatch(/disappeared before safety validation/);
    expect(conversation?.dataPaths).toEqual([]);

    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations([conversation!], {
      home,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash
    });
    expect(result.deleted).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
    expect(await Promise.all([historyFile, summaryDatabase].map((file) => readFile(file))))
      .toEqual(metadataBefore);
  });

  it("preserves deletion of a valid metadata-only Antigravity orphan", async () => {
    const home = await makeHome();
    const cli = path.join(home, ".gemini", "antigravity-cli");
    const historyFile = path.join(cli, "history.jsonl");
    const summaryDatabase = path.join(cli, "conversation_summaries.db");
    await mkdir(cli, { recursive: true });
    await writeFile(historyFile, `${JSON.stringify({ conversationId: selectedId, display: "orphan" })}\n`);
    createSummaryDatabase(summaryDatabase, [[selectedId, "orphan"]]);

    const discovery = await discoverAntigravityConversations(home);
    const conversation = discovery.conversations.find((item) => item.id === selectedId);
    expect(conversation?.dataPaths).toEqual([]);
    expect(conversation?.disabledReason).toBeUndefined();

    const backupTrash = path.join(home, "trashed-backup");
    const trash = vi.fn(async (files: string[]) => {
      expect(files).toHaveLength(1);
      expect(path.dirname(files[0]!)).toBe(path.join(home, ".ai-cli-cleaner", "recovery"));
      await fs.rename(files[0]!, backupTrash);
    });
    const result = await deleteConversations([conversation!], {
      home,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash
    });
    expect(result.failures).toEqual([]);
    expect(result.deleted.map((item) => item.id)).toEqual([selectedId]);
    expect(trash).toHaveBeenCalledOnce();
    await expect(readFile(path.join(backupTrash, "manifest.json"), "utf8")).resolves.toContain(selectedId);
    expect(result.openFileCheckUnsupported).toBeUndefined();
    const database = new DatabaseSync(summaryDatabase, { readOnly: true });
    try {
      expect(database.prepare("SELECT conversation_id FROM conversation_summaries").all()).toEqual([]);
    } finally {
      database.close();
    }
    await expect(readFile(historyFile, "utf8")).resolves.toBe("");
  });

  it("deletes only the selected ID and preserves every other conversation", async () => {
    const home = await makeHome();
    const cli = path.join(home, ".gemini", "antigravity-cli");
    const ide = path.join(home, ".gemini", "antigravity-ide");
    for (const base of [cli, ide]) {
      for (const id of [selectedId, otherId]) {
        await mkdir(path.join(base, "brain", id), { recursive: true });
        await writeFile(path.join(base, "brain", id, "artifact.md"), id);
      }
    }
    await mkdir(path.join(cli, "cache"), { recursive: true });
    await writeFile(path.join(cli, "history.jsonl"), [
      JSON.stringify({ conversationId: selectedId, display: "刪除" }),
      JSON.stringify({ unrelated: "保留未識別欄位" }),
      JSON.stringify({ conversationId: otherId, display: "保留" })
    ].join("\n") + "\n");
    await writeFile(path.join(cli, "cache", "last_conversations.json"), JSON.stringify({
      "/tmp/selected": selectedId,
      "/tmp/other": otherId,
      unknown: { keep: true }
    }, null, 2));
    const summaryDatabase = path.join(cli, "conversation_summaries.db");
    createSummaryDatabase(summaryDatabase, [
      [selectedId, "刪除"],
      [otherId, "保留"]
    ]);
    const discovery = await discoverAntigravityConversations(home);
    const selected = discovery.conversations.find((conversation) => conversation.id === selectedId);
    expect(selected).toBeDefined();

    const result = await deleteConversations([selected!], {
      home,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: async (paths) => {
        for (const entry of paths) await fixtureTrash(entry, { recursive: true, force: true });
      }
    });

    expect(result.failures).toEqual([]);
    expect(result.deleted.map((conversation) => conversation.id)).toEqual([selectedId]);
    for (const base of [cli, ide]) {
      await expect(readFile(path.join(base, "brain", selectedId, "artifact.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(base, "brain", otherId, "artifact.md"), "utf8"))
        .resolves.toBe(otherId);
    }
    const database = new DatabaseSync(summaryDatabase, { readOnly: true });
    try {
      expect(database.prepare("SELECT conversation_id FROM conversation_summaries ORDER BY conversation_id").all())
        .toEqual([{ conversation_id: otherId }]);
    } finally {
      database.close();
    }
    expect(await readFile(path.join(cli, "history.jsonl"), "utf8"))
      .toBe(`${JSON.stringify({ unrelated: "保留未識別欄位" })}\n${JSON.stringify({ conversationId: otherId, display: "保留" })}\n`);
    expect(JSON.parse(await readFile(path.join(cli, "cache", "last_conversations.json"), "utf8")))
      .toEqual({ "/tmp/other": otherId, unknown: { keep: true } });
  });

  it("discovers and deletes cache-only IDs while preserving unrelated cache values", async () => {
    const home = await makeHome();
    const cache = path.join(home, ".gemini", "antigravity-cli", "cache", "last_conversations.json");
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, JSON.stringify({ selected: selectedId, retained: otherId, unknown: { keep: true } }));

    const discovery = await discoverAntigravityConversations(home);
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations.map((item) => item.id).sort()).toEqual([selectedId, otherId]);
    const selected = discovery.conversations.find((item) => item.id === selectedId)!;
    const result = await deleteConversations([selected], {
      home,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: async (files) => {
        for (const file of files) await fixtureTrash(file, { recursive: true, force: true });
      }
    });

    expect(result.failures).toEqual([]);
    expect(result.deleted.map((item) => item.id)).toEqual([selectedId]);
    expect(JSON.parse(await readFile(cache, "utf8"))).toEqual({ retained: otherId, unknown: { keep: true } });
    expect((await discoverAntigravityConversations(home)).conversations.map((item) => item.id)).toEqual([otherId]);
  });

  it("removes exact selected conversation rows from related summary tables", async () => {
    const home = await makeHome();
    const root = path.join(home, ".gemini", "antigravity-cli");
    await mkdir(root, { recursive: true });
    const file = path.join(root, "conversation_summaries.db");
    createSummaryDatabase(file, [[selectedId, "remove"], [otherId, "keep"]]);
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE conversation_notes (conversation_id TEXT REFERENCES conversation_summaries(conversation_id), body TEXT, sequence INTEGER, data BLOB)");
    const insert = database.prepare("INSERT INTO conversation_notes VALUES (?, ?, ?, ?)");
    insert.run(selectedId, "remove", 1n, Buffer.from([1]));
    insert.run(otherId, selectedId, 9223372036854775807n, Buffer.from([0, 255, 42]));
    database.close();
    const selected = (await discoverAntigravityConversations(home)).conversations.find((item) => item.id === selectedId)!;
    const result = await deleteConversations([selected], {
      home,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: async (files) => {
        for (const item of files) await fixtureTrash(item, { recursive: true, force: true });
      }
    });

    expect(result.failures).toEqual([]);
    expect(result.deleted.map((item) => item.id)).toEqual([selectedId]);
    const checked = new DatabaseSync(file, { readOnly: true });
    try {
      const query = checked.prepare("SELECT * FROM conversation_notes");
      query.setReadBigInts(true);
      expect(query.all()).toEqual([{ conversation_id: otherId, body: selectedId,
        sequence: 9223372036854775807n, data: new Uint8Array([0, 255, 42]) }]);
      expect(checked.prepare("SELECT conversation_id FROM conversation_summaries").all()).toEqual([{ conversation_id: otherId }]);
      expect(checked.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { checked.close(); }
  });

  it("discovers IDs found only in related summary tables", async () => {
    const home = await makeHome();
    const root = path.join(home, ".gemini", "antigravity-cli");
    await mkdir(root, { recursive: true });
    const file = path.join(root, "conversation_summaries.db");
    createSummaryDatabase(file, []);
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE conversation_notes (conversation_id TEXT, body TEXT)");
    database.prepare("INSERT INTO conversation_notes VALUES (?, ?)").run(selectedId, "orphan content");
    database.close();

    const discovery = await discoverAntigravityConversations(home);
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations.map((item) => item.id)).toEqual([selectedId]);
    expect(discovery.conversations[0]?.disabledReason).toBeUndefined();
  });

  it.each(["{broken", "[]"])("disables selected deletion when the recent cache is unreadable: %s", async (contents) => {
    const home = await makeHome();
    const root = path.join(home, ".gemini", "antigravity-cli");
    await mkdir(path.join(root, "cache"), { recursive: true });
    const history = path.join(root, "history.jsonl");
    const cache = path.join(root, "cache", "last_conversations.json");
    const historyContents = `${JSON.stringify({ conversationId: selectedId })}\n`;
    await writeFile(history, historyContents);
    await writeFile(cache, contents);

    const discovery = await discoverAntigravityConversations(home);
    const selected = discovery.conversations[0]!;
    expect(selected.disabledReason).toMatch(/Cannot read Antigravity recent-conversation metadata/);
    const result = await deleteConversations([selected], {
      home,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: async () => { throw new Error("Unexpected fixture Trash"); }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(await readFile(cache, "utf8")).toBe(contents);
    expect(await readFile(history, "utf8")).toBe(historyContents);
  });

  it("does not mutate files during a dry run", async () => {
    const home = await makeHome();
    const root = path.join(home, ".gemini", "antigravity-cli");
    const dataPath = path.join(root, "brain", selectedId);
    const artifact = path.join(dataPath, "artifact.md");
    const historyFile = path.join(root, "history.jsonl");
    const summaryDatabase = path.join(root, "conversation_summaries.db");
    await mkdir(dataPath, { recursive: true });
    await writeFile(artifact, "保留對話產物");
    await writeFile(historyFile, JSON.stringify({ conversationId: selectedId }) + "\n");
    createSummaryDatabase(summaryDatabase, [[selectedId, "保留摘要"]]);
    const before = await Promise.all([artifact, historyFile, summaryDatabase].map((file) => readFile(file)));
    const conversation = {
      key: `antigravity:${selectedId}`,
      providerId: "antigravity" as const,
      providerName: "Google Antigravity",
      id: selectedId,
      title: "測試",
      sizeBytes: 1,
      dataPaths: [dataPath],
      guardPaths: [],
      deleteStrategy: {
        kind: "local" as const,
        metadata: { kind: "antigravity" as const, historyFile, summaryDatabase }
      },
      warnings: []
    };
    const trash = vi.fn(async () => undefined);
    const result = await deleteConversations([conversation], {
      home,
      dryRun: true,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash
    });
    expect(result.previewed).toEqual([conversation]);
    expect(result.failures).toEqual([]);
    expect(trash).not.toHaveBeenCalled();
    expect(await Promise.all([artifact, historyFile, summaryDatabase].map((file) => readFile(file)))).toEqual(before);
  });

  it.each([false, true])("continues a mixed-provider batch after an unsupported Antigravity check (dryRun=%s)", async (dryRun) => {
    const fixture = await mixedFixture();
    const trash = movingTrash(fixture.home);
    let checks = 0;
    const result = await deleteConversations([fixture.antigravity, fixture.copilot], {
      home: fixture.home, dryRun, trash,
      checkOpenPaths: async () => ({ supported: ++checks !== 1, openPaths: [] })
    });
    expect(result.openFileCheckUnsupported).toBe(true);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.conversation).toBe(fixture.antigravity);
    expect(result.failures[0]?.error.message).toMatch(/Cannot check whether files are open/);
    expect(dryRun ? result.previewed : result.deleted).toEqual([fixture.copilot]);
    expect(await readFile(fixture.artifact, "utf8")).toBe("selected artifact");
    if (dryRun) expect(trash).not.toHaveBeenCalled();
    else await expect(fs.lstat(fixture.copilot.dataPaths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves Antigravity partial-failure details and continues to another provider", async () => {
    const fixture = await mixedFixture();
    const move = movingTrash(fixture.home);
    const brain = await fs.realpath(path.dirname(fixture.artifact));
    const result = await deleteConversations([fixture.antigravity, fixture.copilot], {
      home: fixture.home, checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: async (files) => {
        await move(files);
        if (files.includes(brain)) await fs.appendFile(fixture.history, `${JSON.stringify({ conversationId: otherId })}\n`);
      }
    });
    expect(result.deleted).toEqual([fixture.copilot]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.conversation).toBe(fixture.antigravity);
    expect(result.failures[0]?.deletedPaths).toEqual([brain]);
    expect(result.failures[0]?.metadataChanged).toBe(false);
    expect(result.failures[0]?.recoveryPath).toBeTruthy();
    await expect(fs.lstat(path.join(result.failures[0]!.recoveryPath!, "manifest.json"))).resolves.toBeDefined();
    const database = new DatabaseSync(fixture.database, { readOnly: true });
    try { expect(database.prepare("SELECT conversation_id FROM conversation_summaries").all())
      .toEqual([{ conversation_id: selectedId }]); }
    finally { database.close(); }
  });
});

async function mixedFixture() {
  const home = await makeHome();
  const root = path.join(home, ".gemini", "antigravity-cli");
  const artifact = path.join(root, "brain", selectedId, "artifact.md");
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, "selected artifact");
  const history = path.join(root, "history.jsonl");
  await writeFile(history, `${JSON.stringify({ conversationId: selectedId, display: "selected" })}\n`);
  const database = path.join(root, "conversation_summaries.db");
  createSummaryDatabase(database, [[selectedId, "selected"]]);
  const antigravity = (await discoverAntigravityConversations(home)).conversations[0]!;
  const directory = path.join(home, ".copilot", "session-state", "copilot-selected");
  await fs.mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "events.jsonl"), "copilot fixture transcript");
  const copilot: ConversationRecord = {
    key: "copilot:copilot-selected", providerId: "copilot", providerName: "Copilot", id: "copilot-selected", title: "copilot-selected",
    sizeBytes: 1, dataPaths: [directory], guardPaths: [], warnings: [],
    deleteStrategy: { kind: "local", metadata: { kind: "copilot" } }
  };
  return { home, artifact, history, database, antigravity, copilot };
}

function movingTrash(home: string) {
  let moved = 0;
  return vi.fn(async (files: string[]) => {
    const directory = path.join(home, "mock-trash");
    await fs.mkdir(directory, { recursive: true });
    for (const file of files) await fs.rename(file, path.join(directory, String(moved++)));
  });
}

async function makeHome(): Promise<string> {
  const home = await fixtureTemp(path.join(tmpdir(), "antigravity-cleaner-"));
  tempHomes.push(home);
  return home;
}

function createSummaryDatabase(file: string, rows: Array<[string, string]>): void {
  const database = new DatabaseSync(file);
  try {
    database.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        last_modified_time TEXT,
        workspace_uris TEXT
      )
    `);
    const insert = database.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, '', '2026-09-19T00:00:00.000Z', NULL)"
    );
    for (const row of rows) insert.run(...row);
  } finally {
    database.close();
  }
}
