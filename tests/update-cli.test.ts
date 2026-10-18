import { describe, expect, it, vi } from "vitest";
import type { UpdateResult } from "../src/update.js";
import { createCliTestFixture, runCliCommand } from "./helpers/cli.js";

function fixture() {
  const release: UpdateResult = {
    currentVersion: "0.1.0-beta.1", latestVersion: "0.1.0", available: true,
    releaseUrl: "https://github.com/Huang-KJ/ai-cli-cleaner/releases/tag/v0.1.0",
    archive: { id: 1, name: "ai-cli-cleaner-0.1.0.tgz", size: 100, url: "https://api.github.com/repos/Huang-KJ/ai-cli-cleaner/releases/assets/1" },
    checksums: { id: 2, name: "SHA256SUMS", size: 98, url: "https://api.github.com/repos/Huang-KJ/ai-cli-cleaner/releases/assets/2" }
  };
  const test = createCliTestFixture({
    confirm: vi.fn(async () => { throw new Error("Unexpected cleanup confirmation."); }),
    assertSupportedPlatform: vi.fn(),
    checkForUpdate: vi.fn(async () => release), installUpdate: vi.fn(async () => {}),
  });
  const command = (args: string[]) => runCliCommand(args, test.dependencies, release.currentVersion, "ai-cleaner");
  return { release, dependencies: test.dependencies, output: test.output, command };
}

describe("explicit GitHub updates", () => {
  it("checks without installing, scanning conversations, or prompting", async () => {
    const test = fixture();
    expect(await test.command(["update"])).toBe(0);
    expect(test.dependencies.checkForUpdate).toHaveBeenCalledExactlyOnceWith({ currentVersion: "0.1.0-beta.1", prerelease: false });
    expect(test.dependencies.installUpdate).not.toHaveBeenCalled();
    expect(test.dependencies.prepareClean).not.toHaveBeenCalled();
    expect(test.dependencies.discoverConversations).not.toHaveBeenCalled();
    expect(test.dependencies.confirm).not.toHaveBeenCalled();
    expect(test.output.join("\n")).toContain("ai-cleaner update --install");
  });

  it("installs only with explicit opt-in and propagates the selected release", async () => {
    const test = fixture();
    expect(await test.command(["update", "--install", "--prerelease"])).toBe(0);
    expect(test.dependencies.assertSupportedPlatform).toHaveBeenCalledOnce();
    expect(test.dependencies.checkForUpdate).toHaveBeenCalledExactlyOnceWith({ currentVersion: "0.1.0-beta.1", prerelease: true });
    expect(test.dependencies.installUpdate).toHaveBeenCalledExactlyOnceWith(test.release);
    expect(test.output.join("\n")).toContain("Updated to 0.1.0");
  });

  it("does not reinstall or downgrade when no newer release is available", async () => {
    const test = fixture();
    test.release.available = false;
    test.release.latestVersion = "0.2.0";
    expect(await test.command(["update", "--install"])).toBe(0);
    expect(test.dependencies.installUpdate).not.toHaveBeenCalled();
    expect(test.output.join("\n")).toContain("Nothing was installed");
  });

  it("stops before network access when installation is unsupported", async () => {
    const test = fixture();
    test.dependencies.assertSupportedPlatform = () => { throw new Error("Unsupported platform."); };
    expect(await test.command(["update", "--install"])).toBe(1);
    expect(test.dependencies.checkForUpdate).not.toHaveBeenCalled();
    expect(test.dependencies.installUpdate).not.toHaveBeenCalled();
  });

  it("does not install after a failed release check", async () => {
    const test = fixture();
    test.dependencies.checkForUpdate = async () => { throw new Error("GitHub is unavailable."); };
    expect(await test.command(["update", "--install"])).toBe(1);
    expect(test.dependencies.installUpdate).not.toHaveBeenCalled();
    expect(test.output).toContain("GitHub is unavailable.");
  });

  it.each([["--help"], ["--version"], ["update", "--help"]])("does not check for updates for %j", async (...args) => {
    const test = fixture();
    expect(await test.command(args)).toBe(0);
    expect(test.dependencies.checkForUpdate).not.toHaveBeenCalled();
    expect(test.output.join("\n")).not.toMatch(/\p{Script=Han}/u);
  });
});
