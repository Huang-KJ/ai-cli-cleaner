import { describe, expect, it, vi } from "vitest";
import type { ProviderId } from "../src/cleaners/types.js";
import { findRunningAgents, identifyAgent, parseAgentProcesses, stopAgents } from "../src/fs/agent-processes.js";

const psRunner = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: Object.assign(() => {
  throw new Error("測試不得呼叫真實程序查核。");
}, { [Symbol.for("nodejs.util.promisify.custom")]: async (file: string, ...args: unknown[]) =>
  file === "/bin/ls" ? { stdout: "", stderr: "" } : psRunner(file, ...args) }) }));

const started = "Mon Sep 28 12:12:14 2026";
function row(pid: number, ppid: number, uid: number, command: string, time = started): string {
  return `${pid} ${ppid} ${uid} ${time} ${command}`;
}

describe("agent process detection", () => {
  it("identifies Codex App, app-server, helper, and agent executables", () => {
    expect(identifyAgent("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")).toBe("codex");
    expect(identifyAgent("/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer")).toBe("codex");
    expect(identifyAgent("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server")).toBe("codex");
    expect(identifyAgent("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex-code-mode-host")).toBe("codex");
    expect(identifyAgent("/usr/local/bin/node /usr/local/lib/node_modules/@openai/codex/bin/codex.js app-server")).toBe("codex");
    expect(identifyAgent("/opt/homebrew/bin/copilot chat")).toBe("copilot");
    expect(identifyAgent("/usr/local/bin/node /usr/local/lib/node_modules/@github/copilot/dist/cli.js")).toBe("copilot");
    expect(identifyAgent("/Applications/Antigravity.app/Contents/MacOS/Antigravity")).toBe("antigravity");
    expect(identifyAgent("/usr/local/bin/opencode serve")).toBe("opencode");
    expect(identifyAgent("grok chat")).toBe("grok");
    expect(identifyAgent("/usr/local/Caskroom/grok-build/1.0.41/grok-1.0.41-macos-x86_64")).toBe("grok");
  });

  it("does not treat command-line arguments, filename fragments, or shell text as agents", () => {
    expect(identifyAgent("/bin/zsh -c ps -axo command | rg codex")).toBeUndefined();
    expect(identifyAgent("node ./my-codex-cleaner.js --agent copilot")).toBeUndefined();
    expect(identifyAgent("node /tmp/my-app.js /usr/local/lib/node_modules/@openai/codex/bin/codex.js")).toBeUndefined();
    expect(identifyAgent("/usr/bin/codex-helper --opencode")).toBeUndefined();
    expect(identifyAgent("/Applications/Other.app/Contents/MacOS/Other --data=/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")).toBeUndefined();
    expect(identifyAgent("/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node server.mjs")).toBeUndefined();
  });

  it("uses the accounting process name to identify Apps with spaces and rejects forged argv0", () => {
    expect(identifyAgent("/Synthetic Folder/ChatGPT.app/Contents/MacOS/ChatGPT --token fixture-secret", "ChatGPT")).toBe("codex");
    expect(identifyAgent("/Synthetic Folder/Codex.app/Contents/MacOS/Codex", "Codex")).toBe("codex");
    expect(identifyAgent("/Synthetic Folder/Antigravity.app/Contents/MacOS/Antigravity", "Antigravity")).toBe("antigravity");
    expect(identifyAgent("/Synthetic Folder/OpenCode.app/Contents/MacOS/OpenCode", "OpenCode")).toBe("opencode");
    expect(identifyAgent("/Synthetic Folder/Grok.app/Contents/MacOS/Grok", "Grok")).toBe("grok");
    expect(identifyAgent("/Synthetic Folder/Copilot.app/Contents/MacOS/Copilot", "Copilot")).toBe("copilot");
    expect(identifyAgent("/Synthetic Folder/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer", "Codex (Renderer)")).toBe("codex");
    expect(identifyAgent("/Synthetic Folder/ChatGPT.app/Contents/MacOS/ChatGPT", "sleep")).toBeUndefined();
    expect(identifyAgent("/bin/zsh -c /Synthetic Folder/ChatGPT.app/Contents/MacOS/ChatGPT", "zsh")).toBeUndefined();
    expect(identifyAgent("/Applications/Other.app/Contents/MacOS/Other /Synthetic Folder/Codex.app/Contents/MacOS/Codex", "Other")).toBeUndefined();
  });

  it("parses native one-shot snapshots with spaces and truncated process names", () => {
    const output = row(100, 1, 501, "Codex (Renderer) /Synthetic Folder/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)");
    expect(parseAgentProcesses(output, true)[0]).toMatchObject({ accounting: "Codex (Renderer)",
      command: "/Synthetic Folder/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)" });
    expect(identifyAgent("/usr/local/Caskroom/grok-build/1.0.41/grok-1.0.41-macos-x86_64", "grok-1.0.41-maco")).toBe("grok");
  });

  it("fails closed on ambiguous native Node boundaries and ignores script paths in arguments", () => {
    expect(identifyAgent("/usr/local/bin/node /usr/local/lib/node_modules/@openai/codex/bin/codex.js app-server", "node")).toBe("codex");
    expect(identifyAgent("/usr/local/bin/node /tmp/other.js /usr/local/lib/node_modules/@openai/codex/bin/codex.js", "node")).toBeUndefined();
    expect(identifyAgent("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", "node")).toBeUndefined();
    expect(() => identifyAgent("/usr/local/bin/node /Synthetic Folder/node_modules/@openai/codex/bin/codex.js", "node")).toThrow(/Cannot determine the Node agent script boundary/);
  });

  it("fails closed for known process names with unsupported CLI paths", () => {
    expect(() => identifyAgent("/Synthetic Folder/bin/codex app-server", "codex")).toThrow(/Cannot confirm the agent executable location/);
  });

  it("parses App paths with spaces and rejects incomplete ps output", () => {
    expect(parseAgentProcesses(row(100, 1, 501, "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)"))).toEqual([{
      pid: 100, ppid: 1, uid: 501, started,
      command: "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)"
    }]);
    expect(() => parseAgentProcesses("100 1 501 incomplete")).toThrow(/Cannot parse the system process list/);
  });
});

