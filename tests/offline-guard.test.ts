import { describe, expect, it } from "vitest";
import * as agents from "../src/fs/agent-processes.js";

const line = (pid: number, uid: number, command: string) => `${pid} 1 ${uid} Tue Oct 13 20:00:00 2026 ${command}`;
const api = agents as typeof agents & {
  findRunningAgents: (targets: string[], options: { uid: number; platform: string; runPs: () => Promise<string> }) => Promise<{ pid: number; providerId: string }[]>;
  assertAgentsStopped: (targets: string[], options: { uid: number; platform: string; runPs: () => Promise<string> }) => Promise<void>;
};

describe("offline process guard", () => {
  it("only reports selected agents for the current user without raw commands", async () => {
    expect(api.findRunningAgents).toBeTypeOf("function");
    const found = await api.findRunningAgents(["codex"], { uid: 501, platform: "darwin", runPs: async () => [
      line(10, 501, "/bin/codex --token secret"), line(11, 502, "/bin/codex"),
      line(12, 501, "/bin/grok"), line(13, 501, "/bin/sh -c codex")
    ].join("\n") });
    expect(found).toEqual([{ pid: 10, providerId: "codex" }]);
  });
  it("fails closed when process inspection fails or is malformed", async () => {
    expect(api.assertAgentsStopped).toBeTypeOf("function");
    await expect(api.assertAgentsStopped(["codex"], { uid: 501, platform: "darwin", runPs: async () => { throw new Error("ps secret /Users/name"); } })).rejects.toThrow("Cannot confirm agent process status");
    await expect(api.assertAgentsStopped(["codex"], { uid: 501, platform: "darwin", runPs: async () => "invalid" })).rejects.toThrow("Cannot confirm agent process status");
    await expect(api.assertAgentsStopped(["codex"], { uid: 501, platform: "darwin", runPs: async () => "" })).rejects.toThrow("Cannot confirm agent process status");
  });
  it("refuses running agents and unsupported platforms", async () => {
    expect(api.assertAgentsStopped).toBeTypeOf("function");
    await expect(api.assertAgentsStopped(["codex"], { uid: 501, platform: "darwin", runPs: async () => line(10, 501, "/bin/codex") })).rejects.toThrow("Selected agents are still running");
    await expect(api.assertAgentsStopped(["codex"], { uid: 501, platform: "linux", runPs: async () => "" })).rejects.toThrow("macOS");
  });
});
