import { vi } from "vitest";
import { runCli, type CliDependencies } from "../../src/cli.js";

export function createCliTestFixture(overrides: Partial<CliDependencies> = {}) {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const output: string[] = [];
  const dependencies: CliDependencies = {
    isInteractive: () => true,
    confirm: vi.fn(async () => true),
    selectAgent: vi.fn(async () => undefined),
    checkbox: vi.fn(async () => []),
    stopAgents: vi.fn(async () => { throw new Error("Unexpected agent shutdown."); }),
    prepareClean: vi.fn(async () => { throw new Error("Unexpected cleanup scan."); }),
    discoverConversations: vi.fn(async () => { throw new Error("Unexpected conversation discovery."); }),
    deleteConversations: vi.fn(async () => { throw new Error("Unexpected conversation deletion."); }),
    log: (message) => { logs.push(message); output.push(message); },
    warn: (message) => { warnings.push(message); output.push(message); },
    error: (message) => { errors.push(message); output.push(message); },
    ...overrides
  };
  return { dependencies, logs, warnings, errors, output };
}

export function runCliCommand(
  args: string[],
  dependencies: CliDependencies,
  version = "test",
  executable = "cleaner"
): Promise<number> {
  return runCli(["node", executable, ...args], version, dependencies);
}
