import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { atomicRewrite, createMetadataInventory } from "../src/conversations/metadata-safety.js";
import { createMetadataPlan } from "../src/conversations/metadata-plan.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { inspectOperation, listOperations, withOperation, wrapOperationTrash } from "../src/recovery/operations.js";
import type { ConversationRecord } from "../src/conversations/types.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) await fixtureTrash(home, { recursive: true, force: true });
});

async function fixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-metadata-durability-")));
  homes.push(home);
  const root = path.join(home, ".gemini", "antigravity-cli");
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "history.jsonl");
  const original = '{"conversationId":"selected"}\n';
  await fs.writeFile(file, original, { mode: 0o600 });
  const inventory = await createMetadataInventory([file], root, home);
  return { home, root, file, original, inventory };
}

function observeOpen(observe: (file: string, handle: FileHandle) => void) {
  const open = fs.open.bind(fs);
  return vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    observe(String(file), handle);
    return handle;
  });
}

describe("metadata rewrite durability", () => {
  it("preserves the original and closes the temporary handle when file sync fails", async () => {
    const item = await fixture();
    let temporary: FileHandle | undefined;
    observeOpen((file, handle) => {
      if (file.startsWith(`${item.file}.ai-cleaner-`)) {
        temporary = handle;
        vi.spyOn(handle, "sync").mockRejectedValue(new Error("temporary sync failed"));
      }
    });
    await expect(atomicRewrite(item.file, "replacement\n", item.inventory))
      .rejects.toMatchObject({ message: "temporary sync failed", metadataChanged: false });
    expect(await fs.readFile(item.file, "utf8")).toBe(item.original);
    expect(temporary?.fd).toBe(-1);
    expect(await fs.readdir(item.root)).toEqual(["history.jsonl"]);
  });

  it("retains a preexisting temporary file when exclusive creation collides", async () => {
    const item = await fixture();
    const write = fs.writeFile.bind(fs);
    const open = fs.open.bind(fs);
    let obstacle: string | undefined;
    const collide = async (file: string) => {
      if (file.startsWith(`${item.file}.ai-cleaner-`)) {
        obstacle = file;
        await write(file, "preexisting temporary content", { flag: "wx" });
      }
    };
    // 涵蓋舊 writeFile 入口及新的 exclusive FileHandle 入口。
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await collide(String(args[0]));
      return write(...args);
    });
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      await collide(String(file));
      return open(file, flags, mode);
    });
    await expect(atomicRewrite(item.file, "replacement\n", item.inventory))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(obstacle).toBeDefined();
    expect(await fs.readFile(obstacle!, "utf8")).toBe("preexisting temporary content");
    expect(await fs.readFile(item.file, "utf8")).toBe(item.original);
  });

  it("reports private directory sync failure, restores metadata, and retains a verified recovery bundle", async () => {
    const item = await fixture();
    const directory = path.join(item.root, "brain", "selected");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "artifact.md"), "selected artifact");
    const conversation: ConversationRecord = {
      key: "antigravity:selected", providerId: "antigravity", providerName: "Antigravity",
      id: "selected", title: "selected", sizeBytes: 1, dataPaths: [directory], guardPaths: [], warnings: [],
      deleteStrategy: { kind: "local", metadata: { kind: "antigravity", historyFile: item.file } }
    };
    observeOpen((file, handle) => {
      if (path.basename(file) === "work") vi.spyOn(handle, "sync").mockRejectedValue(new Error("metadata directory sync failed"));
    });
    const moved: string[] = [];
    const result = await withOperation({ home: item.home, kind: "conversations", target: ["antigravity"] }, () =>
      deleteConversations([conversation], {
        home: item.home, checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
        trash: wrapOperationTrash(async (files) => {
          for (const file of files) {
            moved.push(file);
            await fs.rename(file, path.join(item.home, `trashed-${moved.length}`));
          }
        })
      }));
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      error: { message: "metadata directory sync failed" }, metadataChanged: false, deletedPaths: [directory]
    });
    expect(await fs.readFile(item.file, "utf8")).toBe(item.original);
    expect(moved).toEqual([directory]);
    const [summary] = await listOperations(item.home);
    const inspected = await inspectOperation(summary!.id, item.home);
    expect(summary?.status).toBe("partial");
    expect(inspected.operation.metadata[0]?.stage).toBe("possibly-partial");
    expect(inspected.operation.metadata[0]?.recoveryPath).toBe(result.failures[0]?.recoveryPath);
    expect(inspected.backups[0]?.status).toBe("verified");
    const manifest = JSON.parse(await fs.readFile(inspected.backups[0]!.manifestPath, "utf8"));
    expect(await fs.readFile(manifest.files[0].backupPath, "utf8")).toBe(item.original);
  });

  it("preserves metadataChanged when persisting the failure journal also fails", async () => {
    const item = await fixture();
    let rewritten = false;
    observeOpen((file, handle) => {
      if (file === item.root) vi.spyOn(handle, "sync").mockImplementation(async () => {
        rewritten = true;
        throw new Error("metadata directory sync failed");
      });
    });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (rewritten && String(target).endsWith("/operation.json")) throw new Error("failure journal unavailable");
      return rename(source, target);
    });
    const trash = vi.fn(async () => undefined);
    await expect(withOperation({ home: item.home, kind: "conversations", target: ["antigravity"] }, async () => {
      const plan = createMetadataPlan({
        home: item.home, inventory: item.inventory, changedPaths: [item.file], providerId: "antigravity",
        conversationIds: ["selected"], write: async (changed, copies, inventory) => {
          await atomicRewrite(copies.get(item.file)!, "", inventory);
          changed();
        },
        afterWrite: async () => {
          const directory = await fs.open(item.root, "r");
          try { await directory.sync(); }
          finally { await directory.close(); }
        }
      });
      await plan.execute(trash);
    })).rejects.toMatchObject({ message: expect.stringMatching(/operation journal/i), metadataChanged: true,
      recoveryPath: expect.any(String) });
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(item.file, "utf8")).toBe("");
    const [summary] = await listOperations(item.home);
    const inspected = await inspectOperation(summary!.id, item.home);
    expect(summary?.status).toBe("incomplete");
    expect(inspected.operation.metadata[0]?.stage).toBe("writing");
    expect(inspected.backups[0]?.status).toBe("verified");
  });
});
