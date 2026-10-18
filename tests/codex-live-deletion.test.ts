import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { deleteConversations } from "../src/conversations/delete.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    fixtureTrash(directory, { recursive: true, force: true })
  ));
});

async function fixture() {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-live-"));
  directories.push(home);
  const root = path.join(home, ".codex");
  const selected = "11111111-1111-4111-8111-111111111111";
  const retained = "22222222-2222-4222-8222-222222222222";
  const rollout = path.join(root, "sessions", `${selected}.jsonl`);
  const otherRollout = path.join(root, "sessions", `${retained}.jsonl`);
  await fs.mkdir(path.dirname(rollout), { recursive: true });
  await fs.writeFile(rollout, JSON.stringify({ payload: { id: selected } }) + "\n");
  const rolloutCanonical = await fs.realpath(rollout);
  await fs.writeFile(otherRollout, JSON.stringify({ payload: { id: retained } }) + "\n");
  const databasePath = path.join(root, "state_5.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
  database.prepare("INSERT INTO threads VALUES (?, ?)").run(selected, rollout);
  database.prepare("INSERT INTO threads VALUES (?, ?)").run(retained, otherRollout);
  const index = path.join(root, "session_index.jsonl");
  await fs.writeFile(index, [JSON.stringify({ id: selected }), JSON.stringify({ id: retained })].join("\n") + "\n");
  const conversation: ConversationRecord = {
    key: `codex:${selected}`,
    providerId: "codex",
    providerName: "Codex",
    id: selected,
    title: "selected",
    sizeBytes: 1,
    dataPaths: [rollout],
    guardPaths: [databasePath, index],
    deleteStrategy: { kind: "local", metadata: {
      kind: "codex", stateDatabase: databasePath, sessionIndex: index,
      logsDatabase: path.join(root, "logs_2.sqlite"),
      queueDatabase: path.join(root, "queue_1.sqlite")
    } },
    warnings: []
  };
  const trashed: string[] = [];
  const trash = async (files: string[]) => {
    const destination = path.join(home, "trash");
    await fs.mkdir(destination, { recursive: true });
    for (const [index, file] of files.entries()) {
      await fs.rename(file, path.join(destination, `${Date.now()}-${index}-${path.basename(file)}`));
      trashed.push(file);
    }
  };
  return { home, database, databasePath, index, rollout, rolloutCanonical, selected, retained, conversation, trash, trashed };
}

describe("Codex offline conversation deletion", () => {
  it.each(["", "-wal", "-shm", "-journal"])("refuses an occupied SQLite group member %s before moving data", async (suffix) => {
    const item = await fixture();
    try {
      const result = await deleteConversations([item.conversation], {
        home: item.home,
        trash: item.trash,
        checkOpenPaths: async (paths) => ({ supported: true,
          openPaths: paths.filter((file) => file === `${item.databasePath}${suffix}`) })
      });
      expect(result.deleted).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error.message).toContain("open Codex indexes");
      expect(item.database.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual([{ id: item.selected }, { id: item.retained }]);
      expect(item.trashed).toEqual([]);
    } finally {
      item.database.close();
    }
  });

  it("rejects a write-locked database before moving the rollout", async () => {
    const item = await fixture();
    try {
      item.database.exec("BEGIN IMMEDIATE");
      const result = await deleteConversations([item.conversation], {
        home: item.home,
        trash: item.trash,
        checkOpenPaths: async (paths) => ({ supported: true,
          openPaths: paths.filter((file) => file === item.databasePath) })
      });
      expect(result.deleted).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error.message).toContain("open Codex indexes");
      expect(item.trashed).not.toContain(item.rolloutCanonical);
      await expect(fs.stat(item.rollout)).resolves.toBeDefined();
      item.database.exec("ROLLBACK");
    } finally {
      item.database.close();
    }
  }, 10_000);

  it("refuses concurrent database changes after the offline backup without overwriting retained rows", async () => {
    const item = await fixture();
    item.database.close();
    try {
      const result = await deleteConversations([item.conversation], {
        home: item.home,
        trash: async (files) => {
          if (files.includes(item.rolloutCanonical)) {
            const writer = new DatabaseSync(item.databasePath);
            try {
              writer.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?")
                .run("live-update", item.retained);
              writer.prepare("INSERT INTO threads VALUES (?, ?)")
                .run("33333333-3333-4333-8333-333333333333", "new-thread");
            } finally {
              writer.close();
            }
          }
          await item.trash(files);
        },
        checkOpenPaths: async () => ({ supported: true, openPaths: [] })
      });
      expect(result.deleted).toEqual([]);
      expect(result.failures).toHaveLength(1);
      const checked = new DatabaseSync(item.databasePath, { readOnly: true });
      try {
        expect(checked.prepare("SELECT id, rollout_path FROM threads WHERE id <> ? ORDER BY id").all(item.selected)).toEqual([
          { id: item.retained, rollout_path: "live-update" },
          { id: "33333333-3333-4333-8333-333333333333", rollout_path: "new-thread" }
        ]);
        expect(checked.prepare("SELECT id FROM threads WHERE id = ?").get(item.selected)).toEqual({ id: item.selected });
      } finally { checked.close(); }
    } finally {
      if (item.database.isOpen) item.database.close();
    }
  });

  it("rejects an occupied selected rollout before changing metadata", async () => {
    const item = await fixture();
    try {
      const result = await deleteConversations([item.conversation], {
        home: item.home,
        trash: item.trash,
        checkOpenPaths: async (paths) => ({ supported: true,
          openPaths: paths.filter((file) => file === item.rolloutCanonical || file === item.databasePath) })
      });
      expect(result.failures).toHaveLength(1);
      expect(item.trashed).toEqual([]);
      expect(item.database.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual([
        { id: item.selected }, { id: item.retained }
      ]);
    } finally {
      item.database.close();
    }
  });

  it("rejects an open JSON index without moving the rollout", async () => {
    const item = await fixture();
    try {
      const result = await deleteConversations([item.conversation], {
        home: item.home,
        trash: item.trash,
        checkOpenPaths: async (paths) => ({ supported: true,
          openPaths: paths.filter((file) => file === item.index || file === item.databasePath) })
      });
      expect(result.failures).toHaveLength(1);
      expect(item.trashed).toEqual([]);
      await expect(fs.stat(item.rollout)).resolves.toBeDefined();
    } finally {
      item.database.close();
    }
  });

  it("reports a staged recovery backup when trashing the rollout fails", async () => {
    const item = await fixture();
    item.database.close();
    try {
      const result = await deleteConversations([item.conversation], {
        home: item.home,
        trash: async () => { throw new Error("trash failed"); },
        checkOpenPaths: async () => ({ supported: true, openPaths: [] })
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.recoveryPath).toBeTruthy();
      const recovery = result.failures[0]!.recoveryPath!;
      const manifest = JSON.parse(await fs.readFile(path.join(recovery, "manifest.json"), "utf8")) as {
        files: Array<{ originalPath: string; backupPath: string }>;
      };
      const databaseBackup = manifest.files.find((file) => file.originalPath === item.databasePath);
      expect(databaseBackup).toBeDefined();
      const restored = new DatabaseSync(databaseBackup!.backupPath, { readOnly: true });
      try {
        expect(restored.prepare("SELECT id FROM threads WHERE id = ?").get(item.selected))
          .toEqual({ id: item.selected });
      } finally {
        restored.close();
      }
      await expect(fs.stat(item.rollout)).resolves.toBeDefined();
    } finally {
      if (item.database.isOpen) item.database.close();
    }
  });

  it("reports the recovery backup if a JSON index changes after staging", async () => {
    const item = await fixture();
    item.database.close();
    try {
      const result = await deleteConversations([item.conversation], {
        home: item.home,
        trash: async (files) => {
          if (files.includes(item.rolloutCanonical)) {
            await fs.appendFile(item.index, `${JSON.stringify({ id: item.retained, update: true })}\n`);
          }
          await item.trash(files);
        },
        checkOpenPaths: async () => ({ supported: true, openPaths: [] })
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.recoveryPath).toBeTruthy();
      await expect(fs.stat(path.join(result.failures[0]!.recoveryPath!, "manifest.json")))
        .resolves.toBeDefined();
      const checked = new DatabaseSync(item.databasePath, { readOnly: true });
      try {
        expect(checked.prepare("SELECT id FROM threads WHERE id = ?").get(item.selected)).toEqual({ id: item.selected });
      } finally { checked.close(); }
    } finally {
      if (item.database.isOpen) item.database.close();
    }
  });

  it("deletes a selected thread after all SQLite connections close", async () => {
    const item = await fixture();
    item.database.close();
    const result = await deleteConversations([item.conversation], {
      home: item.home, trash: item.trash,
      checkOpenPaths: async () => ({ supported: true, openPaths: [] })
    });
    expect(result.failures).toEqual([]);
    expect(result.deleted).toHaveLength(1);
    const checked = new DatabaseSync(item.databasePath, { readOnly: true });
    try {
      expect(checked.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual([{ id: item.retained }]);
    } finally { checked.close(); }
    expect(await fs.readFile(item.index, "utf8")).toBe(`${JSON.stringify({ id: item.retained })}\n`);
    expect(item.trashed).toContain(item.rolloutCanonical);
  });

  it("refuses a database reopened before moving the selected rollout", async () => {
    const item = await fixture();
    item.database.close();
    let checks = 0;
    const result = await deleteConversations([item.conversation], {
      home: item.home, trash: item.trash,
      checkOpenPaths: async (paths) => ({ supported: true,
        openPaths: paths.includes(item.databasePath) && ++checks > 1 ? [item.databasePath] : [] })
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(item.trashed).toEqual([]);
    await expect(fs.stat(item.rollout)).resolves.toBeDefined();
  });

  it("keeps dry-run available while its SQLite database is open", async () => {
    const item = await fixture();
    try {
      const result = await deleteConversations([item.conversation], {
        home: item.home, dryRun: true, trash: item.trash,
        checkOpenPaths: async () => { throw new Error("Unexpected mutation guard during preview"); }
      });
      expect(result.failures).toEqual([]);
      expect(result.previewed).toHaveLength(1);
      expect(item.trashed).toEqual([]);
      expect(item.database.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual([{ id: item.selected }, { id: item.retained }]);
    } finally { item.database.close(); }
  });
});
