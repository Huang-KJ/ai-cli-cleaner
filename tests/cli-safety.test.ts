import { describe, expect, it, vi } from "vitest";
import type { CleanPlan } from "../src/cleaners/plan.js";
import { manifests } from "../src/cleaners/manifests.js";
import type { ConversationRecord } from "../src/conversations/types.js";
import { createCliTestFixture, runCliCommand } from "./helpers/cli.js";

function fixture() {
  const conversation: ConversationRecord = {
    key: "codex:fixture",
    providerId: "codex",
    providerName: "Codex",
    id: "fixture",
    title: "Fixture conversation",
    sizeBytes: 1,
    dataPaths: ["/fixture/conversation.jsonl"],
    guardPaths: ["/fixture/conversation.jsonl"],
    deleteStrategy: { kind: "indexed" },
    warnings: []
  };
  const plan: CleanPlan = {
    entries: [{ providerId: "copilot", providerName: "Copilot", pattern: "fixture",
      path: "/fixture/.copilot/session-state", exists: true, sizeBytes: 1 }],
    operations: ["清除對話索引"],
    execute: vi.fn(async () => ({ deleted: [], failures: [] }))
  };
  return { ...createCliTestFixture(), plan, conversation };
}

function cleanFixture() {
  const test = fixture();
  test.dependencies.prepareClean = vi.fn(async () => test.plan);
  return test;
}

function stoppableCleanFixture() {
  const test = cleanFixture();
  test.dependencies.stopAgents = vi.fn(async () => {});
  return test;
}

const command = (args: string[], dependencies: ReturnType<typeof createCliTestFixture>["dependencies"]) =>
  runCliCommand(args, dependencies, "test", "ai-cleaner");

function publicCliFixture() {
  const events: string[] = [];
  const item: ConversationRecord = {
    key: "codex:one", id: "one", title: "測試", providerId: "codex", providerName: "Codex",
    updatedAt: "2026-10-13T23:00:00Z", sizeBytes: 10, dataPaths: [], guardPaths: [], warnings: [],
    deleteStrategy: { kind: "indexed" }
  };
  const test = createCliTestFixture({
    confirm: async () => { events.push("confirm"); return true; },
    assertAgentsStopped: async () => { events.push("guard"); },
    prepareClean: async () => { events.push("prepare"); return {
      entries: [{ providerId: "codex", providerName: "Codex", path: "/fixture/memories", pattern: "~/.codex/memories", exists: true, sizeBytes: 10 }],
      operations: [], execute: async () => { events.push("execute"); return { deleted: [], failures: [] }; }
    }; },
    discoverConversations: async () => { events.push("discover"); return { conversations: [item], warnings: [] }; },
    deleteConversations: async (_, options) => { events.push(options.dryRun ? "preview" : "delete"); return { deleted: [], previewed: [], failures: [] }; }
  });
  test.dependencies.checkbox = async (options) => { test.output.push(options.choices[0]!.name); return [item.key]; };
  return { deps: test.dependencies, events, output: test.output };
}

