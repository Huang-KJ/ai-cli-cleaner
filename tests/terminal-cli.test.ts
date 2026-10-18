import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const source = new URL("../src/", import.meta.url).href;
// 子程序直接載入來源，避免依賴其他測試或代理正在重建的 dist。
const script = `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(${JSON.stringify(source)}) && specifier.endsWith('.js')) {
    return next(specifier.slice(0, -3) + '.ts', context);
  }
  return next(specifier, context);
}});
const { runCli } = await import(${JSON.stringify(new URL("cli.ts", source).href)});
const { confirmConversationDeletion } = await import(${JSON.stringify(new URL("ui/conversation-prompts.ts", source).href)});
const events = [];
const code = await runCli(['node', 'ai-cleaner', ...process.argv.slice(1)], 'test', {
  assertSupportedPlatform: () => {},
  confirm: async (options) => { events.push('confirm'); return confirmConversationDeletion(options); },
  selectAgent: async () => { events.push('select'); return undefined; },
  checkbox: async () => { events.push('checkbox'); return []; },
  assertAgentsStopped: async () => { events.push('guard'); },
  stopAgents: async () => { events.push('stop'); },
  prepareClean: async () => { events.push('prepare'); return {
    entries: [{ providerId: 'codex', providerName: 'Codex', path: '/synthetic-only', exists: true, sizeBytes: 1 }],
    operations: [], execute: async () => { events.push('execute'); return {deleted: [], failures: []}; }
  }; },
  discoverConversations: async () => { events.push('discover'); return {conversations: [], warnings: []}; },
  deleteConversations: async () => { throw Error('Unexpected synthetic deletion'); },
  doctor: async () => ({ ok: true, checks: [], agents: [] }),
  listRecovery: async () => [],
  log: console.log, warn: console.warn, error: console.error
});
console.log('EVENTS=' + JSON.stringify(events));
process.exitCode = code;
`;

function command(args: string[], input = "") {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, "--", ...args], {
    input, encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024,
    env: { ...process.env, NODE_NO_WARNINGS: "1" }
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const events = JSON.parse(/^EVENTS=(.+)$/m.exec(result.stdout)?.[1] ?? "null") as string[] | null;
  return { ...result, events };
}

describe("non-interactive terminal contracts", () => {
  it.each([
    ["clean", "--target", "codex"],
    ["clean", "--target", "codex", "--force-stop"],
    ["conversations"],
    ["conversations", "--target", "codex", "--dry-run"]
  ])("rejects closed stdin before preparing or accessing agent data: %j", (...args) => {
    const result = command(args);
    expect(result.status).toBe(1);
    expect(result.events).toEqual([]);
    expect(result.stderr).toContain("interactive terminal");
    expect(result.stderr).not.toContain("unsettled top-level await");
    expect(result.stdout).not.toMatch(/\x1b|\(y\/N\)/);
  });

  it("does not accept piped y as cleanup confirmation", () => {
    const result = command(["clean", "--target", "codex"], "y\n");
    expect(result.status).toBe(1);
    expect(result.events).toEqual([]);
    expect(result.stderr).toContain("--yes");
  });

  it("allows explicit --yes without prompting", () => {
    const result = command(["clean", "--target", "codex", "--yes"]);
    expect(result.status).toBe(0);
    expect(result.events).toEqual(["guard", "prepare", "guard", "execute"]);
    expect(result.stdout).toContain("Moved to Trash");
  });

  it("allows dry-run without prompting, stopping agents, or deleting", () => {
    const result = command(["clean", "--target", "codex", "--dry-run", "--force-stop"]);
    expect(result.status).toBe(0);
    expect(result.events).toEqual(["prepare"]);
    expect(result.stdout).toContain("Preview complete");
  });

  it.each([["doctor", "--json"], ["recovery", "list", "--json"], ["--help"], ["--version"]])(
    "keeps non-interactive inspection commands available: %j", (...args) => {
      const result = command(args);
      expect(result.status).toBe(0);
      expect(result.events).toEqual([]);
      expect(result.stdout).not.toMatch(/\x1b/);
    }
  );
});
