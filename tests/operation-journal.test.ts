import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { inspectOperation, listOperations, withOperation, wrapOperationTrash } from "../src/recovery/operations.js";
import { createMetadataPlan } from "../src/conversations/metadata-plan.js";
import { atomicRewrite, createMetadataInventory } from "../src/conversations/metadata-safety.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await fixtureTrash(home, { force: true, recursive: true });
});
async function fixture(): Promise<string> {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-journal-"));
  homes.push(home);
  return home;
}
const operation = (home: string) => ({ home, kind: "conversations" as const, target: ["codex"] });

// 若搬移未先持久保存意圖、錯誤被寫成成功或備份驗證放寬，這些案例會失敗。
describe("durable operation journal", () => {
  it("persists private intent before a helper and records observed movement", async () => {
    const home = await fixture();
    const file = path.join(home, "conversation.jsonl");
    await fs.writeFile(file, "private transcript");
    await withOperation(operation(home), async () => {
      await wrapOperationTrash(async (paths) => {
        const [summary] = await listOperations(home);
        expect(summary!.status).toBe("incomplete");
        const inspected = await inspectOperation(summary!.id, home);
        expect(inspected.operation.plannedPaths).toEqual([file]);
        expect(inspected.operation.phase).toBe("trash-intent");
        await fs.rename(paths[0]!, path.join(home, "trash-result"));
      })([file]);
    });
    const [summary] = await listOperations(home);
    expect(Object.keys(summary!).sort()).toEqual(["id", "kind", "startedAt", "status", "target"].sort());
    const inspected = await inspectOperation(summary!.id, home);
    expect(inspected.operation.status).toBe("succeeded");
    expect(inspected.operation.movedPaths).toEqual([file]);
    expect(inspected.operation.uncertainPaths).toEqual([]);
    expect((await fs.stat(path.join(home, ".ai-cli-cleaner", "operations"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(home, ".ai-cli-cleaner", "operations", summary!.id, "operation.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps a partial helper failure uncertain even if the caller catches it", async () => {
    const home = await fixture();
    const first = path.join(home, "first.jsonl");
    const second = path.join(home, "second.jsonl");
    await fs.writeFile(first, "one");
    await fs.writeFile(second, "two");
    await withOperation(operation(home), async () => {
      await wrapOperationTrash(async () => {
        await fs.rename(first, path.join(home, "trash-result"));
        throw new Error("helper interrupted");
      })([first, second]).catch(() => undefined);
    });
    const [summary] = await listOperations(home);
    const inspected = await inspectOperation(summary!.id, home);
    expect(summary!.status).toBe("partial");
    expect(inspected.operation.movedPaths).toEqual([first]);
    expect(inspected.operation.uncertainPaths).toContain(first);
    expect(inspected.operation.remainingPaths).toEqual([second]);
  });

  it("fails closed when a journal path is replaced before the first helper", async () => {
    const home = await fixture();
    const outside = path.join(home, "outside");
    await fs.mkdir(outside);
    let invoked = false;
    await fs.writeFile(path.join(home, "source"), "source");
    await expect(withOperation(operation(home), async () => {
      const [summary] = await listOperations(home);
      const directory = path.join(home, ".ai-cli-cleaner", "operations", summary!.id);
      await fs.rename(directory, `${directory}-original`);
      await fs.symlink(outside, directory);
      await wrapOperationTrash(async () => { invoked = true; })([path.join(home, "source")]);
    })).rejects.toThrow();
    expect(invoked).toBe(false);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("preserves incomplete intent after a durable write fails and prevents further helpers", async () => {
    const home = await fixture();
    const first = path.join(home, "first.jsonl");
    const second = path.join(home, "second.jsonl");
    await fs.writeFile(first, "one");
    await fs.writeFile(second, "two");
    let invoked = 0;
    const rename = fs.rename.bind(fs);
    let failing = false;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (failing && String(destination).endsWith("/operation.json")) throw new Error("disk unavailable");
      return rename(source, destination);
    });
    try {
      await expect(withOperation(operation(home), async () => {
        const trash = wrapOperationTrash(async (paths) => {
          invoked += 1;
          await rename(paths[0]!, path.join(home, "trash-result"));
          failing = true;
        });
        await trash([first]).catch(() => undefined);
        await trash([second]).catch(() => undefined);
      })).rejects.toThrow(/The operation journal could not be saved safely; further changes stopped/);
      expect(invoked).toBe(1);
      const [summary] = await listOperations(home);
      const inspected = await inspectOperation(summary!.id, home);
      expect(summary!.status).toBe("incomplete");
      expect(inspected.operation.phase).toBe("trash-intent");
      expect(inspected.operation.uncertainPaths).toEqual([first]);
      expect(await fs.readFile(second, "utf8")).toBe("two");
    } finally { spy.mockRestore(); }
  });

  it("prevents later destructive helpers after a partially failed helper", async () => {
    const home = await fixture();
    const first = path.join(home, "first.jsonl");
    const second = path.join(home, "second.jsonl");
    await fs.writeFile(first, "one");
    await fs.writeFile(second, "two");
    let invoked = 0;
    await withOperation(operation(home), async () => {
      const trash = wrapOperationTrash(async (paths) => {
        invoked += 1;
        await fs.rename(paths[0]!, path.join(home, "trash-result"));
        throw new Error("helper interrupted");
      });
      await trash([first]).catch(() => undefined);
      await expect(trash([second])).rejects.toThrow(/Trash operation failed or could not be confirmed/);
    });
    expect(invoked).toBe(1);
    expect(await fs.readFile(second, "utf8")).toBe("two");
  });

  it("stores metadata backup and an interrupted multi-file write as possibly partial", async () => {
    const home = await fixture();
    const root = path.join(home, ".codex");
    await fs.mkdir(root);
    const first = path.join(root, "first.json");
    const second = path.join(root, "second.json");
    await fs.writeFile(first, "{}");
    await fs.writeFile(second, "{}");
    const inventory = await createMetadataInventory([first, second], root, home);
    await expect(withOperation(operation(home), async () => {
      const plan = createMetadataPlan({ home, inventory, changedPaths: [first, second], providerId: "codex", conversationIds: ["private-id"],
        write: async (changed, copies, mapped) => {
          changed();
          await atomicRewrite(copies.get(first)!, '{"changed":true}', mapped);
          throw new Error("second database failed");
        }
      });
      await plan.execute(wrapOperationTrash(async () => undefined));
    })).rejects.toThrow("second database failed");
    const [summary] = await listOperations(home);
    const inspected = await inspectOperation(summary!.id, home);
    expect(summary!.status).toBe("partial");
    expect(inspected.operation.metadata[0]!.stage).toBe("possibly-partial");
    expect(inspected.backups[0]!.status).toBe("verified");
    expect(inspected.backups[0]!.files).toHaveLength(2);
    const manifest = inspected.backups[0]!.manifestPath;
    const raw = JSON.parse(await fs.readFile(manifest, "utf8"));
    expect(raw.formatVersion).toBe(1);
    await fs.writeFile(raw.files[0].backupPath, "tampered");
    await expect(inspectOperation(summary!.id, home)).rejects.toThrow(/Backup SHA-256 does not match/);
  });

  it("halts the remaining batch after an uncertain metadata write", async () => {
    const home = await fixture();
    const root = path.join(home, ".codex");
    await fs.mkdir(root);
    const file = path.join(root, "index.json");
    const other = path.join(home, "next.jsonl");
    await fs.writeFile(file, "{}");
    await fs.writeFile(other, "next");
    const inventory = await createMetadataInventory([file], root, home);
    let invoked = false;
    await withOperation(operation(home), async () => {
      const plan = createMetadataPlan({ home, inventory, changedPaths: [file], providerId: "codex", conversationIds: ["selected"],
        write: async () => { throw new Error("unknown metadata commit"); }
      });
      await plan.execute(wrapOperationTrash(async () => undefined)).catch(() => undefined);
      await expect(wrapOperationTrash(async () => { invoked = true; })([other]))
        .rejects.toThrow(/The operation failed or could not be confirmed; further changes stopped/);
    });
    expect(invoked).toBe(false);
    expect((await listOperations(home))[0]!.status).toBe("partial");
  });

  it("refuses an escaping version 1 manifest even if its journal digest matches", async () => {
    const home = await fixture();
    const root = path.join(home, ".codex");
    await fs.mkdir(root);
    const file = path.join(root, "index.json");
    await fs.writeFile(file, "{}");
    const inventory = await createMetadataInventory([file], root, home);
    await expect(withOperation(operation(home), async () => {
      const plan = createMetadataPlan({ home, inventory, changedPaths: [file], providerId: "codex", conversationIds: ["selected"],
        write: async () => { throw new Error("interrupted"); }
      });
      await plan.execute(wrapOperationTrash(async () => undefined));
    })).rejects.toThrow("interrupted");
    const [summary] = await listOperations(home);
    const inspected = await inspectOperation(summary!.id, home);
    const manifestFile = inspected.backups[0]!.manifestPath;
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    manifest.files[0].backupPath = path.join(home, "secret.json");
    await fs.writeFile(manifest.files[0].backupPath, "secret", { mode: 0o600 });
    const contents = JSON.stringify(manifest);
    await fs.writeFile(manifestFile, contents);
    const operationFile = path.join(home, ".ai-cli-cleaner", "operations", summary!.id, "operation.json");
    const record = JSON.parse(await fs.readFile(operationFile, "utf8"));
    record.metadata[0].manifestSha256 = createHash("sha256").update(contents).digest("hex");
    await fs.writeFile(operationFile, JSON.stringify(record));
    await expect(inspectOperation(summary!.id, home)).rejects.toThrow(/Manifest backup path is outside the allowed scope/);
    expect(await fs.readFile(manifest.files[0].backupPath, "utf8")).toBe("secret");
  });

  it("refuses symlinks, world-readable files and escaping manifest paths", async () => {
    const home = await fixture();
    await fs.symlink(path.join(home, "elsewhere"), path.join(home, ".ai-cli-cleaner"));
    await expect(withOperation(operation(home), async () => undefined)).rejects.toThrow();
    await fs.rename(path.join(home, ".ai-cli-cleaner"), path.join(home, "old-link"));
    await withOperation(operation(home), async () => undefined);
    const [summary] = await listOperations(home);
    const file = path.join(home, ".ai-cli-cleaner", "operations", summary!.id, "operation.json");
    await fs.chmod(file, 0o644);
    await expect(inspectOperation(summary!.id, home)).rejects.toThrow();
    await expect(inspectOperation("../escape", home)).rejects.toThrow();
  });
});
