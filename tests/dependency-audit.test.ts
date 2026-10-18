import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assessAudit } = require("../scripts/audit-dependencies.cjs");
const documented = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const chain = ["braces", "fast-glob", "globby", "micromatch", "trash"];

function knownReport() {
  const vulnerabilities: Record<string, { severity: string; via: Array<string | Record<string, unknown>> }> = {
    braces: { severity: "high", via: [{ name: "braces", dependency: "braces", severity: "high", url: documented }] },
    micromatch: { severity: "high", via: ["braces"] },
    "fast-glob": { severity: "high", via: ["micromatch"] },
    globby: { severity: "high", via: ["fast-glob"] },
    trash: { severity: "high", via: ["globby"] }
  };
  return { vulnerabilities };
}

describe("dependency advisory policy", () => {
  it("blocks a five-package advisory chain without exceptions", () => {
    expect(assessAudit(knownReport())).toEqual(chain);
  });

  it("blocks an additional high advisory on the same package", () => {
    const report = knownReport();
    report.vulnerabilities.braces!.via.push({ url: "https://github.com/advisories/GHSA-new-issue", severity: "high" });
    expect(assessAudit(report)).toEqual(chain);
  });

  it("blocks a new high package even when it inherits the known advisory", () => {
    const report = knownReport();
    report.vulnerabilities["unexpected-package"] = { severity: "high", via: ["braces"] };
    expect(assessAudit(report)).toEqual([...chain, "unexpected-package"]);
  });

  it("blocks critical severity regardless of advisory URL", () => {
    expect(assessAudit({ vulnerabilities: {
      braces: { severity: "critical", via: [{ severity: "high", url: documented }] }
    } })).toEqual(["braces"]);
  });

  it("blocks an unknown critical package without requiring an advisory reference", () => {
    expect(assessAudit({ vulnerabilities: {
      unexpected: { severity: "critical", via: [] }
    } })).toEqual(["unexpected"]);
  });

  it.each([["low", "high"], ["moderate", "critical"]])("blocks a %s package with a %s advisory object", (severity, advisorySeverity) => {
    expect(assessAudit({ vulnerabilities: {
      unexpected: { severity, via: [{ severity: advisorySeverity, url: documented }] }
    } })).toEqual(["unexpected"]);
  });

  it("rejects invalid audit reports and package severity", () => {
    expect(() => assessAudit({ error: { code: "ENOTFOUND" } })).toThrow(/Dependency audit/);
    expect(() => assessAudit({})).toThrow(/Dependency audit/);
    expect(() => assessAudit({ vulnerabilities: [] })).toThrow(/Dependency audit/);
    expect(() => assessAudit({ vulnerabilities: { invalid: { severity: "unknown", via: [] } } })).toThrow(/severity format/);
  });

  it("rejects a non-array advisory list even for a low-severity package", () => {
    expect(() => assessAudit({ vulnerabilities: {
      malformed: { severity: "low", via: { severity: "critical" } }
    } })).toThrow(/advisory format/);
  });

  it("rejects malformed advisory elements rather than skipping low-severity packages", () => {
    const report = (via: unknown) => ({ vulnerabilities: { malformed: { severity: "low", via: [via] } } });
    expect(() => assessAudit(report({ url: documented }))).toThrow(/advisory format/);
    expect(() => assessAudit(report({ severity: "unknown" }))).toThrow(/advisory format/);
    expect(() => assessAudit(report([]))).toThrow(/advisory format/);
    expect(() => assessAudit(report(false))).toThrow(/advisory format/);
  });

  it("still blocks high/critical risk when dependency references are incomplete or cyclic", () => {
    expect(assessAudit({ vulnerabilities: {
      missing: { severity: "high", via: ["unknown"] },
      cycle: { severity: "critical", via: ["cycle"] }
    } })).toEqual(["cycle", "missing"]);
  });

  it("does not block valid low/moderate advisories when no high/critical risk is reported", () => {
    expect(assessAudit({ vulnerabilities: {
      lower: { severity: "moderate", via: [{ severity: "moderate", url: documented }] },
      low: { severity: "low", via: ["lower"] }
    } })).toEqual([]);
  });

  it("reports a clean audit without requiring an advisory exception", () => {
    expect(assessAudit({ vulnerabilities: {} })).toEqual([]);
  });
});
