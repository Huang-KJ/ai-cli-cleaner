import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";

const homes: string[] = [];
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const closed = async () => ({ supported: true, openPaths: [] as string[] });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});

describe("Antigravity post-trash consistency", () => {
  it.each(["trash", "metadata-check"] as const)("retains metadata if a selected artifact appears during %s", async (timing) => {
    const fixture = await makeFixture();
    const original = await fs.readFile(fixture.file);
    const history = await fs.readFile(fixture.history, "utf8");
    let checks = 0;
    const result = await deleteConversations([fixture.selected], {
      home: fixture.home,
      checkOpenPaths: async () => {
        if (timing === "metadata-check" && ++checks === 3) await addArtifact(fixture.added);
        return closed();
      },
      trash: async (files) => {
        await fixture.move(files);
        if (timing === "trash" && files.includes(fixture.data)) await addArtifact(fixture.added);
      }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ deletedPaths: [fixture.data], metadataChanged: false });
    expect(result.failures[0]?.recoveryPath).toBeTruthy();
    expect(await fs.readFile(fixture.file)).toEqual(original);
    expect(await fs.readFile(fixture.history, "utf8")).toBe(history);
    expect(await fs.readFile(fixture.added, "utf8")).toBe("new artifact");
  });

  it("reports partial metadata changes and retains recovery if a selected artifact appears during metadata writing", async () => {
    const fixture = await makeFixture();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      await rename(source, target);
      if (String(target).includes(`${path.sep}work${path.sep}`) &&
        String(target).endsWith(`-${path.basename(fixture.history)}`)) await addArtifact(fixture.added);
    });
    const result = await deleteConversations([fixture.selected], {
      home: fixture.home, checkOpenPaths: closed, trash: fixture.move
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ deletedPaths: [fixture.data], metadataChanged: true });
    const recovery = result.failures[0]?.recoveryPath;
    expect(recovery).toBeTruthy();
    await expect(fs.lstat(recovery!)).resolves.toBeDefined();
    expect(await fs.readFile(fixture.history, "utf8")).toBe("");
    expect(await fs.readFile(fixture.added, "utf8")).toBe("new artifact");
  });

  it("allows an unrelated artifact added during trashing", async () => {
    const fixture = await makeFixture();
    const unrelated = path.join(path.dirname(fixture.added), `${other}.pb`);
    const result = await deleteConversations([fixture.selected], {
      home: fixture.home, checkOpenPaths: closed,
      trash: async (files) => {
        await fixture.move(files);
        if (files.includes(fixture.data)) await addArtifact(unrelated);
      }
    });
    expect(result.failures).toEqual([]);
    expect(result.deleted).toEqual([fixture.selected]);
    expect(await fs.readFile(fixture.history, "utf8")).toBe("");
    expect(await fs.readFile(unrelated, "utf8")).toBe("new artifact");
  });

  it("reports changed metadata truthfully if a selected artifact appears during backup release", async () => {
    const fixture = await makeFixture();
    const result = await deleteConversations([fixture.selected], {
      home: fixture.home, checkOpenPaths: closed,
      trash: async (files) => {
        await fixture.move(files);
        if (files.some((file) => file.includes(`${path.sep}recovery${path.sep}`))) await addArtifact(fixture.added);
      }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ deletedPaths: [fixture.data], metadataChanged: true });
    expect(result.failures[0]?.recoveryPath).toBeUndefined();
    expect(result.failures[0]?.error.message).toMatch(/Antigravity conversation data was added or removed after discovery/);
    expect(await fs.readFile(fixture.history, "utf8")).toBe("");
    expect(await fs.readFile(fixture.added, "utf8")).toBe("new artifact");
  });

  it.each(["summary", "history", "last-cache"] as const)("reports selected %s references reinserted during backup release", async (kind) => {
    const fixture = await makeFixture();
    const result = await deleteConversations([fixture.selected], {
      home: fixture.home, checkOpenPaths: closed,
      trash: async (files) => {
        await fixture.move(files);
        if (files.some((file) => file.includes(`${path.sep}recovery${path.sep}`))) {
          if (kind === "summary") {
            const database = new DatabaseSync(fixture.file);
            database.prepare("INSERT INTO conversation_summaries(conversation_id) VALUES(?)").run(id);
            database.close();
          } else if (kind === "history") {
            await fs.appendFile(fixture.history, `${JSON.stringify({ conversation_id: id, display: "reinserted" })}\n`);
          } else {
            const file = fixture.selected.deleteStrategy.kind === "local" &&
              fixture.selected.deleteStrategy.metadata?.kind === "antigravity"
              ? fixture.selected.deleteStrategy.metadata.lastConversationsFile! : "";
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify({ "/fixture": id }));
          }
        }
      }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ deletedPaths: [fixture.data], metadataChanged: true });
    expect(result.failures[0]?.recoveryPath).toBeUndefined();
    expect(result.failures[0]?.error.message).toMatch(/Metadata .*after preflight/);
    if (kind === "summary") {
      const database = new DatabaseSync(fixture.file, { readOnly: true });
      try { expect(database.prepare("SELECT conversation_id FROM conversation_summaries").all()).toEqual([{ conversation_id: id }]); }
      finally { database.close(); }
      expect(await fs.readFile(fixture.history, "utf8")).toBe("");
    } else if (kind === "history") {
      expect(await fs.readFile(fixture.history, "utf8")).toBe(`${JSON.stringify({ conversation_id: id, display: "reinserted" })}\n`);
    } else {
      const file = fixture.selected.deleteStrategy.kind === "local" && fixture.selected.deleteStrategy.metadata?.kind === "antigravity"
        ? fixture.selected.deleteStrategy.metadata.lastConversationsFile! : "";
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ "/fixture": id });
    }
  });

  it("reports a concurrent offline metadata change while preserving unrelated rows inserted during backup release", async () => {
    const fixture = await makeFixture();
    const result = await deleteConversations([fixture.selected], {
      home: fixture.home, checkOpenPaths: closed,
      trash: async (files) => {
        await fixture.move(files);
        if (files.some((file) => file.includes(`${path.sep}recovery${path.sep}`))) {
          const database = new DatabaseSync(fixture.file);
          database.prepare("INSERT INTO conversation_summaries(conversation_id) VALUES(?)").run(other);
          database.close();
          await fs.appendFile(fixture.history, `${JSON.stringify({ conversationId: other, display: "unrelated" })}\n`);
        }
      }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ deletedPaths: [fixture.data], metadataChanged: true, recoveryPath: undefined });
    expect(result.failures[0]?.error.message).toMatch(/Metadata .*after preflight/);
    expect(await fs.readFile(fixture.history, "utf8")).toBe(`${JSON.stringify({ conversationId: other, display: "unrelated" })}\n`);
    const database = new DatabaseSync(fixture.file, { readOnly: true });
    try {
      expect(database.prepare("SELECT conversation_id FROM conversation_summaries").all()).toEqual([
        { conversation_id: other }
      ]);
    } finally { database.close(); }
  });
});

async function addArtifact(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "new artifact");
}

async function makeFixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-ag-consistency-")));
  homes.push(home);
  const root = path.join(home, ".gemini", "antigravity-cli");
  const data = path.join(root, "brain", id);
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(data, "artifact.txt"), "original artifact");
  const file = path.join(root, "conversation_summaries.db");
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, last_modified_time TEXT, workspace_uris TEXT)");
  database.prepare("INSERT INTO conversation_summaries VALUES(?, ?, ?, ?, ?)").run(id, "fixture", "preview", "2026-10-14T00:00:00Z", "/fixture");
  database.close();
  const history = path.join(root, "history.jsonl");
  await fs.writeFile(history, `${JSON.stringify({ conversationId: id, display: "fixture" })}\n`);
  const selected = (await discoverConversations(["antigravity"], { home })).conversations[0]!;
  const added = path.join(home, ".gemini", "antigravity-ide", "conversations", `${id}.pb`);
  let moved = 0;
  const move = async (files: string[]) => {
    const trash = path.join(home, "fixture-trash");
    await fs.mkdir(trash, { recursive: true });
    for (const source of files) await fs.rename(source, path.join(trash, String(moved++)));
  };
  return { home, file, history, data, added, selected, move };
}
