import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { getCodexMetadataPaths } from "../src/conversations/codex-paths.js";
import { validateCodexArtifactPath } from "../src/conversations/owned-paths.js";
import { assertConversationId, type ConversationRecord } from "../src/conversations/types.js";
import { assertMetadataInventoryUnchanged, createMetadataInventory } from "../src/conversations/metadata-safety.js";

const homes: string[] = [];
const selected = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const closed = async () => ({ supported: true, openPaths: [] as string[] });
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});

async function homeFixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-security-ownership-")));
  homes.push(home);
  return home;
}

async function codexFixture(id: string) {
  const home = await homeFixture();
  const root = path.join(home, ".codex");
  const metadata = getCodexMetadataPaths(home);
  await fs.mkdir(path.join(root, "sessions"), { recursive: true });
  const database = new DatabaseSync(metadata.stateDatabase);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
  database.prepare("INSERT INTO threads VALUES (?, NULL)").run(id);
  database.close();
  await fs.writeFile(metadata.sessionIndex, `${JSON.stringify({ id, thread_name: id })}\n`);
  return { home, root, metadata };
}

function movingTrash(home: string) {
  let count = 0;
  return async (files: string[]) => {
    const directory = path.join(home, "moved");
    await fs.mkdir(directory, { recursive: true });
    for (const file of files) await fs.rename(file, path.join(directory, String(count++)));
  };
}

describe("security ownership boundaries", () => {
  it("rejects a visualization year container before discovery or forged deletion can own it", async () => {
    const item = await codexFixture("2026");
    const year = path.join(item.root, "visualizations", "2026");
    const retained = path.join(year, "10", "16", other, "keep.txt");
    await fs.mkdir(path.dirname(retained), { recursive: true });
    await fs.writeFile(retained, "unselected artifact");
    const check = await validateCodexArtifactPath(year, "2026", item.home);
    expect(check.status).toBe("invalid");
    const discovery = await discoverConversations(["codex"], { home: item.home });
    const conversation = discovery.conversations.find((row) => row.id === "2026")!;
    expect(conversation.disabledReason).toMatch(/year|container|structur/i);
    expect(conversation.dataPaths).not.toContain(year);
    const result = await deleteConversations([{ ...conversation, dataPaths: [year], disabledReason: undefined }], {
      home: item.home, checkOpenPaths: closed, trash: movingTrash(item.home)
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    await expect(fs.readFile(retained, "utf8")).resolves.toBe("unselected artifact");
  });

  it("retains ordinary direct and dated artifacts and numeric IDs in other providers", async () => {
    const item = await codexFixture(selected);
    const direct = path.join(item.root, "visualizations", selected);
    const dated = path.join(item.root, "visualizations", "2026", "10", "16", selected);
    await fs.mkdir(direct, { recursive: true });
    await fs.mkdir(dated, { recursive: true });
    expect((await validateCodexArtifactPath(direct, selected, item.home)).status).toBe("valid");
    expect((await validateCodexArtifactPath(dated, selected, item.home)).status).toBe("valid");
    expect(() => assertConversationId("2026")).not.toThrow();
  });

  it.each([".db", ".db-wal", ".db-shm", ".db-journal"])("refuses hard-linked SQLite metadata %s at inventory", async (suffix) => {
    const home = await homeFixture();
    const root = path.join(home, ".provider");
    await fs.mkdir(root);
    const outside = path.join(home, "unselected");
    await fs.writeFile(outside, "synthetic bytes");
    await fs.link(outside, path.join(root, `index${suffix}`));
    await expect(createMetadataInventory([path.join(root, "index.db")], root, home))
      .rejects.toThrow(/hard.link|link count/i);
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("synthetic bytes");
  });

  it.each([false, true].flatMap((live) => ["", "-wal", "-shm", "-journal"].map((suffix) => [live, suffix] as const)))
  ("rejects a newly hard-linked SQLite group on revalidation (live=%s suffix=%s)", async (liveSqlite, suffix) => {
    const home = await homeFixture();
    const root = path.join(home, ".provider");
    await fs.mkdir(root);
    const file = path.join(root, `index.db${suffix}`);
    await fs.writeFile(file, "synthetic bytes");
    const inventory = await createMetadataInventory([path.join(root, "index.db")], root, home, { liveSqlite });
    await fs.link(file, path.join(home, "unselected"));
    await expect(assertMetadataInventoryUnchanged(inventory)).rejects.toThrow(/hard.link|link count/i);
  });

  it("refuses conflicting Antigravity history aliases before moving selected data", async () => {
    const home = await homeFixture();
    const root = path.join(home, ".gemini", "antigravity-cli");
    const data = path.join(root, "brain", selected);
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, "keep.txt"), "selected data remains on refusal");
    const history = path.join(root, "history.jsonl");
    const text = `${JSON.stringify({ conversationId: selected })}\n${JSON.stringify({ conversationId: other, conversation_id: selected })}\n`;
    await fs.writeFile(history, text);
    const conversation: ConversationRecord = {
      key: `antigravity:${selected}`, providerId: "antigravity", providerName: "Antigravity", id: selected,
      title: "synthetic", sizeBytes: 1, dataPaths: [data], guardPaths: [], warnings: [],
      deleteStrategy: { kind: "local", metadata: { kind: "antigravity", historyFile: history } }
    };
    const result = await deleteConversations([conversation], { home, checkOpenPaths: closed, trash: movingTrash(home) });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(/ID fields do not match/);
    await expect(fs.readFile(history, "utf8")).resolves.toBe(text);
    await expect(fs.readFile(path.join(data, "keep.txt"), "utf8")).resolves.toBe("selected data remains on refusal");
  });

  it("deletes matching Antigravity aliases while preserving unrelated history rows", async () => {
    const home = await homeFixture();
    const root = path.join(home, ".gemini", "antigravity-cli");
    const data = path.join(root, "brain", selected);
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, "artifact.txt"), "selected artifact");
    const history = path.join(root, "history.jsonl");
    const kept = `${JSON.stringify({ unrelated: "retained metadata" })}\n${JSON.stringify({ conversation_id: other })}\n`;
    await fs.writeFile(history, `${JSON.stringify({ conversationId: selected, conversation_id: selected })}\n${kept}`);
    const conversation: ConversationRecord = {
      key: `antigravity:${selected}`, providerId: "antigravity", providerName: "Antigravity", id: selected,
      title: "synthetic", sizeBytes: 1, dataPaths: [data], guardPaths: [], warnings: [],
      deleteStrategy: { kind: "local", metadata: { kind: "antigravity", historyFile: history } }
    };
    const result = await deleteConversations([conversation], { home, checkOpenPaths: closed, trash: movingTrash(home) });
    expect(result.failures).toEqual([]);
    expect(result.deleted).toEqual([conversation]);
    await expect(fs.readFile(history, "utf8")).resolves.toBe(kept);
    await expect(fs.lstat(data)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
