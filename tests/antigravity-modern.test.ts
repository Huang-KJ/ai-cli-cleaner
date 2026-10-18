import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverAntigravityConversations } from "../src/conversations/discover-antigravity.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { prepareClean } from "../src/cleaners/plan.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
const id = "11111111-1111-4111-8111-111111111111";
const closed = async () => ({ supported: true, openPaths: [] });
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true }))); });
async function fixture() {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-antigravity-modern-"));
  homes.push(home);
  const root = path.join(home, ".gemini", "antigravity-cli");
  const conversation = path.join(root, "conversations", `${id}.db`);
  await fs.mkdir(path.dirname(conversation), { recursive: true });
  await fs.writeFile(conversation, "synthetic selected contents");
  return { home, root, conversation, proto: path.join(root, "jetbox_summaries_proto.pb") };
}

describe("Antigravity shared protobuf safety", () => {
  it.each(["antigravity-cli", "antigravity-ide"])("keeps an unsupported %s shared summary visible but disables selected deletion without moving anything", async (rootName) => {
    const f = await fixture();
    const proto = path.join(f.home, ".gemini", rootName, "jetbox_summaries_proto.pb");
    await fs.mkdir(path.dirname(proto), { recursive: true });
    await fs.writeFile(proto, Buffer.from(`opaque summary ${id} synthetic title`));
    const result = await discoverAntigravityConversations(f.home);
    const selected = result.conversations.find((item) => item.id === id)!;
    expect(selected.disabledReason).toMatch(/Selected deletion is not supported.*shared protobuf indexes/);
    const trash = vi.fn();
    const deleted = await deleteConversations([{ ...selected, disabledReason: undefined }], { home: f.home, trash, checkOpenPaths: closed });
    expect(deleted.failures).toHaveLength(1);
    expect(deleted.failures[0]?.error.message).toMatch(/Selected deletion is not supported.*shared protobuf indexes/);
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(f.conversation, "utf8")).toBe("synthetic selected contents");
    expect(await fs.readFile(proto, "utf8")).toContain(id);
  });

  it("rejects a nonempty shared summary created after preview", async () => {
    const f = await fixture();
    const selected = (await discoverAntigravityConversations(f.home)).conversations[0]!;
    const trash = vi.fn();
    expect((await deleteConversations([selected], { home: f.home, trash, checkOpenPaths: closed, dryRun: true })).failures).toEqual([]);
    await fs.writeFile(f.proto, "new shared summary");
    const result = await deleteConversations([selected], { home: f.home, trash, checkOpenPaths: closed });
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
  });

  it("rejects a shared summary appearing during the open-file preflight", async () => {
    const f = await fixture();
    const selected = (await discoverAntigravityConversations(f.home)).conversations[0]!;
    const trash = vi.fn();
    const result = await deleteConversations([selected], { home: f.home, trash,
      checkOpenPaths: async () => { await fs.writeFile(f.proto, "new shared summary"); return closed(); } });
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
  });

  it("rejects a shared summary appearing immediately before source Trash", async () => {
    const f = await fixture();
    const selected = (await discoverAntigravityConversations(f.home)).conversations[0]!;
    let calls = 0;
    const trash = vi.fn();
    const result = await deleteConversations([selected], { home: f.home, trash,
      checkOpenPaths: async () => { if (++calls === 2) await fs.writeFile(f.proto, "late shared summary"); return closed(); } });
    expect(calls).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
    expect(await fs.readFile(f.conversation, "utf8")).toBe("synthetic selected contents");
  });

  it("allows preview for an empty shared index without changing either file", async () => {
    const f = await fixture();
    await fs.writeFile(f.proto, "");
    const selected = (await discoverAntigravityConversations(f.home)).conversations[0]!;
    expect(selected.disabledReason).toBeUndefined();
    const trash = vi.fn();
    expect((await deleteConversations([selected], { home: f.home, trash, checkOpenPaths: closed, dryRun: true })).failures).toEqual([]);
    expect(await fs.readFile(f.proto, "utf8")).toBe("");
    expect(trash).not.toHaveBeenCalled();
  });

  it("reports partial metadata changes if a shared summary appears during backup release", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "history.jsonl"), `${JSON.stringify({ conversationId: id, display: "synthetic" })}\n`);
    const selected = (await discoverAntigravityConversations(f.home)).conversations[0]!;
    let count = 0;
    const result = await deleteConversations([selected], { home: f.home, checkOpenPaths: closed,
      trash: async (files) => {
        for (const file of files) {
          await fs.rename(file, path.join(f.home, `moved-${++count}`));
          if (file.includes(`${path.sep}recovery${path.sep}`)) await fs.writeFile(f.proto, "new shared summary");
        }
      } });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.metadataChanged).toBe(true);
    expect(result.failures[0]?.deletedPaths).toEqual([await fs.realpath(f.home).then((home) => path.join(home, path.relative(f.home, f.conversation)))]);
    expect(result.failures[0]?.error.message).toMatch(/Selected deletion is not supported.*shared protobuf indexes/);
  });

  it.each(["symlink", "directory"])("rejects an invalid shared summary path (%s)", async (kind) => {
    const f = await fixture();
    if (kind === "symlink") {
      const outside = path.join(f.home, "outside");
      await fs.writeFile(outside, "");
      await fs.symlink(outside, f.proto);
    } else await fs.mkdir(f.proto);
    const selected = (await discoverAntigravityConversations(f.home)).conversations[0]!;
    expect(selected.disabledReason).toBeTruthy();
    const trash = vi.fn();
    expect((await deleteConversations([{ ...selected, disabledReason: undefined }], { home: f.home, trash, checkOpenPaths: closed })).failures).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
  });

  it.each(["antigravity-cli", "antigravity-ide"])("moves the complete %s shared index and CLI annotations during bulk cleanup while preserving settings and credentials", async (rootName) => {
    const f = await fixture();
    const proto = path.join(f.home, ".gemini", rootName, "jetbox_summaries_proto.pb");
    await fs.mkdir(path.dirname(proto), { recursive: true });
    await fs.writeFile(proto, `opaque summary ${id}`);
    const annotations = path.join(f.root, "annotations");
    await fs.mkdir(annotations);
    await fs.writeFile(path.join(annotations, `${id}.pbtxt`), "synthetic title");
    const preserved = ["settings.json", "installation_id", "jetski_state.pbtxt", "google_credentials"];
    for (const name of preserved) await fs.writeFile(path.join(f.root, name), `preserve ${name}`);
    const moved: string[] = [];
    const trash = async (files: string[]) => {
      for (const file of files) {
        moved.push(file);
        await fs.rename(file, path.join(f.home, `trash-${moved.length}`));
      }
    };
    const result = await (await prepareClean(["antigravity"], { home: f.home, trash, checkOpenPaths: closed })).execute();
    expect(result.failures).toEqual([]);
    expect(moved).toEqual(expect.arrayContaining([proto, annotations, path.dirname(f.conversation)]));
    for (const name of preserved) expect(await fs.readFile(path.join(f.root, name), "utf8")).toBe(`preserve ${name}`);
    for (let n = 0; n < moved.length; n++) await fs.rename(path.join(f.home, `trash-${n + 1}`), moved[n]!);
    expect(await fs.readFile(proto, "utf8")).toContain(id);
    expect(await fs.readFile(path.join(annotations, `${id}.pbtxt`), "utf8")).toBe("synthetic title");
  });
});