describe("bulk cleanup CLI", () => {
  it.each([
    ["clean", "--all", "--force-stop"],
    ["clean", "--target", "codex", "--dry-run", "--force-stop"],
    ["conversations", "--target", "codex", "--allow-running"],
    ["conversations", "--target", "codex", "--dry-run", "--allow-running"]
  ])("rejects unsupported platforms before cleanup or discovery: %s", async (...args) => {
    const test = fixture();
    const assertSupportedPlatform = vi.fn(() => { throw new Error("目前僅支援 macOS 26 以上版本。"); });
    test.dependencies.assertSupportedPlatform = assertSupportedPlatform;
    test.dependencies.assertAgentsStopped = vi.fn(async () => {});

    expect(await command(args, test.dependencies)).toBe(1);
    expect(assertSupportedPlatform).toHaveBeenCalledOnce();
    expect(test.dependencies.confirm).not.toHaveBeenCalled();
    expect(test.dependencies.stopAgents).not.toHaveBeenCalled();
    expect(test.dependencies.assertAgentsStopped).not.toHaveBeenCalled();
    expect(test.dependencies.prepareClean).not.toHaveBeenCalled();
    expect(test.dependencies.discoverConversations).not.toHaveBeenCalled();
    expect(test.dependencies.selectAgent).not.toHaveBeenCalled();
    expect(test.dependencies.checkbox).not.toHaveBeenCalled();
    expect(test.dependencies.deleteConversations).not.toHaveBeenCalled();
    expect(test.errors).toEqual(["目前僅支援 macOS 26 以上版本。"]);
  });

  it("allows doctor, help, version, and read-only recovery on unsupported platforms", async () => {
    const test = fixture();
    const assertSupportedPlatform = vi.fn(() => { throw new Error("不支援"); });
    test.dependencies.assertSupportedPlatform = assertSupportedPlatform;
    test.dependencies.doctor = vi.fn(async () => ({ ok: true, checks: [], agents: [] }));
    test.dependencies.listRecovery = vi.fn(async () => []);

    expect(await command(["doctor"], test.dependencies)).toBe(0);
    expect(await command(["recovery", "list"], test.dependencies)).toBe(0);
    expect(await command(["--help"], test.dependencies)).toBe(0);
    expect(await command(["--version"], test.dependencies)).toBe(0);
    expect(assertSupportedPlatform).not.toHaveBeenCalled();
  });

  it("shows help and exits successfully when called without arguments", async () => {
    const test = fixture();
    expect(await command([], test.dependencies)).toBe(0);
    expect(test.logs.join("\n")).toContain("clean [options]");
    expect(test.logs.join("\n")).toContain("conversations [options]");
    expect(test.errors).toEqual([]);
    expect(test.dependencies.prepareClean).not.toHaveBeenCalled();
    expect(test.dependencies.discoverConversations).not.toHaveBeenCalled();
  });

  it.each([
    { flags: [] }, { flags: ["--all", "--target", "codex"] },
    { flags: ["--target", ""] }, { flags: ["--target", "unknown"] }
  ])("rejects ambiguous or invalid scopes before preparing deletion: $flags", async ({ flags }) => {
    const test = fixture();
    expect(await command(["clean", ...flags], test.dependencies)).toBe(1);
    expect(test.dependencies.prepareClean).not.toHaveBeenCalled();
    expect(test.plan.execute).not.toHaveBeenCalled();
  });

  it("passes only the selected agents and confirms before execution", async () => {
    const test = cleanFixture();
    const events: string[] = [];
    test.dependencies.prepareClean = vi.fn(async () => { events.push("prepare"); return test.plan; });
    test.dependencies.confirm = vi.fn(async () => { events.push("confirm"); return true; });
    test.plan.execute = vi.fn(async () => { events.push("execute"); return { deleted: test.plan.entries, failures: [] }; });
    expect(await command(["clean", "--target", "codex,copilot,codex"], test.dependencies)).toBe(0);
    expect(test.dependencies.prepareClean).toHaveBeenCalledExactlyOnceWith(["codex", "copilot"], { includeMemories: false });
    expect(events).toEqual(["prepare", "confirm", "execute"]);
    expect(test.logs.join("\n")).toContain("Moved to Trash: 1");
  });

  it("selects every supported agent with --all and allows explicit --yes", async () => {
    const test = stoppableCleanFixture();
    expect(await command(["clean", "--all", "--yes", "--force-stop"], test.dependencies)).toBe(0);
    expect(test.dependencies.prepareClean).toHaveBeenCalledExactlyOnceWith(manifests.map((manifest) => manifest.id), { includeMemories: false });
    expect(test.dependencies.stopAgents).toHaveBeenCalledExactlyOnceWith(manifests.map((manifest) => manifest.id));
    expect(test.dependencies.confirm).not.toHaveBeenCalled();
    expect(test.plan.execute).toHaveBeenCalledOnce();
  });

  it.each([
    { flags: ["--all"], included: false },
    { flags: ["--target", "codex,claude,grok"], included: false },
    { flags: ["--all", "--include-memories"], included: true },
    { flags: ["--target", "codex", "--include-memories"], included: true }
  ])("forwards the explicit memory policy during read-only preview: $flags", async ({ flags, included }) => {
    const test = cleanFixture();
    expect(await command(["clean", ...flags, "--dry-run", "--verbose"], test.dependencies)).toBe(0);
    expect(test.dependencies.prepareClean).toHaveBeenCalledWith(expect.any(Array), { includeMemories: included });
    expect(test.logs.join("\n")).toContain(included ? "Memories: included." : "Memories: kept");
    const scope = test.logs.find((line) => line.startsWith("Cleanup scope:"))!;
    expect(scope.includes("memories")).toBe(included);
    expect(test.dependencies.confirm).not.toHaveBeenCalled();
    expect(test.plan.execute).not.toHaveBeenCalled();
  });

  it.each([false, true])("discloses memory handling in cleanup confirmation (included=%s)", async (included) => {
    const test = cleanFixture();
    const prompts: string[] = [];
    test.dependencies.confirm = vi.fn(async ({ message }) => { prompts.push(message); return false; });
    expect(await command(["clean", "--all", ...(included ? ["--include-memories"] : [])], test.dependencies)).toBe(0);
    expect(prompts).toEqual([included
      ? "Move selected history, related data, and memories to Trash?"
      : "Move selected history and related data to Trash? Memories will be kept."]);
    expect(test.plan.execute).not.toHaveBeenCalled();
  });

  it("confirms stopping the selected agents before preparing the deletion plan", async () => {
    const test = stoppableCleanFixture();
    const events: string[] = [];
    test.dependencies.confirm = vi.fn(async ({ message }) => {
      events.push(message.startsWith("Stop") ? "confirm-stop" : "confirm-delete");
      return true;
    });
    test.dependencies.stopAgents = vi.fn(async (targets) => { events.push(`stop:${targets.join(",")}`); });
    test.dependencies.prepareClean = vi.fn(async () => { events.push("prepare"); return test.plan; });
    test.plan.execute = vi.fn(async () => { events.push("execute"); return { deleted: [], failures: [] }; });

    expect(await command(["clean", "--target", "codex,copilot", "--force-stop"], test.dependencies)).toBe(0);
    expect(test.dependencies.stopAgents).toHaveBeenCalledExactlyOnceWith(["codex", "copilot"]);
    expect(events).toEqual(["confirm-stop", "stop:codex,copilot", "prepare", "confirm-delete", "execute"]);
  });

  it("cancels before stopping agents when the stop confirmation is declined", async () => {
    const test = fixture();
    test.dependencies.confirm = vi.fn(async () => false);
    expect(await command(["clean", "--target", "copilot", "--force-stop"], test.dependencies)).toBe(0);
    expect(test.dependencies.stopAgents).not.toHaveBeenCalled();
    expect(test.dependencies.prepareClean).not.toHaveBeenCalled();
  });

  it("fails closed when stopping agents fails", async () => {
    const test = fixture();
    test.dependencies.stopAgents = vi.fn(async () => { throw new Error("無法停止代理"); });
    expect(await command(["clean", "--all", "--yes", "--force-stop"], test.dependencies)).toBe(1);
    expect(test.dependencies.prepareClean).not.toHaveBeenCalled();
    expect(test.plan.execute).not.toHaveBeenCalled();
    expect(test.errors).toEqual(["無法停止代理"]);
  });

  it("verbose dry-run shows the complete plan without confirmation or execution", async () => {
    const test = cleanFixture();
    expect(await command(["clean", "--target", "copilot", "--dry-run", "--verbose", "--yes", "--force-stop"], test.dependencies)).toBe(0);
    expect(test.dependencies.prepareClean).toHaveBeenCalledOnce();
    expect(test.dependencies.stopAgents).not.toHaveBeenCalled();
    expect(test.dependencies.confirm).not.toHaveBeenCalled();
    expect(test.plan.execute).not.toHaveBeenCalled();
    expect(test.logs.join("\n")).toContain(test.plan.entries[0]!.path);
    expect(test.logs.join("\n")).toContain(test.plan.operations[0]);
    expect(test.logs.join("\n")).toContain("No original data was deleted");
  });

  it("summarizes large cleanup plans by default and explains how to view details", async () => {
    const test = cleanFixture();
    test.plan.entries = Array.from({ length: 100 }, (_, index) => ({
      ...test.plan.entries[0]!, path: `/fixture/private-${index}`, sizeBytes: 10
    }));
    test.plan.operations = ["private-index-update"];
    expect(await command(["clean", "--all", "--dry-run"], test.dependencies)).toBe(0);
    expect(test.logs.join("\n")).toContain("Cleanup: 100 items (1 kB), 1 index updates.");
    expect(test.logs.join("\n")).toContain("--verbose");
    expect(test.logs.join("\n")).not.toContain("/fixture/");
    expect(test.logs.join("\n")).not.toContain("private-index-update");
    expect(test.logs.join("\n")).not.toContain("Cleanup scope:");
    expect(test.logs.length).toBeLessThanOrEqual(6);
    expect(test.plan.execute).not.toHaveBeenCalled();
  });

  it("keeps stop and cleanup prompts short without dropping the desktop shutdown impact", async () => {
    const test = stoppableCleanFixture();
    const messages: string[] = [];
    test.dependencies.confirm = vi.fn(async ({ message }) => { messages.push(message); return true; });
    expect(await command(["clean", "--all", "--force-stop"], test.dependencies)).toBe(0);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("Interrupts current work");
    expect(messages[0]).toContain("ChatGPT/Codex and Claude desktop apps");
    for (const message of messages) expect(message.length).toBeLessThan(120);
    expect(test.logs.join("\n")).toContain(`Agents: ${manifests.map((manifest) => manifest.id).join(", ")}`);
  });

  it("cancellation preserves the prepared data", async () => {
    const test = cleanFixture();
    test.dependencies.confirm = vi.fn(async () => false);
    expect(await command(["clean", "--target", "copilot"], test.dependencies)).toBe(0);
    expect(test.plan.execute).not.toHaveBeenCalled();
    expect(test.logs.join("\n")).toContain("Deletion cancelled");
  });

  it("empty data exits without confirmation or execution", async () => {
    const test = cleanFixture();
    test.plan.entries = [];
    test.plan.operations = [];
    expect(await command(["clean", "--all"], test.dependencies)).toBe(0);
    expect(test.dependencies.confirm).not.toHaveBeenCalled();
    expect(test.plan.execute).not.toHaveBeenCalled();
  });

  it("executes metadata-only cleanup when no conversation files remain", async () => {
    const test = cleanFixture();
    test.plan.entries = [];
    expect(await command(["clean", "--target", "codex", "--yes"], test.dependencies)).toBe(0);
    expect(test.plan.execute).toHaveBeenCalledOnce();
  });

  it("preflight failure prevents confirmation and any deletion", async () => {
    const test = fixture();
    test.dependencies.prepareClean = vi.fn(async () => { throw new Error("索引無法驗證"); });
    expect(await command(["clean", "--all", "--yes"], test.dependencies)).toBe(1);
    expect(test.dependencies.confirm).not.toHaveBeenCalled();
    expect(test.plan.execute).not.toHaveBeenCalled();
    expect(test.errors).toEqual(["索引無法驗證"]);
  });

  it("reports partial failures and recovery paths with a nonzero exit code", async () => {
    const test = cleanFixture();
    test.plan.execute = vi.fn(async () => ({
      deleted: test.plan.entries,
      failures: [{ providerId: "codex" as const, message: "更新索引失敗", recoveryPath: "/fixture/recovery" }]
    }));
    expect(await command(["clean", "--all", "--yes"], test.dependencies)).toBe(1);
    expect(test.logs.join("\n")).toContain("failed: 1");
    expect(test.errors.join("\n")).toContain("/fixture/recovery");
  });

  it("reports an execution error without an unhandled rejection", async () => {
    const test = cleanFixture();
    test.plan.execute = vi.fn(async () => { throw Object.assign(new Error("資料已變動"), { recoveryPath: "/fixture/recovery" }); });
    expect(await command(["clean", "--target", "copilot", "--yes"], test.dependencies)).toBe(1);
    expect(test.errors.join("\n")).toContain("資料已變動");
    expect(test.errors.join("\n")).toContain("/fixture/recovery");
  });

  it.each(["scan", "targets", "recovery"])("does not expose the removed %s command", async (name) => {
    const test = fixture();
    expect(await command([name], test.dependencies)).toBe(1);
    expect(test.dependencies.prepareClean).not.toHaveBeenCalled();
  });

  it.each(["--cache-only", "--force", "--force-open", "--force-changed", "--allow-partial", "--stop-processes", "--json"])(
    "rejects the removed %s option before preparing deletion", async (flag) => {
      const test = fixture();
      expect(await command(["clean", "--all", flag], test.dependencies)).toBe(1);
      expect(test.dependencies.prepareClean).not.toHaveBeenCalled();
    }
  );

  it("returns 130 on interrupted prompts without a stack trace", async () => {
    const test = cleanFixture();
    test.dependencies.confirm = async () => { throw Object.assign(new Error("User force closed the prompt"), { name: "ExitPromptError" }); };
    expect(await command(["clean", "--all"], test.dependencies)).toBe(130);
    expect(test.plan.execute).not.toHaveBeenCalled();
    expect(test.errors).toEqual(["Operation interrupted."]);
    expect(test.logs.join("\n")).not.toContain("Operation interrupted");
  });
});

