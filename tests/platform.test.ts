import { describe, expect, it } from "vitest";
import { assertSupportedPlatform, getPlatformSupport } from "../src/platform.js";

describe("macOS minimum supported version", () => {
  it.each([
    ["22.22.1"], ["23.0.0"], ["24.14.9"]
  ])("rejects Darwin kernel version %s", (kernelRelease) => {
    const support = getPlatformSupport("darwin", kernelRelease);
    expect(support.supported).toBe(false);
    expect(support.message).toContain("macOS 26");
  });

  it.each([["25.6.0"], ["26.0.0"]])("accepts Darwin kernel version %s", (kernelRelease) => {
    expect(getPlatformSupport("darwin", kernelRelease).supported).toBe(true);
  });

  it.each(["", "unknown", "25", "25.6", "25.6.0.1"])("rejects invalid Darwin version strings %j", (kernelRelease) => {
    expect(getPlatformSupport("darwin", kernelRelease).supported).toBe(false);
  });

  it("rejects non-Darwin platforms even when the version string meets the minimum", () => {
    expect(getPlatformSupport("linux", "25.6.0").supported).toBe(false);
  });

  it("uses the supplied environment and returns a readable error", () => {
    expect(() => assertSupportedPlatform("darwin", "24.6.0")).toThrow("macOS 26");
    expect(() => assertSupportedPlatform("darwin", "25.6.0")).not.toThrow();
  });
});
