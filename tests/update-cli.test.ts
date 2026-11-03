import { describe, expect, it, vi } from "vitest";
import type { UpdateResult } from "../src/update.js";
import { createCliTestFixture, runCliCommand } from "./helpers/cli.js";

function fixture(overrides: Partial<UpdateResult> = {}) {
  const release: UpdateResult = {
    currentVersion: "0.1.0-beta.6", latestVersion: "0.1.0-beta.7", available: true,
    installCommand: "npm install --global --engine-strict ai-cli-cleaner@latest", ...overrides
  };
  const test = createCliTestFixture({
    confirm: vi.fn(async () => { throw new Error("Unexpected cleanup confirmation."); }),
    checkForUpdate: vi.fn(async () => release)
  });
  const command = (args: string[]) => runCliCommand(args, test.dependencies, "0.1.0-beta.6", "ai-cleaner");
  return { release, dependencies: test.dependencies, output: test.output, command };
}

describe("npm update checks from the CLI", () => {
  it("prints the npm install command without installing, scanning conversations, or prompting", async () => {
    const test = fixture();
    expect(await test.command(["update"])).toBe(0);
    expect(test.dependencies.checkForUpdate).toHaveBeenCalledExactlyOnceWith("0.1.0-beta.6");
    expect(test.dependencies.prepareClean).not.toHaveBeenCalled();
    expect(test.dependencies.discoverConversations).not.toHaveBeenCalled();
    expect(test.dependencies.confirm).not.toHaveBeenCalled();
    expect(test.output).toContain("To update, run: npm install --global --engine-strict ai-cli-cleaner@latest");
  });

  it("reports when no newer version is available", async () => {
    const test = fixture({ latestVersion: "0.1.0-beta.6", available: false });
    expect(await test.command(["update"])).toBe(0);
    expect(test.output).toContain("No newer version is available.");
    expect(test.output.join("\n")).not.toContain("npm install");
  });

  it("fails clearly when the registry check fails", async () => {
    const test = fixture();
    test.dependencies.checkForUpdate = async () => { throw new Error("npm registry request failed (HTTP 503)."); };
    expect(await test.command(["update"])).toBe(1);
    expect(test.output.join("\n")).toContain("HTTP 503");
  });

  it.each([["--install"], ["--prerelease"]])("rejects the removed %s option before contacting npm", async (option) => {
    const test = fixture();
    expect(await test.command(["update", option])).toBe(1);
    expect(test.output.join("\n")).toContain(`unknown option '${option}'`);
    expect(test.dependencies.checkForUpdate).not.toHaveBeenCalled();
  });
});
