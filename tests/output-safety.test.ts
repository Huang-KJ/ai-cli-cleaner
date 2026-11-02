import { describe, expect, it, vi } from "vitest";
import type { ConversationRecord } from "../src/conversations/types.js";
import { displayText, formatBytes } from "../src/ui/display.js";
import { createCliTestFixture, runCliCommand } from "./helpers/cli.js";

const unsafe = "name\u001b[2J\r\n\u009b\u202e";

function fixture() {
  return createCliTestFixture({
    prepareClean: async () => ({
      entries: [{ providerId: "copilot", providerName: "Copilot", pattern: "fixture",
        path: `/fixture/${unsafe}`, exists: true, sizeBytes: 1 }],
      operations: [unsafe], execute: async () => { throw new Error("Unexpected cleanup execution."); }
    }),
  });
}

describe("safe output", () => {
  it("formats byte counts with decimal units and three significant digits", () => {
    // 數值與原先使用的 pretty-bytes 7.2.0 預設輸出逐一比對一致。
    expect([0, 1, 168, 999, 1000, 1234, 1805, 999_499, 999_500, 1_000_000, 10 ** 12, Number.MAX_SAFE_INTEGER].map(formatBytes))
      .toEqual(["0 B", "1 B", "168 B", "999 B", "1 kB", "1.23 kB", "1.8 kB", "999 kB", "1 MB", "1 MB", "1 TB", "9.01 PB"]);
  });

  it("escapes every Unicode bidirectional control", () => {
    let controls = "";
    for (let point = 0; point <= 0x10ffff; point++) {
      const character = String.fromCodePoint(point);
      if (/\p{Bidi_Control}/u.test(character)) controls += character;
    }
    expect(displayText(controls)).not.toMatch(/\p{Bidi_Control}/u);
    expect(displayText("\u061c\u200e\u200f")).toBe("\\u061c\\u200e\\u200f");
  });

  it.each([{ options: [] }, { options: ["--json"] }])("round-trips safe recovery inspection JSON with options $options", async ({ options }) => {
    const location = "/fixture/臺灣/\u061c\u200e\u200f\u202e\u2066\u2028\u2029";
    const operation = { formatVersion: 1 as const, id: "fixture", kind: "conversations" as const, target: ["grok"],
      startedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", status: "succeeded" as const,
      phase: "ended", plannedPaths: [location], movedPaths: [location], uncertainPaths: [], remainingPaths: [], metadata: [], helperFailed: false };
    const test = createCliTestFixture({ inspectRecovery: async () => ({ operation, backups: [], instructions: [], claims: [] }) });
    expect(await runCliCommand(["recovery", "inspect", "fixture", ...options], test.dependencies)).toBe(0);
    expect(test.logs[0]).not.toMatch(/[\p{Bidi_Control}\u2028\u2029]/u);
    expect(test.logs[0]).toContain("臺灣");
    expect(JSON.parse(test.logs[0]!).operation.plannedPaths).toEqual([location]);
  });

  it("repeats stable bound identifiers in the destructive confirmation", async () => {
    const conversation: ConversationRecord = { key: "copilot:key\u200f", providerId: "copilot", providerName: "Copilot",
      id: "id\u061c", title: "ordinary title", workspace: "/fixture/work\u200e", sizeBytes: 0, dataPaths: [], guardPaths: [], warnings: [],
      deleteStrategy: { kind: "local", metadata: { kind: "copilot" } } };
    const test = createCliTestFixture({ discoverConversations: async () => ({ conversations: [conversation], warnings: [] }),
      checkbox: async () => [conversation.key], confirm: async (options) => {
        expect(options.message).toContain("copilot:key\\u200f");
        expect(options.message).toContain("id\\u061c");
        expect(options.message).not.toMatch(/\p{Bidi_Control}/u);
        return false;
      } });
    expect(await runCliCommand(["conversations", "--target", "copilot"], test.dependencies)).toBe(0);
  });

  it("escapes controls without confusing them with literal escape text", () => {
    expect(displayText(unsafe)).toBe("name\\u001b[2J\\u000d\\u000a\\u009b\\u202e");
    expect(displayText("\\u001b")).toBe("\\\\u001b");
    expect(displayText("臺灣／正常路徑")).toBe("臺灣／正常路徑");
  });

  it("escapes paths and operations in deletion plans", async () => {
    const test = fixture();
    expect(await runCliCommand(["clean", "--target", "copilot", "--dry-run", "--verbose"], test.dependencies)).toBe(0);
    expect(test.logs.join("\n")).not.toMatch(/[\x1b\r\x9b\u202e]/);
    expect(test.logs.join("\n")).toContain(displayText(`/fixture/${unsafe}`));
  });

  it("escapes failures and recovery paths without showing raw controls", async () => {
    const test = fixture();
    test.dependencies.prepareClean = async () => { throw Object.assign(new Error(unsafe), { recoveryPath: `/fixture/${unsafe}` }); };
    expect(await runCliCommand(["clean", "--target", "copilot"], test.dependencies)).toBe(1);
    expect(test.errors.join("\n")).not.toMatch(/[\x1b\r\x9b\u202e]/);
    expect(test.errors.join("\n")).toContain(displayText(unsafe));
  });

  it("escapes conversation titles, IDs, paths, warnings, and result errors", async () => {
    const test = fixture();
    const conversation: ConversationRecord = {
      key: "copilot:one", providerId: "copilot", providerName: "Copilot", id: unsafe, title: unsafe,
      workspace: `/fixture/${unsafe}`, sizeBytes: 0, dataPaths: [], guardPaths: [], warnings: [unsafe],
      deleteStrategy: { kind: "local", metadata: { kind: "copilot" } }
    };
    test.dependencies.discoverConversations = async () => ({ conversations: [conversation], warnings: [unsafe] });
    test.dependencies.checkbox = vi.fn(async (options) => {
      expect(options.choices[0]?.name).toContain(displayText(unsafe));
      expect(options.choices[0]?.description).not.toMatch(/[\x1b\r\x9b\u202e]/);
      return [conversation.key];
    });
    test.dependencies.deleteConversations = async () => ({ deleted: [], previewed: [],
      failures: [{ conversation, error: new Error(unsafe), recoveryPath: `/fixture/${unsafe}`, deletedPaths: [`/fixture/${unsafe}`], metadataChanged: true }] });
    expect(await runCliCommand(["conversations", "--target", "copilot"], test.dependencies)).toBe(1);
    const output = [...test.logs, ...test.warnings].join("\n");
    expect(output).not.toMatch(/[\x1b\r\x9b\u202e]/);
    expect(output).toContain(displayText(unsafe));
    expect(output).not.toContain("Recovery data:");
    expect(test.errors.join("\n")).not.toMatch(/[\x1b\r\x9b\u202e]/);
    expect(test.errors.join("\n")).toContain(displayText(`/fixture/${unsafe}`));
    expect(test.errors.join("\n")).toContain("Some indexes may have changed");
  });
});