describe("stopAgents", () => {
  const own = row(200, 100, 501, "/usr/local/bin/node /tmp/ai-cleaner.js");
  const terminal = row(100, 1, 501, "/bin/zsh");
  const codex = row(300, 1, 501, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT");

  function mockPs(lines: string[], signal: ReturnType<typeof vi.fn>, termSurvives = false) {
    const active = new Set(lines.filter((line) => line !== own && line !== terminal));
    const runPs = vi.fn(async () => [terminal, own, ...active].join("\n"));
    signal.mockImplementation((pid: number, kind: NodeJS.Signals) => {
      if (kind === "SIGKILL" || !termSurvives) {
        for (const line of active) if (line.startsWith(`${pid} `)) active.delete(line);
      }
    });
    return runPs;
  }

  it("stops only the matching App process in the native snapshot, not a spoofed argument", async () => {
    const native = (pid: number, command: string, accounting: string) =>
      row(pid, 1, 501, `${accounting.padEnd(16)} ${command}`);
    const base = [native(100, "/bin/zsh", "zsh"), native(200, "/usr/local/bin/node /tmp/ai-cleaner.js", "node"),
      native(301, "/Synthetic Folder/ChatGPT.app/Contents/MacOS/ChatGPT", "sleep"),
      native(302, "/bin/zsh -c /Synthetic Folder/ChatGPT.app/Contents/MacOS/ChatGPT", "zsh"),
      row(400, 1, 502, "codex            /Other User Folder/bin/codex")].join("\n");
    const app = native(300, "/Synthetic Folder/ChatGPT.app/Contents/MacOS/ChatGPT", "ChatGPT");
    psRunner.mockReset().mockResolvedValue({ stdout: `${base}\n${app}`, stderr: "" });
    expect(await findRunningAgents(["codex"], { platform: "darwin", uid: 501 })).toEqual([{ pid: 300, providerId: "codex" }]);
    psRunner.mockReset().mockResolvedValueOnce({ stdout: `${base}\n${app}`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${base}\n${app}`, stderr: "" })
      .mockResolvedValue({ stdout: base, stderr: "" });
    const signal = vi.fn();
    expect(await stopAgents(["codex"], { platform: "darwin", uid: 501, pid: 200, signal, sleep: async () => {} }))
      .toEqual({ stopped: [{ pid: 300, providerId: "codex" }] });
    expect(signal).toHaveBeenCalledExactlyOnceWith(300, "SIGTERM");
  });

  it("does not stop a new process when native accounting changes, even if argv0 matches", async () => {
    const base = `${row(100, 1, 501, "zsh              /bin/zsh")}\n${row(200, 100, 501, "node             /usr/local/bin/node /tmp/ai-cleaner.js")}`;
    const app = row(300, 1, 501, "ChatGPT          /Synthetic Folder/ChatGPT.app/Contents/MacOS/ChatGPT");
    const replaced = row(300, 1, 501, "sleep            /Synthetic Folder/ChatGPT.app/Contents/MacOS/ChatGPT");
    psRunner.mockReset().mockResolvedValueOnce({ stdout: `${base}\n${app}`, stderr: "" })
      .mockResolvedValue({ stdout: `${base}\n${replaced}`, stderr: "" });
    const signal = vi.fn();
    await stopAgents(["codex"], { platform: "darwin", uid: 501, pid: 200, signal });
    expect(signal).not.toHaveBeenCalled();
  });

  it("stops only the selected provider for the current user", async () => {
    const foreignCodex = row(301, 1, 502, "/usr/local/bin/codex app-server");
    const copilot = row(302, 1, 501, "/usr/local/bin/copilot chat");
    const unrelated = row(303, 1, 501, "/bin/zsh -c echo codex");
    const signal = vi.fn();
    const runPs = mockPs([codex, foreignCodex, copilot, unrelated], signal);
    const result = await stopAgents(["codex"], {
      platform: "darwin", uid: 501, pid: 200, runPs, signal, sleep: async () => {}
    });
    expect(result.stopped).toEqual([{ pid: 300, providerId: "codex" }]);
    expect(signal).toHaveBeenCalledExactlyOnceWith(300, "SIGTERM");
  });

  it("escalates to SIGKILL and rechecks after SIGTERM fails", async () => {
    const signal = vi.fn();
    const runPs = mockPs([codex], signal, true);
    await expect(stopAgents(["codex"], {
      platform: "darwin", uid: 501, pid: 200, runPs, signal, sleep: async () => {}
    })).resolves.toEqual({ stopped: [{ pid: 300, providerId: "codex" }] });
    expect(signal).toHaveBeenCalledWith(300, "SIGTERM");
    expect(signal).toHaveBeenCalledWith(300, "SIGKILL");
  });

  it("refuses to signal when invoked from a selected agent's child process", async () => {
    const agentParent = row(100, 1, 501, "/usr/local/bin/codex app-server");
    const runPs = vi.fn(async () => [agentParent, own].join("\n"));
    const signal = vi.fn();
    await expect(stopAgents(["codex"], {
      platform: "darwin", uid: 501, pid: 200, runPs, signal
    })).rejects.toThrow(/separate terminal/i);
    expect(signal).not.toHaveBeenCalled();
  });

  it("does not signal a PID that has been reused by another process", async () => {
    const replaced = row(300, 1, 501, "/usr/local/bin/other", "Mon Sep 28 12:13:14 2026");
    const runPs = vi.fn().mockResolvedValueOnce([terminal, own, codex].join("\n"))
      .mockResolvedValueOnce([terminal, own, replaced].join("\n"))
      .mockResolvedValueOnce([terminal, own, replaced].join("\n"));
    const signal = vi.fn();
    await stopAgents(["codex"], { platform: "darwin", uid: 501, pid: 200, runPs, signal });
    expect(signal).not.toHaveBeenCalled();
  });

  it("blocks cleanup when an agent restarts with a new PID", async () => {
    const respawned = row(301, 1, 501, "/usr/local/bin/codex app-server");
    const runPs = vi.fn().mockResolvedValueOnce([terminal, own, codex].join("\n"))
      .mockResolvedValueOnce([terminal, own, codex].join("\n"))
      .mockResolvedValueOnce([terminal, own].join("\n"))
      .mockResolvedValueOnce([terminal, own, respawned].join("\n"));
    const signal = vi.fn();
    await expect(stopAgents(["codex"], {
      platform: "darwin", uid: 501, pid: 200, runPs, signal, sleep: async () => {}
    })).rejects.toThrow(/Agents restarted or are still running/);
    expect(signal).toHaveBeenCalledExactlyOnceWith(300, "SIGTERM");
  });

  it("blocks cleanup while agents are running or when ps fails", async () => {
    const signal = vi.fn();
    const runPs = vi.fn(async () => [terminal, own, codex].join("\n"));
    await expect(stopAgents(["codex"], {
      platform: "darwin", uid: 501, pid: 200, runPs, signal, sleep: async () => {}
    })).rejects.toThrow(/Agents are still running; cleanup canceled/);
    expect(signal).toHaveBeenCalledWith(300, "SIGKILL");
    await expect(stopAgents(["codex"], {
      platform: "darwin", uid: 501, pid: 200, runPs: async () => { throw new Error("ps failed"); }
    })).rejects.toThrow(/Cannot confirm agent process status/);
  });

  it("exposes only safe messages and preserves the cause when process checks or signaling fail", async () => {
    const secret = new Error("fixture-secret /Users/fixture --token=private");
    const psFailure = await stopAgents(["codex"], { platform: "darwin", uid: 501, pid: 200,
      runPs: async () => { throw secret; } }).catch((error: Error) => error);
    expect(psFailure).toBeInstanceOf(Error);
    expect((psFailure as Error).message).not.toContain("fixture-secret");
    expect((psFailure as Error).cause).toBe(secret);
    const signalFailure = await stopAgents(["codex"], { platform: "darwin", uid: 501, pid: 200,
      runPs: async () => [terminal, own, codex].join("\n"), signal: () => { throw secret; } }).catch((error: Error) => error);
    expect((signalFailure as Error).message).not.toContain("fixture-secret");
    expect((signalFailure as Error).cause).toBe(secret);
  });

  it("does not enumerate processes for empty targets and refuses non-macOS platforms", async () => {
    const runPs = vi.fn(async () => "");
    expect(await stopAgents([], { platform: "darwin", runPs })).toEqual({ stopped: [] });
    expect(runPs).not.toHaveBeenCalled();
    await expect(stopAgents(["grok" as ProviderId], { platform: "linux", runPs })).rejects.toThrow(/macOS/);
  });
});
