import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderId } from "../cleaners/types.js";
import { systemTools, toolEnvironment, trustedToolPath } from "./trusted-tools.js";

const execFileAsync = promisify(execFile);
const PS_ARGS = ["-ww", "-axo", "pid=,ppid=,uid=,lstart=,ucomm=,command="];

export interface AgentProcess {
  pid: number;
  ppid: number;
  uid: number;
  started: string;
  command: string;
  accounting?: string;
}

export interface StoppedAgent {
  pid: number;
  providerId: ProviderId;
}

export interface StopAgentOptions {
  platform?: string;
  uid?: number;
  pid?: number;
  runPs?: () => Promise<string>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function parseAgentProcesses(output: string, hasAccounting = false): AgentProcess[] {
  const processes: AgentProcess[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/.exec(line);
    if (!fields) throw new Error("Cannot parse the system process list; stopping agents canceled.");
    const remainder = fields[5]!;
    // macOS ucomm 固定為 16 字元；command 必須是最後一欄才不會截短。
    const accounting = hasAccounting ? remainder.slice(0, 16).trimEnd() : undefined;
    const command = hasAccounting ? remainder.slice(17) : remainder;
    if (hasAccounting && (!accounting || remainder[16] !== " " || !command.trim())) {
      throw new Error("Cannot parse system process identity; stopping agents canceled.");
    }
    processes.push({
      pid: Number(fields[1]), ppid: Number(fields[2]), uid: Number(fields[3]),
      started: fields[4]!, command, ...(hasAccounting ? { accounting } : {})
    });
  }
  return processes;
}

export function identifyAgent(command: string, accounting?: string): ProviderId | undefined {
  if (accounting !== undefined) {
    // argv0 與 comm 都可偽造；先以 kernel 會計名稱限制 provider，再放寬 App 前綴空格。
    const provider = /^(?:ChatGPT$|Codex(?: |$)|codex(?:-|$))/.test(accounting) ? "codex"
      : /^(?:Antigravity(?: |$)|antigravity$)/.test(accounting) ? "antigravity"
        : /^(?:OpenCode(?: |$)|opencode$)/.test(accounting) ? "opencode"
          : /^(?:Grok(?: |$)|grok(?:-|$))/.test(accounting) ? "grok"
            : /^(?:Copilot(?: |$)|copilot$)/.test(accounting) ? "copilot" : undefined;
    const detected = identifyAgent(command);
    if (detected && detected === provider) return detected;
    if (accounting === "node") {
      if (/^(?:\S*\/)?node\s+\S*\/node_modules\/@openai\/codex\/bin\/codex\.js(?:\s|$)/.test(command)) return "codex";
      if (/^(?:\S*\/)?node\s+\S*\/node_modules\/@github\/copilot\/dist\/cli\.js(?:\s|$)/.test(command)) return "copilot";
      const script = /^(?:\S*\/)?node\s+(\S+)/.exec(command)?.[1];
      if (/\/node_modules\/(?:@openai\/codex\/bin\/codex\.js|@github\/copilot\/dist\/cli\.js)(?:\s|$)/.test(command) &&
          (!script || !/\.[cm]?js$/.test(script))) {
        throw new Error("Cannot determine the Node agent script boundary; operation canceled.");
      }
      return undefined;
    }
    if (!provider) return undefined;
    if (provider === "codex" && (/^\/[^\r\n]*\/Codex\.app\/Contents\//.test(command) ||
        /^\/[^\r\n]*\/ChatGPT\.app\/Contents\/(?:MacOS\/ChatGPT(?:\s|$)|Frameworks\/Codex Framework\.framework\/|Resources\/codex-cli\/)/.test(command))) return provider;
    const app = { antigravity: "Antigravity", opencode: "OpenCode", grok: "Grok", copilot: "Copilot" }[provider as Exclude<ProviderId, "codex">];
    if (app && new RegExp(`^/[^\\r\\n]*/${app}\\.app/Contents/`).test(command)) return provider;
    throw new Error("Cannot confirm the agent executable location; operation canceled.");
  }
  // 僅辨識實際執行檔位置；參數或 shell 指令提到代理名稱不算。
  if (/^\S*\/Codex\.app\/Contents\//.test(command) ||
      /^\S*\/ChatGPT\.app\/Contents\/(?:MacOS\/ChatGPT(?:\s|$)|Frameworks\/Codex Framework\.framework\/|Resources\/codex-cli\/)/.test(command) ||
      /^\S*\/codex(?:\s|$)/.test(command) || /^codex(?:\s|$)/.test(command) ||
      /^\S*\/codex-code-mode-host(?:\s|$)/.test(command) ||
      /^(?:\S*\/)?node\s+\S*\/node_modules\/@openai\/codex\/bin\/codex\.js(?:\s|$)/.test(command)) return "codex";
  if (/^\S*\/Antigravity\.app\/Contents\//.test(command) ||
      /^(?:\S*\/)?antigravity(?:\s|$)/.test(command)) return "antigravity";
  if (/^\S*\/OpenCode\.app\/Contents\//.test(command) ||
      /^(?:\S*\/)?opencode(?:\s|$)/.test(command)) return "opencode";
  if (/^\S*\/Grok\.app\/Contents\//.test(command) ||
      /^\/(?:usr\/local|opt\/homebrew)\/Caskroom\/grok-build\/[^/\s]+\/grok-[^/\s]+-macos-(?:x86_64|arm64)(?:\s|$)/.test(command) ||
      /^(?:\S*\/)?grok(?:\s|$)/.test(command)) return "grok";
  if (/^\S*\/Copilot\.app\/Contents\//.test(command) ||
      /^(?:\S*\/)?copilot(?:\s|$)/.test(command) ||
      /^(?:\S*\/)?node\s+\S*\/node_modules\/@github\/copilot\/dist\/cli\.js(?:\s|$)/.test(command)) return "copilot";
  return undefined;
}

export interface AgentInspectionOptions {
  platform?: string;
  uid?: number;
  runPs?: () => Promise<string>;
}

export async function findRunningAgents(
  targets: ProviderId[],
  options: AgentInspectionOptions = {}
): Promise<StoppedAgent[]> {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("Agent process checks are only supported on macOS.");
  }
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Cannot identify the current user; operation canceled.");
  const selected = new Set(targets);
  let processes: AgentProcess[];
  try {
    processes = parseAgentProcesses(await (options.runPs ?? defaultPs)(), !options.runPs);
    if (!processes.length) throw new Error("The process list is empty.");
  } catch {
    // 不回傳原始 stderr 或命令列，避免洩漏帳號、路徑及參數。
    throw new Error("Cannot confirm agent process status; operation canceled. Run doctor to check ps first.");
  }
  return processes.flatMap((item) => {
    if (item.uid !== uid) return [];
    const providerId = identifyAgent(item.command, item.accounting);
    return providerId && selected.has(providerId)
      ? [{ pid: item.pid, providerId }] : [];
  });
}

