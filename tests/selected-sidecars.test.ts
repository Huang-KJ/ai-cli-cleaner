import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanEntries, type TrashFn } from "../src/cleaners/clean.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { snapshotConversationPaths } from "../src/conversations/owned-paths.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

describe("selected SQLite sidecar completeness", () => {
  it("moves a complete selected SQLite set together", async () => {
    const home = await makeHome();
    const database = path.join(home, "selected.db");
    const paths = [database, `${database}-wal`, `${database}-shm`, `${database}-journal`];
    await Promise.all(paths.map((file) => fs.writeFile(file, "selected data")));
    const entries = await snapshotConversationPaths(selectedConversation(paths), paths);
    const trash = vi.fn<TrashFn>(async (sources) => {
      await fs.mkdir(path.join(home, "trash"));
      for (const source of sources) await fs.rename(source, path.join(home, "trash", path.basename(source)));
    });
    const result = await cleanEntries(entries, {
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }), trash
    });
    expect(result.failures).toEqual([]);
    expect(result.deleted.map((entry) => entry.path)).toEqual(paths);
    expect(trash).toHaveBeenCalledExactlyOnceWith(paths, new Map(entries.map((entry) => [entry.path, entry.identity])));
    for (const entry of entries) {
      expect(entry.identity).toBeDefined();
      expect(trash.mock.calls[0]?.[1]?.get(entry.path)).toBe(entry.identity);
    }
  });

  it.each([
    ["-wal", "added"], ["-shm", "added"], ["-journal", "added"],
    ["-wal", "missing"], ["-shm", "missing"], ["-journal", "missing"],
    ["-wal", "omitted"], ["-shm", "omitted"], ["-journal", "omitted"]
  ] as const)("rejects %s when %s before moving the database", async (suffix, change) => {
    const home = await makeHome();
    const database = path.join(home, "selected.db");
    const sidecar = `${database}${suffix}`;
    await fs.writeFile(database, "selected database");
    if (change !== "added") await fs.writeFile(sidecar, "selected sidecar");
    const conversation = selectedConversation([database]);
    const entries = await snapshotConversationPaths(conversation,
      change === "missing" ? [database, sidecar] : [database]);
    if (change === "added") await fs.writeFile(sidecar, "new sidecar");
    if (change === "missing") await fs.rename(sidecar, path.join(home, "moved-sidecar"));
    const trash = vi.fn(async (paths: string[]) => {
      await fs.mkdir(path.join(home, "trash"));
      for (const source of paths) await fs.rename(source, path.join(home, "trash", path.basename(source)));
    });
    const result = await cleanEntries(entries, {
      checkOpenPaths: async () => ({ supported: true, openPaths: [] }), trash
    });
    expect(trash).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]?.error.message).toMatch(/changed after scanning/);
    expect(await fs.readFile(database, "utf8")).toBe("selected database");
    if (change !== "missing") expect(await fs.readFile(sidecar, "utf8"))
      .toBe(change === "added" ? "new sidecar" : "selected sidecar");
  });

  it("rejects an Antigravity sidecar change before moving any selected data path", async () => {
    const home = await makeHome();
    const root = path.join(home, ".gemini", "antigravity-cli");
    const brain = path.join(root, "brain", "selected");
    const data = path.join(root, "conversations", "selected.db");
    await fs.mkdir(brain, { recursive: true });
    await fs.mkdir(path.dirname(data), { recursive: true });
    await fs.writeFile(path.join(brain, "artifact.txt"), "selected artifact");
    await fs.writeFile(data, "selected database");
    const metadata = path.join(root, "conversation_summaries.db");
    const database = new DatabaseSync(metadata);
    database.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY); INSERT INTO conversation_summaries VALUES ('selected'), ('retained')");
    database.close();
    const original = await fs.readFile(metadata);
    const conversation = selectedConversation([brain, data]);
    conversation.deleteStrategy = { kind: "local", metadata: { kind: "antigravity", summaryDatabase: metadata } };
    let added = false;
    let trashCount = 0;
    const trash = vi.fn(async (paths: string[]) => {
      const directory = path.join(home, "trash", String(trashCount++));
      await fs.mkdir(directory, { recursive: true });
      for (const source of paths) await fs.rename(source, path.join(directory, path.basename(source)));
    });
    const result = await deleteConversations([conversation], {
      home, trash,
      checkOpenPaths: async () => {
        if (!added) {
          added = true;
          await fs.writeFile(`${data}-wal`, "new sidecar");
        }
        return { supported: true, openPaths: [] };
      }
    });
    expect(added).toBe(true);
    expect(trash).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(/SQLite sidecar set changed/);
    expect(await fs.readFile(metadata)).toEqual(original);
    expect(await fs.readFile(data, "utf8")).toBe("selected database");
    expect(await fs.readFile(`${data}-wal`, "utf8")).toBe("new sidecar");
    expect(await fs.readFile(path.join(brain, "artifact.txt"), "utf8")).toBe("selected artifact");
  });
});

async function makeHome(): Promise<string> {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-sidecars-")));
  homes.push(home);
  return home;
}

function selectedConversation(dataPaths: string[]): ConversationRecord {
  return {
    key: "antigravity:selected", providerId: "antigravity", providerName: "Antigravity", id: "selected", title: "selected",
    sizeBytes: 1, dataPaths, guardPaths: [], warnings: [],
    deleteStrategy: { kind: "local", metadata: { kind: "antigravity" } }
  };
}
