import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rewriteJsonl, validateJsonl } from "../src/conversations/metadata-jsonl.js";
import { getPathSize, getPathSnapshot } from "../src/fs/paths.js";
import { readOpenCodeSessions } from "../src/conversations/opencode.js";
import { readCodexArtifactIds } from "../src/conversations/codex-artifacts.js";
import { discoverConversations } from "../src/conversations/discover.js";
import { assertCodexConversationsPathsUnchanged } from "../src/conversations/owned-paths.js";
import { prepareCodexConversationMetadata } from "../src/conversations/codex-metadata.js";
import { prepareGrokDeletion } from "../src/conversations/grok.js";
import type { ConversationRecord } from "../src/conversations/types.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true })));
});

async function homeFixture(): Promise<string> {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-resources-")));
  homes.push(home);
  return home;
}

async function sessionsFixture(count: number, chain: boolean): Promise<string> {
  const home = await homeFixture();
  const root = path.join(home, ".local", "share", "opencode");
  await fs.mkdir(root, { recursive: true });
  const database = new DatabaseSync(path.join(root, "opencode.db"));
  try {
    database.exec("CREATE TABLE session(id TEXT, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER); BEGIN");
    const insert = database.prepare("INSERT INTO session VALUES(?,?,?,'/synthetic',1)");
    for (let index = 0; index < count; index++) {
      insert.run(`ses_resource${index}`, chain && index > 0 ? `ses_resource${index - 1}` : null, "synthetic");
    }
    database.exec("COMMIT");
  } finally { database.close(); }
  return home;
}

