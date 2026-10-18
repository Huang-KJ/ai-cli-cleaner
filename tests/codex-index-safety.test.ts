import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});

describe("Codex malformed index ID", () => {
  it.each([
    { id: "../invalid", thread_name: "invalid" },
    { id: "../invalid" },
    { id: "" },
    { id: 17 },
    { thread_id: "../invalid" }
  ])("keeps valid inventory visible and refuses deletion for invalid index record $id", async (invalid) => {
    const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-codex-index-")));
    homes.push(home);
    const root = path.join(home, ".codex");
    const rollout = path.join(root, "sessions", "valid.jsonl");
    await fs.mkdir(path.dirname(rollout), { recursive: true });
    await fs.writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "valid" } })}\n`);
    const file = path.join(root, "session_index.jsonl");
    const index = `${JSON.stringify(invalid)}\n${JSON.stringify({ id: "index-only", thread_name: "valid title" })}\n`;
    await fs.writeFile(file, index);

    const discovery = await discoverConversations(["codex"], { home });
    expect(discovery.conversations.map((item) => item.id).sort()).toEqual(["index-only", "valid"]);
    expect(discovery.warnings.join("\n")).toMatch(/Codex session index format or conversation IDs cannot be fully validated; deletion disabled:/);
    expect(discovery.conversations.every((item) => Boolean(item.disabledReason))).toBe(true);
    const result = await deleteConversations(discovery.conversations, {
      home, checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: async () => { throw new Error("不得搬移任何資料"); }
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.every((item) => item.error.message === item.conversation.disabledReason)).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe(index);
    expect(await fs.readFile(rollout, "utf8")).toContain('"id":"valid"');
    await expect(fs.lstat(path.join(home, ".ai-cli-cleaner"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discovers a valid index ID without a title and deletes its selected reference", async () => {
    const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-codex-index-")));
    homes.push(home);
    const root = path.join(home, ".codex");
    await fs.mkdir(root);
    const file = path.join(root, "session_index.jsonl");
    await fs.writeFile(file, `${JSON.stringify({ id: "titleless" })}\n`);
    const discovery = await discoverConversations(["codex"], { home });
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations).toHaveLength(1);
    expect(discovery.conversations[0]).toMatchObject({ id: "titleless", title: "titleless" });
    expect(discovery.conversations[0]?.disabledReason).toBeUndefined();
    const result = await deleteConversations(discovery.conversations, {
      home, checkOpenPaths: async () => ({ supported: true, openPaths: [] }),
      trash: async (files) => {
        const directory = path.join(home, "fixture-trash");
        await fs.mkdir(directory, { recursive: true });
        for (const source of files) await fs.rename(source, path.join(directory, path.basename(source)));
      }
    });
    expect(result.failures).toEqual([]);
    expect(result.deleted).toHaveLength(1);
    expect(await fs.readFile(file, "utf8")).toBe("");
  });
});