export async function assertAgentsStopped(
  targets: ProviderId[],
  options: AgentInspectionOptions = {}
): Promise<void> {
  const running = await findRunningAgents(targets, options);
  if (running.length > 0) {
    throw new Error(`Selected agents are still running; cleanup stopped. Close the agents or use --force-stop. Processes: ${running.map((item) => `${item.providerId} (PID ${item.pid})`).join(", ")}`);
  }
}

export async function stopAgents(
  targets: ProviderId[],
  options: StopAgentOptions = {}
): Promise<{ stopped: StoppedAgent[] }> {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("Stopping agents is only supported on macOS.");
  }
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Cannot identify the current user; stopping agents canceled.");
  const selfPid = options.pid ?? process.pid;
  const readPs = async (): Promise<AgentProcess[]> => {
    try { return parseAgentProcesses(await (options.runPs ?? defaultPs)(), !options.runPs); }
    catch (error) { throw new Error("Cannot confirm agent process status; stopping agents canceled. Run doctor to check ps first.", { cause: error }); }
  };
  const signal = options.signal ?? process.kill;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const chosen = new Set(targets);
  if (chosen.size === 0) return { stopped: [] };

  const initial = await readPs();
  const byPid = new Map(initial.map((item) => [item.pid, item]));
  if (!byPid.has(selfPid)) throw new Error("Cannot determine the cleaner's process relationships; stopping agents canceled.");
  const candidates = initial.filter((item) => item.uid === uid)
    .map((item) => ({ item, providerId: identifyAgent(item.command, item.accounting) }))
    .filter((entry): entry is { item: AgentProcess; providerId: ProviderId } =>
      entry.item.uid === uid && entry.providerId !== undefined && chosen.has(entry.providerId));
  const selected = new Set(candidates.map((entry) => entry.item.pid));

  let ancestor: AgentProcess | undefined = byPid.get(selfPid);
  const visited = new Set<number>();
  while (ancestor && !visited.has(ancestor.pid)) {
    if (selected.has(ancestor.pid)) {
      throw new Error("The cleaner was started by an agent that would be stopped. Run this command from a separate terminal.");
    }
    visited.add(ancestor.pid);
    ancestor = byPid.get(ancestor.ppid);
  }

  const stillSame = async (): Promise<AgentProcess[]> => {
    const current = new Map((await readPs()).map((item) => [item.pid, item]));
    return candidates.map(({ item }) => current.get(item.pid))
      .filter((item): item is AgentProcess => item !== undefined)
      .filter((item) => {
        const original = byPid.get(item.pid)!;
        return item.uid === original.uid && item.started === original.started &&
          item.command === original.command && item.accounting === original.accounting;
      });
  };

  let alive = await stillSame();
  for (const item of alive) sendSignal(signal, item.pid, "SIGTERM");
  for (let attempt = 0; attempt < 12 && alive.length > 0; attempt++) {
    await sleep(250);
    alive = await stillSame();
  }
  if (alive.length > 0) {
    // SIGKILL 前重新確認 PID、啟動時間與命令列，避免 PID 重用。
    for (const item of alive) sendSignal(signal, item.pid, "SIGKILL");
    for (let attempt = 0; attempt < 8 && alive.length > 0; attempt++) {
      await sleep(250);
      alive = await stillSame();
    }
  }
  if (alive.length > 0) {
    throw new Error(`Agents are still running; cleanup canceled. PIDs: ${alive.map((item) => item.pid).join(", ")}`);
  }
  const remaining = (await readPs()).filter((item) => {
    if (item.uid !== uid) return false;
    const providerId = identifyAgent(item.command, item.accounting);
    return providerId !== undefined && chosen.has(providerId);
  });
  if (remaining.length > 0) {
    throw new Error(`Agents restarted or are still running; cleanup canceled. PIDs: ${remaining.map((item) => item.pid).join(", ")}`);
  }
  return { stopped: candidates.map(({ item, providerId }) => ({ pid: item.pid, providerId })) };
}

function sendSignal(signal: (pid: number, signal: NodeJS.Signals) => void, pid: number, kind: NodeJS.Signals): void {
  try {
    signal(pid, kind);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
    throw new Error(`Cannot stop agent process ${pid}; operation canceled.`, { cause: error });
  }
}

async function defaultPs(): Promise<string> {
  const binary = await trustedToolPath(systemTools.ps, "executable", true);
  const { stdout, stderr } = await execFileAsync(binary, PS_ARGS, {
    maxBuffer: 16 * 1024 * 1024, timeout: 10_000,
    env: toolEnvironment()
  });
  if (stderr.trim()) throw new Error("Cannot read the process list.", { cause: new Error(stderr.trim()) });
  return stdout;
}
