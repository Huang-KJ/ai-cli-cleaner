import { describe, expect, it } from "vitest";
import { runCli, type CliDependencies } from "../src/cli.js";

type Report = { ok: boolean; checks: { id: string; ok: boolean; message: string }[]; agents: { providerId: string; roots: { path: string; exists: boolean }[]; running: { pid: number; providerId: string }[] }[] };
type Doctor = (targets: string[], options: {
  home: string; platform: string; osRelease?: string; nodeVersion: string; nodeRange?: string; environment: NodeJS.ProcessEnv;
  pathExists: (value: string) => Promise<boolean>;
  executableAvailable: (value: string) => Promise<boolean>;
  findAgents: (targets: string[]) => Promise<{ pid: number; providerId: string }[]>;
}) => Promise<Report>;
const loadDoctor = async () => {
  const module = await import("../src/doctor.js").catch(() => ({}));
  expect((module as { runDoctor?: unknown }).runDoctor).toBeTypeOf("function");
  return (module as { runDoctor: Doctor }).runDoctor;
};
const options = () => ({
  home: "/Users/private-name", platform: "darwin", osRelease: "25.6.0", nodeVersion: "24.15.0", environment: {},
  pathExists: async () => true,
  executableAvailable: async () => true,
  findAgents: async () => []
});

describe("doctor read-only checks", () => {
  it("reports default roots and readiness without leaking home or raw process commands", async () => {
    const doctor = await loadDoctor();
    const report = await doctor(["codex"], options());
    expect(report.ok).toBe(true);
    expect(report.agents).toEqual([{ providerId: "codex", roots: [{ path: "~/.codex", exists: true }], running: [] }]);
    expect(JSON.stringify(report)).not.toContain("private-name");
    expect(report.checks.map((item) => item.id)).toEqual(expect.arrayContaining(["platform", "node", "tool:lsof", "tool:ps", "tool:trash", "roots:codex", "agents:codex"]));
  });
  it("rejects custom roots without including their values", async () => {
    const doctor = await loadDoctor();
    const config = { ...options(), environment: { CODEX_HOME: "/secret/custom-root" } };
    const report = await doctor(["codex"], config);
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "roots:codex")?.message).toContain("custom CODEX_HOME");
    expect(JSON.stringify(report)).not.toContain("/secret");
  });
  it.each(["22.22.1", "23.0.0", "24.14.9", "25.9.0", "27.0.0"])("marks unsupported Node %s", async (nodeVersion) => {
    const doctor = await loadDoctor();
    const report = await doctor(["codex"], { ...options(), nodeVersion });
    expect(report.checks.find((check) => check.id === "node")?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
  it("reports macOS versions below 26 as unsupported", async () => {
    const doctor = await loadDoctor();
    const report = await doctor(["codex"], { ...options(), osRelease: "24.14.9" });
    expect(report.checks.find((check) => check.id === "platform")?.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "platform")?.message).toContain("macOS 26");
    expect(report.ok).toBe(false);
  });
  it("reports missing tools, unsupported platform, and failed process checks without raw errors", async () => {
    const doctor = await loadDoctor();
    const report = await doctor(["codex"], {
      ...options(), platform: "linux", executableAvailable: async () => false,
      findAgents: async () => { throw new Error("/Users/private-name/token secret-command"); }
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "tool:ps")?.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "agents:codex")?.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private-name");
    expect(JSON.stringify(report)).not.toContain("secret-command");
  });
  it("reports running PID/provider without treating missing data as unsafe", async () => {
    const doctor = await loadDoctor();
    const report = await doctor(["codex"], {
      ...options(), pathExists: async () => false,
      findAgents: async () => [{ pid: 123, providerId: "codex" }]
    });
    expect(report.ok).toBe(false);
    expect(report.agents[0]!.roots[0]!.exists).toBe(false);
    expect(report.agents[0]!.running).toEqual([{ pid: 123, providerId: "codex" }]);
  });
  it("doctor CLI filters targets, writes JSON, and never prepares conversation content", async () => {
    const output: string[] = [];
    let contentReads = 0;
    let targets: unknown;
    const dependencies: CliDependencies & { doctor: (selected: unknown) => Promise<Report> } = {
      confirm: async () => { throw new Error("不可確認"); }, selectAgent: async () => undefined, checkbox: async () => [],
      prepareClean: async () => { contentReads++; throw new Error("不可讀內容"); },
      discoverConversations: async () => { contentReads++; return { conversations: [], warnings: [] }; },
      deleteConversations: async () => { throw new Error("不可刪除"); },
      doctor: async (selected) => { targets = selected; return { ok: true, checks: [], agents: [] }; },
      log: (value) => output.push(value), warn: (value) => output.push(value), error: (value) => output.push(value)
    };
    expect(await runCli(["node", "cleaner", "doctor", "--target", "codex,grok", "--json"], "test", dependencies)).toBe(0);
    expect(targets).toEqual(["codex", "grok"]);
    expect(JSON.parse(output[0]!)).toEqual({ ok: true, checks: [], agents: [] });
    expect(contentReads).toBe(0);
  });
});