describe("selected-conversation agent shutdown", () => {
  it.each([false, true])("uses the same memory policy for discovery and selected deletion (included=%s)", async (included) => {
    const test = fixture();
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [test.conversation], warnings: [] }));
    test.dependencies.checkbox = vi.fn(async () => [test.conversation.key]);
    test.dependencies.deleteConversations = vi.fn(async () => ({ deleted: [test.conversation], previewed: [], failures: [] }));
    const prompts: string[] = [];
    test.dependencies.confirm = vi.fn(async ({ message }) => { prompts.push(message); return true; });
    expect(await command(["conversations", "--target", "codex", ...(included ? ["--include-memories"] : [])], test.dependencies)).toBe(0);
    expect(test.dependencies.discoverConversations).toHaveBeenCalledExactlyOnceWith(["codex"], { includeMemories: included });
    expect(test.dependencies.deleteConversations).toHaveBeenCalledExactlyOnceWith([test.conversation], { dryRun: false, includeMemories: included });
    expect(prompts[0]).toContain(included ? "Include supported memory records." : "Keep memories.");
  });

  it("stops only the selected agent after the deletion prompt explains the stop", async () => {
    const test = fixture();
    const events: string[] = [];
    let confirmationMessage = "";
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [test.conversation], warnings: [] }));
    test.dependencies.checkbox = vi.fn(async () => [test.conversation.key]);
    test.dependencies.confirm = vi.fn(async ({ message }) => {
      confirmationMessage = message;
      events.push("confirm");
      return true;
    });
    test.dependencies.stopAgents = vi.fn(async (targets) => { events.push(`stop:${targets.join(",")}`); });
    test.dependencies.deleteConversations = vi.fn(async () => {
      events.push("delete");
      return { deleted: [test.conversation], previewed: [], failures: [] };
    });

    expect(await command(["conversations", "--target", "codex", "--force-stop"], test.dependencies)).toBe(0);
    expect(test.dependencies.stopAgents).toHaveBeenCalledExactlyOnceWith(["codex"]);
    expect(events).toEqual(["confirm", "stop:codex", "delete"]);
    expect(confirmationMessage).toContain("Stop all running Codex agents");
    expect(confirmationMessage).toContain("ChatGPT/Codex desktop app");
  });

  it("does not stop agents in dry-run mode", async () => {
    const test = fixture();
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [test.conversation], warnings: [] }));
    test.dependencies.checkbox = vi.fn(async () => [test.conversation.key]);
    test.dependencies.deleteConversations = vi.fn(async () => ({ deleted: [], previewed: [], failures: [] }));
    expect(await command(["conversations", "--target", "codex", "--force-stop", "--dry-run"], test.dependencies)).toBe(0);
    expect(test.dependencies.stopAgents).not.toHaveBeenCalled();
    expect(test.dependencies.confirm).not.toHaveBeenCalled();
    expect(test.dependencies.deleteConversations).toHaveBeenCalledExactlyOnceWith([test.conversation], { dryRun: true, includeMemories: false });
  });

  it("does not stop agents when deletion is cancelled or nothing is selected", async () => {
    const cancelled = fixture();
    cancelled.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [cancelled.conversation], warnings: [] }));
    cancelled.dependencies.checkbox = vi.fn(async () => [cancelled.conversation.key]);
    cancelled.dependencies.confirm = vi.fn(async () => false);
    expect(await command(["conversations", "--target", "codex", "--force-stop"], cancelled.dependencies)).toBe(0);
    expect(cancelled.dependencies.stopAgents).not.toHaveBeenCalled();
    expect(cancelled.dependencies.deleteConversations).not.toHaveBeenCalled();

    const empty = fixture();
    empty.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [empty.conversation], warnings: [] }));
    expect(await command(["conversations", "--target", "codex", "--force-stop"], empty.dependencies)).toBe(0);
    expect(empty.dependencies.stopAgents).not.toHaveBeenCalled();
  });

  it("fails closed when stopping the selected agent fails", async () => {
    const test = fixture();
    test.dependencies.discoverConversations = vi.fn(async () => ({ conversations: [test.conversation], warnings: [] }));
    test.dependencies.checkbox = vi.fn(async () => [test.conversation.key]);
    test.dependencies.stopAgents = vi.fn(async () => { throw new Error("無法停止代理"); });
    expect(await command(["conversations", "--target", "codex", "--force-stop"], test.dependencies)).toBe(1);
    expect(test.dependencies.deleteConversations).not.toHaveBeenCalled();
    expect(test.errors).toEqual(["無法停止代理"]);
  });
});

