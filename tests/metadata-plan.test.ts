import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetadataPlan } from "../src/conversations/metadata-plan.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { atomicRewrite, attachMetadataFailure, createMetadataInventory } from "../src/conversations/metadata-safety.js";
import type { ConversationRecord, DeletionError } from "../src/conversations/types.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-metadata-plan-")));
  homes.push(home);
  const root = path.join(home, ".provider");
  const file = path.join(root, "index.json");
  await fs.mkdir(root);
  const original = '{"selected":true}\n';
  await fs.writeFile(file, original);
  const inventory = await createMetadataInventory([file], root, home);
  return { home, inventory, file, original, changedPaths: [file], providerId: "fixture", conversationIds: ["selected"] };
}

describe("metadata plan lifecycle", () => {
  it("stages once, forwards a live recovery path, and clears it only after successful Trash", async () => {
    const item = await fixture();
    const beforeStage = vi.fn();
    const beforeWrite = vi.fn();
    const plan = createMetadataPlan({
      ...item, beforeStage, beforeWrite,
      write: async (markChanged, copies, inventory) => {
        markChanged();
        await atomicRewrite(copies.get(item.file)!, "{}\n", inventory);
      }
    });
    const view = { get recoveryPath() { return plan.recoveryPath; } };
    expect(view.recoveryPath).toBeUndefined();
    await plan.prepareRecovery();
    const recovery = view.recoveryPath!;
    await plan.prepareRecovery();
    expect(view.recoveryPath).toBe(recovery);
    expect(beforeStage).toHaveBeenCalledTimes(1);
    const trash = vi.fn(async (files: string[]) => {
      expect(files).toEqual([recovery]);
      await fs.rename(recovery, path.join(item.home, "trashed-backup"));
    });
    await expect(plan.execute(trash)).resolves.toEqual({ metadataChanged: true });
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(trash).toHaveBeenCalledTimes(1);
    expect(view.recoveryPath).toBeUndefined();
    expect(await fs.readFile(item.file, "utf8")).toBe("{}\n");
    await expect(fs.lstat(recovery)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs required before-write checks even when the rehearsed change set is empty", async () => {
    const item = await fixture();
    const beforeStage = vi.fn();
    const write = vi.fn();
    const trash = vi.fn();
    const plan = createMetadataPlan({
      ...item, changedPaths: [], beforeStage, write,
      beforeWrite: () => { throw new Error("pending provider write"); }
    });
    await plan.prepareRecovery();
    await expect(plan.execute(trash)).rejects.toMatchObject({ message: "pending provider write", metadataChanged: false });
    expect(beforeStage).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    expect(plan.recoveryPath).toBeUndefined();
    expect(await fs.readFile(item.file, "utf8")).toBe(item.original);
  });

  it("refuses both preview execution and staging even when no metadata changes", async () => {
    const item = await fixture();
    const beforeWrite = vi.fn();
    const write = vi.fn();
    const trash = vi.fn();
    const plan = createMetadataPlan({ ...item, changedPaths: [], previewOnly: true, beforeWrite, write });
    await expect(plan.prepareRecovery()).rejects.toThrow(/A preview plan cannot create deletion backups/);
    await expect(plan.execute(trash)).rejects.toThrow(/A preview plan cannot execute deletion/);
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(item.home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks inventory after staging and retains recovery on a before-write failure", async () => {
    const item = await fixture();
    const write = vi.fn();
    const trash = vi.fn();
    const plan = createMetadataPlan({ ...item, write });
    await plan.prepareRecovery();
    const recovery = plan.recoveryPath;
    await fs.writeFile(item.file, '{"new":"concurrent data"}\n');
    await expect(plan.execute(trash)).rejects.toMatchObject({ metadataChanged: false, recoveryPath: recovery });
    expect(write).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    expect(plan.recoveryPath).toBe(recovery);
    await expect(fs.readFile(path.join(recovery!, "manifest.json"))).resolves.toBeDefined();
    expect(await fs.readFile(item.file, "utf8")).toContain("concurrent data");
  });

  it.each([false, true])("restores originals when a private write fails (marked=%s)", async (marked) => {
    const item = await fixture();
    const trash = vi.fn();
    const plan = createMetadataPlan({
      ...item,
      write: async (markChanged, copies, inventory) => {
        if (marked) {
          await atomicRewrite(copies.get(item.file)!, "{}\n", inventory);
          markChanged();
        }
        throw new Error("provider write failed");
      }
    });
    await plan.prepareRecovery();
    const recovery = plan.recoveryPath;
    await expect(plan.execute(trash)).rejects.toMatchObject({
      message: "provider write failed", metadataChanged: false, recoveryPath: recovery
    });
    expect(trash).not.toHaveBeenCalled();
    expect(plan.recoveryPath).toBe(recovery);
    await expect(fs.readFile(path.join(recovery!, "manifest.json"))).resolves.toBeDefined();
    expect(await fs.readFile(item.file, "utf8")).toBe(item.original);
  });

  it("retains a live recovery path when backup Trash fails after metadata changes", async () => {
    const item = await fixture();
    const plan = createMetadataPlan({
      ...item,
      write: async (markChanged, copies, inventory) => {
        markChanged();
        await atomicRewrite(copies.get(item.file)!, "{}\n", inventory);
      }
    });
    await plan.prepareRecovery();
    const recovery = plan.recoveryPath;
    await expect(plan.execute(async () => { throw new Error("backup Trash failed"); }))
      .rejects.toMatchObject({ message: "backup Trash failed", metadataChanged: true, recoveryPath: recovery });
    expect(plan.recoveryPath).toBe(recovery);
    await expect(fs.readFile(path.join(recovery!, "manifest.json"))).resolves.toBeDefined();
  });

  it("does not report a missing recovery path if the helper fails after moving the bundle", async () => {
    const item = await fixture();
    const plan = createMetadataPlan({
      ...item,
      write: async (markChanged, copies, inventory) => {
        await atomicRewrite(copies.get(item.file)!, "{}\n", inventory);
        markChanged();
      }
    });
    await plan.prepareRecovery();
    const recovery = plan.recoveryPath!;
    const helperError = new Error("helper failed after movement");
    await expect(plan.execute(async () => {
      await fs.rename(recovery, path.join(item.home, "trashed-backup"));
      throw helperError;
    })).rejects.toMatchObject({
      message: expect.stringMatching(/helper failed after movement.*backup no longer exists at its original path.*system Trash/),
      cause: helperError, metadataChanged: true, recoveryPath: undefined
    });
    expect(plan.recoveryPath).toBeUndefined();
    await expect(fs.lstat(recovery)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(item.home, "trashed-backup", "manifest.json"))).resolves.toBeDefined();
    expect(await fs.readFile(item.file, "utf8")).toBe("{}\n");
  });

  it("rejects a helper that resolves without moving the recovery bundle", async () => {
    const item = await fixture();
    const plan = createMetadataPlan({
      ...item,
      write: async (markChanged, copies, inventory) => {
        await atomicRewrite(copies.get(item.file)!, "{}\n", inventory);
        markChanged();
      }
    });
    await plan.prepareRecovery();
    const recovery = plan.recoveryPath!;
    await expect(plan.execute(async () => undefined)).rejects.toMatchObject({
        message: expect.stringMatching(/Recovery backup remains at its original path/), metadataChanged: true, recoveryPath: recovery
    });
    expect(plan.recoveryPath).toBe(recovery);
    await expect(fs.readFile(path.join(recovery, "manifest.json"))).resolves.toBeDefined();
    expect(await fs.readFile(item.file, "utf8")).toBe("{}\n");
  });

  it("merges failure details without erasing prior mutations, recovery paths, or partial movement", () => {
    const error: DeletionError = Object.assign(new Error("partial backup"), {
      metadataChanged: true, recoveryPath: "/partial/recovery", deletedPaths: ["/moved/first"]
    });
    expect(attachMetadataFailure(error, {
      metadataChanged: false, recoveryPath: undefined, deletedPaths: ["/moved/first", "/moved/second"]
    })).toBe(error);
    expect(error).toMatchObject({
      metadataChanged: true, recoveryPath: "/partial/recovery", deletedPaths: ["/moved/first", "/moved/second"]
    });
    attachMetadataFailure(error, { recoveryPath: "/fallback/recovery" });
    expect(error.recoveryPath).toBe("/partial/recovery");
  });

  it.each(["pending", "child"] as const)("keeps Grok's post-move %s check when metadata changes are empty", async (mode) => {
    const item = await fixture();
    const root = path.join(item.home, ".grok");
    const selected = path.join(root, "sessions", "group", "selected");
    await fs.mkdir(selected, { recursive: true });
    await fs.writeFile(path.join(selected, "summary.json"), JSON.stringify({ info: { id: "selected" } }));
    const conversation: ConversationRecord = {
      key: "grok:selected", providerId: "grok", providerName: "Grok", id: "selected", title: "selected",
      sizeBytes: 1, dataPaths: [selected], guardPaths: [], warnings: [], deleteStrategy: { kind: "indexed" }
    };
    const trash = vi.fn(async (files: string[]) => {
      expect(files).toEqual([selected]);
      await fs.rename(selected, path.join(item.home, "trashed-source"));
      if (mode === "pending") await fs.writeFile(path.join(root, "active_sessions.json.tmp"), "[]");
      else {
        const child = path.join(root, "sessions", "group", "child");
        await fs.mkdir(child);
        await fs.writeFile(path.join(child, "summary.json"), JSON.stringify({
          info: { id: "child" }, parent_session_id: "selected"
        }));
      }
    });
    const result = await deleteConversations([conversation], {
      home: item.home, trash, checkOpenPaths: async () => ({ supported: true, openPaths: [] })
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(mode === "pending" ? /unfinished active index write/ : /parent conversation still has children/);
    expect(result.failures[0]?.metadataChanged).toBe(false);
    expect(result.failures[0]?.deletedPaths).toEqual([selected]);
    expect(trash).toHaveBeenCalledTimes(1);
    await expect(fs.lstat(path.join(item.home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
