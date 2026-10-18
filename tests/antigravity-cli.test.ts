import { describe, expect, it, vi } from "vitest";
import type { ConversationRecord } from "../src/conversations/types.js";
import { createCliTestFixture, runCliCommand } from "./helpers/cli.js";

describe("selected-conversation CLI", () => {
  it("previews only selected conversations and returns to the Agent menu", async () => {
    const test = createCliTestFixture();
    const first = conversation("first");
    const second = conversation("second");
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [first, second], warnings: [] }));
    test.dependencies.selectAgent = vi.fn().mockResolvedValueOnce("antigravity").mockResolvedValueOnce(undefined);
    test.dependencies.checkbox = vi.fn(async () => [first.key]);
    test.dependencies.deleteConversations = vi.fn(async (selected) => ({ deleted: [], previewed: selected, failures: [] }));

    expect(await runCliCommand(["conversations", "--dry-run"], test.dependencies)).toBe(0);
    expect(test.dependencies.discoverConversations).toHaveBeenCalledExactlyOnceWith(["antigravity"]);
    expect(test.dependencies.deleteConversations).toHaveBeenCalledExactlyOnceWith([first], { dryRun: true });
    expect(test.dependencies.confirm).not.toHaveBeenCalled();
    expect(test.logs.join("\n")).toContain("Preview complete: 1 conversations selected.");
  });

  it("uses a fixed target once without showing an Agent menu", async () => {
    const test = createCliTestFixture();
    const selected = conversation("selected");
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [selected], warnings: [] }));
    test.dependencies.checkbox = vi.fn(async () => [selected.key]);
    test.dependencies.deleteConversations = vi.fn(async () => ({ deleted: [], previewed: [], failures: [] }));
    expect(await runCliCommand(["conversations", "--target", "antigravity"], test.dependencies)).toBe(0);
    expect(test.dependencies.selectAgent).not.toHaveBeenCalled();
    expect(test.dependencies.confirm).toHaveBeenCalledOnce();
    expect(test.dependencies.deleteConversations).toHaveBeenCalledExactlyOnceWith([selected], { dryRun: false });
    expect(test.dependencies.discoverConversations).toHaveBeenCalledOnce();
  });

  it("requires confirmation and cancellation leaves selected conversations untouched", async () => {
    const test = createCliTestFixture();
    const selected = conversation("selected");
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [selected], warnings: [] }));
    test.dependencies.checkbox = vi.fn(async () => [selected.key]);
    test.dependencies.confirm = vi.fn(async () => false);
    expect(await runCliCommand(["conversations", "--target", "antigravity"], test.dependencies)).toBe(0);
    expect(test.dependencies.deleteConversations).not.toHaveBeenCalled();
    expect(test.logs.join("\n")).toContain("Deletion cancelled.");
  });

  it("never passes disabled or unknown keys to deletion", async () => {
    const test = createCliTestFixture();
    const selected = conversation("selected");
    const retained = conversation("retained");
    const disabled = { ...conversation("blocked"), disabledReason: "Data is unsafe." };
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [selected, retained, disabled], warnings: [] }));
    test.dependencies.checkbox = vi.fn(async () => [selected.key, disabled.key, "stale-key"]);
    test.dependencies.deleteConversations = vi.fn(async () => ({ deleted: [], previewed: [], failures: [] }));
    expect(await runCliCommand(["conversations", "--target", "antigravity"], test.dependencies)).toBe(0);
    expect(test.dependencies.deleteConversations).toHaveBeenCalledExactlyOnceWith([selected], { dryRun: false });
  });

  it("does not confirm or delete when only unavailable keys are returned", async () => {
    const test = createCliTestFixture();
    const disabled = { ...conversation("blocked"), disabledReason: "Data is unsafe." };
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [disabled], warnings: [] }));
    test.dependencies.checkbox = vi.fn(async () => [disabled.key, "stale-key"]);
    expect(await runCliCommand(["conversations", "--target", "antigravity"], test.dependencies)).toBe(0);
    expect(test.dependencies.confirm).not.toHaveBeenCalled();
    expect(test.dependencies.deleteConversations).not.toHaveBeenCalled();
  });

  it("Esc exits a fixed-target conversation list without deletion", async () => {
    const test = createCliTestFixture();
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [conversation("one")], warnings: [] }));
    test.dependencies.checkbox = vi.fn(async () => undefined);
    expect(await runCliCommand(["conversations", "--target", "antigravity"], test.dependencies)).toBe(0);
    expect(test.dependencies.discoverConversations).toHaveBeenCalledOnce();
    expect(test.dependencies.deleteConversations).not.toHaveBeenCalled();
  });

  it("an empty fixed target exits without repeatedly discovering", async () => {
    const test = createCliTestFixture({
      discoverConversations: vi.fn(async () => ({ conversations: [], warnings: [] }))
    });
    expect(await runCliCommand(["conversations", "--target", "antigravity"], test.dependencies)).toBe(0);
    expect(test.dependencies.discoverConversations).toHaveBeenCalledOnce();
    expect(test.dependencies.checkbox).not.toHaveBeenCalled();
    expect(test.dependencies.deleteConversations).not.toHaveBeenCalled();
  });

  it("handles a rejected discovery at the shared command error boundary", async () => {
    const test = createCliTestFixture();
    test.dependencies.discoverConversations = vi.fn(async () => { throw new Error("Conversation list read failed."); });
    expect(await runCliCommand(["conversations", "--target", "antigravity"], test.dependencies)).toBe(1);
    expect(test.dependencies.checkbox).not.toHaveBeenCalled();
    expect(test.dependencies.deleteConversations).not.toHaveBeenCalled();
    expect(test.errors).toEqual(["Conversation list read failed."]);
  });

  it("refuses a discovery result containing another provider", async () => {
    const test = createCliTestFixture();
    const foreign = { ...conversation("other"), providerId: "codex" as const };
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [foreign], warnings: [] }));
    expect(await runCliCommand(["conversations", "--target", "antigravity"], test.dependencies)).toBe(1);
    expect(test.dependencies.checkbox).not.toHaveBeenCalled();
    expect(test.dependencies.deleteConversations).not.toHaveBeenCalled();
    expect(test.errors.join("\n")).toContain("another agent");
  });

  it.each(["codex,copilot", "", "unknown"])("rejects an invalid single target %j before discovery", async (target) => {
    const test = createCliTestFixture();
    expect(await runCliCommand(["conversations", "--target", target], test.dependencies)).toBe(1);
    expect(test.dependencies.selectAgent).not.toHaveBeenCalled();
    expect(test.dependencies.discoverConversations).not.toHaveBeenCalled();
  });

  it.each(["--search", "--workspace", "--older-than", "--min-size", "--force-open", "--yes"])(
    "rejects the removed %s option before discovery", async (flag) => {
      const test = createCliTestFixture();
      expect(await runCliCommand(["conversations", flag], test.dependencies)).toBe(1);
      expect(test.dependencies.discoverConversations).not.toHaveBeenCalled();
      expect(test.dependencies.selectAgent).not.toHaveBeenCalled();
    }
  );

  it("returns a failure status and displays the failed conversation", async () => {
    const test = createCliTestFixture();
    const selected = conversation("selected");
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [selected], warnings: [] }));
    test.dependencies.checkbox = vi.fn(async () => [selected.key]);
    test.dependencies.deleteConversations = vi.fn(async () => ({
      deleted: [], previewed: [],
      failures: [{ conversation: selected, error: new Error("Index changed"), recoveryPath: "/fixture/recovery" }]
    }));
    expect(await runCliCommand(["conversations", "--target", "antigravity"], test.dependencies)).toBe(1);
    expect(test.logs.join("\n")).toContain("Deleted: 0; failed: 1.");
    expect(test.logs.join("\n")).not.toContain("Index changed");
    expect(test.errors.join("\n")).toContain("Index changed");
    expect(test.errors.join("\n")).toContain("/fixture/recovery");
  });
});

function conversation(id: string): ConversationRecord {
  return {
    key: `antigravity:${id}`, providerId: "antigravity", providerName: "Google Antigravity", id, title: id,
    updatedAt: "2026-09-19T12:00:00.000Z", workspace: "/fixture/project", sizeBytes: 1234,
    dataPaths: [`/fixture/${id}`], guardPaths: [], warnings: [],
    deleteStrategy: { kind: "local", metadata: { kind: "antigravity" } }
  };
}