describe("public beta CLI guards", () => {
  const command = runCliCommand;

  it("--yes cannot bypass the offline guard", async () => {
    const test = publicCliFixture();
    test.deps.assertAgentsStopped = async () => { throw new Error("Agent 仍在執行"); };
    expect(await command(["clean", "--target", "codex", "--yes"], test.deps)).toBe(1);
    expect(test.events).toEqual([]);
    expect(test.output.join("\n")).toContain("仍在執行");
  });
  it("checks again immediately before mutation", async () => {
    const test = publicCliFixture();
    expect(await command(["clean", "--target", "codex"], test.deps)).toBe(0);
    expect(test.events).toEqual(["guard", "prepare", "confirm", "guard", "execute"]);
  });
  it("fails closed if a new process starts after confirmation", async () => {
    const test = publicCliFixture();
    let checks = 0;
    test.deps.assertAgentsStopped = async () => { if (++checks === 2) throw new Error("Agent 重新啟動"); };
    expect(await command(["clean", "--target", "codex", "--yes"], test.deps)).toBe(1);
    expect(test.events).toEqual(["prepare"]);
  });
  it("dry-run does not stop agents or require an offline guard", async () => {
    const test = publicCliFixture();
    test.deps.assertAgentsStopped = async () => { throw new Error("不應檢查"); };
    expect(await command(["clean", "--target", "codex", "--dry-run", "--force-stop"], test.deps)).toBe(0);
    expect(test.events).toEqual(["prepare"]);
  });
  it("shows full Codex scope only with verbose output", async () => {
    const test = publicCliFixture();
    expect(await command(["clean", "--target", "codex", "--dry-run", "-v"], test.deps)).toBe(0);
    const output = test.output.join("\n");
    for (const name of ["memories", "goals", "queue", "generated_images", "visualizations"]) expect(output).toContain(name);
    expect(output).toContain("~/Documents/Codex");
    expect(output).toContain("YYYY-MM-DD workspace folders");
    expect(output).toContain("all contained files");
    expect(output).toContain("generated and project files");
  });
  it.each([{ flags: [] }, { flags: ["--dry-run"] }, { flags: ["--yes"] }])("always discloses dated workspace contents before cleanup: $flags", async ({ flags }) => {
    const test = cleanFixture();
    test.plan.entries = [{ providerId: "codex", providerName: "Codex", pattern: "~/Documents/Codex",
      path: "/fixture/Documents/Codex/2026-10-25", exists: true, sizeBytes: 1 }];
    test.dependencies.confirm = async () => {
      expect(test.warnings.join("\n")).toContain("all files inside, including project files");
      return true;
    };
    expect(await command(["clean", "--target", "codex", ...flags], test.dependencies)).toBe(0);
    expect(test.warnings.join("\n")).toContain("~/Documents/Codex/YYYY-MM-DD");
    expect(test.warnings.join("\n")).toContain("all files inside, including project files");
  });
  it("selected conversations require an offline guard by default", async () => {
    const test = publicCliFixture();
    expect(await command(["conversations", "--target", "codex"], test.deps)).toBe(0);
    expect(test.events).toEqual(["guard", "discover", "confirm", "guard", "delete"]);
  });
  it("rejects --allow-running before discovery, confirmation, or deletion", async () => {
    const test = publicCliFixture();
    test.deps.assertAgentsStopped = async () => { throw new Error("Agent 仍在執行"); };
    expect(await command(["conversations", "--target", "codex", "--allow-running"], test.deps)).toBe(1);
    expect(test.events).toEqual([]);
    expect(test.output.join("\n")).toContain("Close the selected agents");
  });
  it("keeps --allow-running dry-run read-only without requiring stopped agents", async () => {
    const test = publicCliFixture();
    test.deps.assertAgentsStopped = async () => { throw new Error("Agent 仍在執行"); };
    expect(await command(["conversations", "--target", "codex", "--allow-running", "--dry-run"], test.deps)).toBe(0);
    expect(test.events).toEqual(["discover", "preview"]);
  });
  it("rejects allow-running with force-stop and rejects it for bulk deletion", async () => {
    const test = publicCliFixture();
    expect(await command(["conversations", "--target", "codex", "--allow-running", "--force-stop"], test.deps)).toBe(1);
    expect(await command(["clean", "--target", "codex", "--allow-running"], test.deps)).toBe(1);
    expect(test.events).toEqual([]);
  });
  it("accepts an explicit timezone and reports an invalid one before discovery", async () => {
    const test = publicCliFixture();
    expect(await command(["conversations", "--target", "codex", "--dry-run", "--timezone", "UTC"], test.deps)).toBe(0);
    expect(test.output.join("\n")).toContain("2026/10/13 23:00");
    const bad = publicCliFixture();
    expect(await command(["conversations", "--target", "codex", "--timezone", "Invalid/Zone"], bad.deps)).toBe(1);
    expect(bad.events).toEqual([]);
    expect(bad.output.join("\n")).toContain("time zone");
  });
});
