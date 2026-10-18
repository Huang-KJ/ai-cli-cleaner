import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { assertDefaultDataRoots } from "./cleaners/manifests.js";
import type { ProviderId } from "./cleaners/types.js";
import { findRunningAgents, type StoppedAgent } from "./fs/agent-processes.js";
import { systemTrashBinary } from "./fs/trash.js";
import { pathExists } from "./fs/paths.js";
import { getPlatformSupport } from "./platform.js";
import { systemTools, trustedToolPath } from "./fs/trusted-tools.js";

export interface DoctorCheck {
  id: string;
  ok: boolean;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  agents: {
    providerId: ProviderId;
    roots: { path: string; exists: boolean }[];
    running: StoppedAgent[];
  }[];
}

export interface DoctorOptions {
  home?: string;
  platform?: string;
  osRelease?: string;
  nodeVersion?: string;
  nodeRange?: string;
  environment?: NodeJS.ProcessEnv;
  pathExists?: (value: string) => Promise<boolean>;
  executableAvailable?: (value: string) => Promise<boolean>;
  findAgents?: (targets: ProviderId[]) => Promise<StoppedAgent[]>;
}

const rootPaths: Record<ProviderId, string[]> = {
  codex: ["~/.codex"],
  copilot: ["~/.copilot"],
  antigravity: ["~/.gemini/antigravity-cli", "~/.gemini/antigravity-ide"],
  opencode: ["~/.local/share/opencode", "~/.local/state/opencode"],
  grok: ["~/.grok"]
};

export async function runDoctor(targets: ProviderId[], options: DoctorOptions = {}): Promise<DoctorReport> {
  const home = options.home ?? homedir();
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const platformSupport = getPlatformSupport(platform, options.osRelease);
  const version = options.nodeVersion ?? process.versions.node;
  const range = options.nodeRange ?? "^22.22.2 || ^24.15.0 || ^26.0.0";
  const exists = options.pathExists ?? pathExists;
  const available = options.executableAvailable ?? executableAvailable;
  const checks: DoctorCheck[] = [
    { id: "platform", ok: platformSupport.supported, message: platformSupport.message },
    { id: "node", ok: supportsNode(version, range), message: `Node.js ${version}; supported: ${range}` }
  ];
  for (const name of ["lsof", "ps", "trash"] as const) {
    let ok = false;
    try {
      ok = await available(name === "trash" ? systemTrashBinary() : systemTools[name]);
    } catch {
      // 可用性檢查不執行工具，也不回傳含路徑的系統錯誤。
    }
    checks.push({ id: `tool:${name}`, ok, message: `${name === "trash" ? "Bundled Trash helper" : name}: ${ok ? "executable available" : "executable missing or not permitted"}` });
  }
  let running: StoppedAgent[] = [];
  let processCheck = true;
  try {
    running = await (options.findAgents ?? ((selected) => findRunningAgents(selected, { platform })))(targets);
  } catch {
    processCheck = false;
  }
  const agents: DoctorReport["agents"] = [];
  for (const target of new Set(targets)) {
    let rootsOk = true;
    let rootMessage = `${target}: using default data roots`;
    try {
      assertDefaultDataRoots([target], environment, home);
    } catch (error) {
      rootsOk = false;
      rootMessage = error instanceof Error ? error.message : `${target}: data root check failed`;
    }
    const roots: DoctorReport["agents"][number]["roots"] = [];
    for (const root of rootPaths[target]) {
      let present = false;
      try {
        present = await exists(path.join(home, root.slice(2)));
      } catch {
        rootsOk = false;
        rootMessage = `${target}: cannot check access to default data roots`;
      }
      roots.push({ path: root, exists: present });
    }
    checks.push({ id: `roots:${target}`, ok: rootsOk, message: `${rootMessage}; ${roots.map((root) => `${root.path} (${root.exists ? "exists" : "not created"})`).join(", ")}` });
    // 明確挑選輸出欄位，避免其他來源夾帶命令列或帳號資訊。
    const selected = running.filter((item) => item.providerId === target).map((item) => ({ pid: item.pid, providerId: item.providerId }));
    checks.push({ id: `agents:${target}`, ok: processCheck && selected.length === 0,
      message: !processCheck ? `${target}: cannot verify process status; cleanup will stop`
        : selected.length ? `${target}: still running (PID ${selected.map((item) => item.pid).join(", ")}); close the agent first`
          : `${target}: no running processes detected for the current user` });
    agents.push({ providerId: target, roots, running: selected });
  }
  return { ok: checks.every((check) => check.ok), checks, agents };
}

function supportsNode(version: string, range: string): boolean {
  const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!actual) return false;
  return range.split("||").some((part) => {
    const minimum = /^\s*\^(\d+)\.(\d+)\.(\d+)\s*$/.exec(part);
    if (!minimum || actual[1] !== minimum[1]) return false;
    return Number(actual[2]) > Number(minimum[2]) ||
      Number(actual[2]) === Number(minimum[2]) && Number(actual[3]) >= Number(minimum[3]);
  });
}

async function executableAvailable(value: string): Promise<boolean> {
  try {
    if (Object.values(systemTools).includes(value as typeof systemTools[keyof typeof systemTools])) {
      await trustedToolPath(value, "executable", true);
    } else {
      if (!path.isAbsolute(value) || !(await fs.stat(value)).isFile()) return false;
      await fs.access(value, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}
