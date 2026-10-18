import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { parseVersion, compareVersions } = createRequire(import.meta.url)("../lib/version.cjs") as {
  parseVersion: (value: unknown) => { core: bigint[]; prerelease: string[] } | undefined;
  compareVersions: (left: string, right: string) => number;
};

describe("shared release version contract", () => {
  it.each(["01.2.3", "1.02.3", "1.2.03", "1.0.0-a..b", "1.0.0-01", "1.0.0+", "1.0.0+foo..bar",
    "1.2", "v1.2.3", " 1.2.3", "1.2.3\n", "1.2.3\r\n", "1.2.3/other", "1.2.3-" + "a".repeat(128), null, 123])(
    "refuses invalid version %s", (value) => {
      expect(parseVersion(value)).toBeUndefined();
      if (typeof value === "string") expect(() => compareVersions(value, "1.0.0")).toThrow("Invalid release version.");
    }
  );

  it("preserves exact numeric precision and accepts build metadata", () => {
    expect(parseVersion("9007199254740993.2.3-beta.10+build.01")).toEqual({
      core: [9007199254740993n, 2n, 3n], prerelease: ["beta", "10"]
    });
    expect(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBe(1);
    expect(compareVersions("1.0.0+build.01", "1.0.0+different")).toBe(0);
  });

  it("follows SemVer prerelease precedence", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2",
      "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
    for (let index = 1; index < ordered.length; index++) {
      expect(compareVersions(ordered[index - 1]!, ordered[index]!)).toBe(-1);
      expect(compareVersions(ordered[index]!, ordered[index - 1]!)).toBe(1);
    }
  });
});