describe("bounded provider resources", () => {
  it("refuses oversized JSONL before whole-file reads", async () => {
    const file = path.join(await homeFixture(), "history.jsonl");
    await fs.writeFile(file, "");
    await fs.truncate(file, 64 * 1024 * 1024 + 1);
    const read = vi.spyOn(fs, "readFile");
    await expect(validateJsonl(file, "Codex")).rejects.toThrow(/resource limit/i);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["line length", `{"id":"selected"}\n{"text":"${"x".repeat(1024 * 1024)}"}\n`],
    ["line count", `{"id":"selected"}\n${"\n".repeat(200_000)}`]
  ])("refuses excessive JSONL %s before replacement", async (_label, original) => {
    const file = path.join(await homeFixture(), "history.jsonl");
    await fs.writeFile(file, original);
    const rename = vi.spyOn(fs, "rename");
    const changed = vi.fn();
    await expect(rewriteJsonl(file, "Antigravity", () => false, undefined, changed)).rejects.toThrow(/resource limit/i);
    expect(await fs.readFile(file, "utf8")).toBe(original);
    expect(rename).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("bounds JSONL bytes actually read even if the initial stat is small", async () => {
    const file = path.join(await homeFixture(), "history.jsonl");
    await fs.writeFile(file, "");
    const content = Buffer.alloc(64 * 1024, " ");
    content.write('{"id":"synthetic"}');
    content[content.length - 1] = 10;
    let reads = 0;
    const close = vi.fn(async () => {});
    vi.spyOn(fs, "open").mockResolvedValue({
      stat: async () => ({ size: 0 }),
      read: async (buffer: Buffer) => {
        reads++;
        content.copy(buffer);
        return { bytesRead: content.length, buffer };
      },
      close
    } as unknown as Awaited<ReturnType<typeof fs.open>>);
    await expect(validateJsonl(file, "Codex")).rejects.toThrow(/resource limit/i);
    expect(reads).toBe(1025);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("preserves valid multibyte JSONL rows across incremental read boundaries", async () => {
    const file = path.join(await homeFixture(), "history.jsonl");
    const retained = JSON.stringify({ id: "retained", text: "台灣".repeat(30_000) });
    await fs.writeFile(file, `{"id":"selected"}\r\n${retained}`);
    await rewriteJsonl(file, "Codex", (row) => row.id !== "selected");
    expect(await fs.readFile(file, "utf8")).toBe(`${retained}\n`);
  });

  it("refuses excessive directory depth in size and snapshot modes", async () => {
    const home = await homeFixture();
    await fs.mkdir(path.join(home, ...Array<string>(129).fill("d")), { recursive: true });
    await expect(getPathSize(home)).rejects.toThrow(/resource limit/i);
    await expect(getPathSnapshot(home)).rejects.toThrow(/resource limit/i);
  });

  it("bounds directory enumeration before retaining a complete hostile listing", async () => {
    const home = await homeFixture();
    let yielded = 0;
    vi.spyOn(fs, "opendir").mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 200_000; index++) {
          yielded++;
          yield { name: `synthetic-${index}` };
        }
      }
    } as Awaited<ReturnType<typeof fs.opendir>>);
    await expect(getPathSnapshot(home)).rejects.toThrow(/resource limit/i);
    expect(yielded).toBeLessThanOrEqual(100_001);
  });

  it("refuses cumulative file bytes without reading sparse file contents", async () => {
    const home = await homeFixture();
    const file = path.join(home, "sparse");
    await fs.writeFile(file, "");
    await fs.truncate(file, 2 ** 40 + 1);
    await expect(getPathSize(home)).rejects.toThrow(/resource limit/i);
    await expect(getPathSnapshot(home)).rejects.toThrow(/resource limit/i);
  });

  // 三次真實磁碟掃描均重新驗證深層祖先路徑，預留 Intel CI 的 I/O 時間。
  it("enforces the same depth boundary in Codex discovery and artifact ownership scans", async () => {
    const home = await homeFixture();
    await fs.mkdir(path.join(home, ".codex", "sessions", ...Array<string>(129).fill("d")), { recursive: true });
    await expect(readCodexArtifactIds(home, [])).rejects.toThrow(/resource limit/i);
    await expect(assertCodexConversationsPathsUnchanged([], home)).rejects.toThrow(/resource limit/i);
    const result = await discoverConversations(["codex"], { home });
    expect(result.conversations).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/resource limit/i);
  }, 15_000);

  it("bounds the Codex bulk metadata rollout collection before preparing mutations", async () => {
    const home = await homeFixture();
    await fs.mkdir(path.join(home, ".codex", "sessions", ...Array<string>(129).fill("d")), { recursive: true });
    const trash = vi.fn();
    await expect(prepareCodexConversationMetadata(home, trash)).rejects.toThrow(/resource limit/i);
    expect(trash).not.toHaveBeenCalled();
  });

  it("bounds Grok deletion tree validation reached directly without discovery", async () => {
    const home = await homeFixture();
    const directory = path.join(home, ".grok", "sessions", "group", "selected");
    await fs.mkdir(path.join(directory, ...Array<string>(129).fill("d")), { recursive: true });
    await fs.writeFile(path.join(directory, "summary.json"), '{"info":{"id":"selected"}}');
    const conversation: ConversationRecord = {
      key: "grok:selected", providerId: "grok", providerName: "Grok Build CLI", id: "selected", title: "synthetic",
      dataPaths: [directory], guardPaths: [], sizeBytes: 0, deleteStrategy: { kind: "indexed" }, warnings: []
    };
    await expect(prepareGrokDeletion(conversation, home)).rejects.toThrow(/resource limit/i);
  });

  it("stops a provider when multiple individually valid conversation trees exceed the cumulative budget", async () => {
    const home = await homeFixture();
    const first = path.join(home, ".grok", "sessions", "group", "first");
    const second = path.join(home, ".grok", "sessions", "group", "second");
    await fs.mkdir(first, { recursive: true });
    await fs.mkdir(second, { recursive: true });
    await fs.writeFile(path.join(first, "summary.json"), '{"info":{"id":"first"},"title":"synthetic first"}');
    await fs.writeFile(path.join(second, "summary.json"), '{"info":{"id":"second"},"title":"synthetic second"}');
    await fs.writeFile(path.join(first, "sparse"), "");
    await fs.writeFile(path.join(second, "sparse"), "");
    await fs.truncate(path.join(first, "sparse"), 600 * 1024 ** 3);
    await fs.truncate(path.join(second, "sparse"), 600 * 1024 ** 3);
    await expect(getPathSize(path.dirname(first), { concurrency: 2 })).rejects.toThrow(/resource limit/i);
    const result = await discoverConversations(["grok"], { home });
    expect(result.conversations).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/resource limit/i);
  });

  it("retains UUID-only Antigravity discovery while accepting unrelated named-ID history rows", async () => {
    const home = await homeFixture();
    const root = path.join(home, ".gemini", "antigravity-cli");
    const id = "12345678-1234-1234-1234-123456789abc";
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "history.jsonl"), `{"conversationId":"selected"}\n{"conversationId":"${id}"}\n`);
    const result = await discoverConversations(["antigravity"], { home });
    expect(result.conversations.map((item) => item.id)).toEqual([id]);
    expect(result.conversations[0]?.disabledReason).toBeUndefined();
  });

  it("validates an ordinary long OpenCode chain with linear map work", async () => {
    const home = await sessionsFixture(500, true);
    const original = Map.prototype.get;
    let lookups = 0;
    vi.spyOn(Map.prototype, "get").mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
      if (typeof key === "string" && key.startsWith("ses_resource")) lookups++;
      return original.call(this, key);
    });
    expect(await readOpenCodeSessions(home)).toHaveLength(500);
    expect(lookups).toBeLessThan(500 * 8);
  });

  it("rejects excessive OpenCode parent depth", async () => {
    await expect(readOpenCodeSessions(await sessionsFixture(1025, true))).rejects.toThrow(/resource limit/i);
  });

  it("rejects excessive OpenCode rows", async () => {
    await expect(readOpenCodeSessions(await sessionsFixture(100_001, false))).rejects.toThrow(/resource limit/i);
  });

  it.each(["duplicate", "cycle"])("retains OpenCode %s rejection", async (kind) => {
    const home = await sessionsFixture(2, true);
    const database = new DatabaseSync(path.join(home, ".local", "share", "opencode", "opencode.db"));
    try {
      database.exec(kind === "duplicate"
        ? "UPDATE session SET id='ses_resource0'"
        : "UPDATE session SET parent_id='ses_resource1' WHERE id='ses_resource0'");
    } finally { database.close(); }
    await expect(readOpenCodeSessions(home)).rejects.toThrow(kind === "duplicate" ? /duplicate IDs/ : /cycle/);
  });
});
