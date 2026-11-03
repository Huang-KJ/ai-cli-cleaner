import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, compareVersions, type UpdateTransport } from "../src/update.js";

const tags = (value: unknown): UpdateTransport => vi.fn(async () => Buffer.from(JSON.stringify(value)));

describe("npm update checks", () => {
  it("reports a newer latest version with the npm command that installs it", async () => {
    const transport = tags({ latest: "0.1.0-beta.7" });
    await expect(checkForUpdate("0.1.0-beta.6", transport)).resolves.toEqual({
      currentVersion: "0.1.0-beta.6", latestVersion: "0.1.0-beta.7", available: true,
      installCommand: "npm install --global --engine-strict ai-cli-cleaner@latest"
    });
    expect(transport).toHaveBeenCalledExactlyOnceWith("https://registry.npmjs.org/-/package/ai-cli-cleaner/dist-tags");
  });

  it.each(["0.1.0-beta.7", "0.2.0"])("reports no update when the installed version is %s", async (currentVersion) => {
    const result = await checkForUpdate(currentVersion, tags({ latest: "0.1.0-beta.7" }));
    expect(result.available).toBe(false);
  });

  it("rejects an invalid installed version before contacting npm", async () => {
    const transport = tags({ latest: "1.0.0" });
    await expect(checkForUpdate("1.0", transport)).rejects.toThrow("Invalid release version");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["non-JSON text", Buffer.from("not json")],
    ["a missing latest tag", Buffer.from(JSON.stringify({ beta: "1.0.0" }))],
    ["an incomplete version", Buffer.from(JSON.stringify({ latest: "1.0" }))],
    ["terminal control text", Buffer.from(JSON.stringify({ latest: "1.0.0\u001b[2J" }))],
    ["an array", Buffer.from("[]")],
    ["an oversized response", Buffer.alloc(64 * 1024 + 1, 32)]
  ])("rejects %s from the registry", async (_label, body) => {
    await expect(checkForUpdate("0.1.0-beta.6", async () => body)).rejects.toThrow(/npm returned/);
  });

  it("orders prereleases before their release", () => {
    expect(compareVersions("0.1.0", "0.1.0-beta.7")).toBe(1);
    expect(compareVersions("0.1.0-beta.10", "0.1.0-beta.9")).toBe(1);
  });
});
