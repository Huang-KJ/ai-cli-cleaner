const { spawnSync } = require("node:child_process");
const allowedSeverities = ["info", "low", "moderate", "high", "critical"];

function assessAudit(report) {
  if (!report || report.error || !report.vulnerabilities || typeof report.vulnerabilities !== "object" || Array.isArray(report.vulnerabilities)) {
    throw new Error("Dependency audit did not return a valid report.");
  }
  const vulnerabilities = report.vulnerabilities;
  const blocked = [];
  for (const name of Object.keys(vulnerabilities).sort()) {
    const item = vulnerabilities[name];
    if (!item || !allowedSeverities.includes(item.severity)) throw new Error("Invalid dependency audit severity format.");
    if (!Array.isArray(item.via) || item.via.some((via) => typeof via !== "string" &&
      (!via || typeof via !== "object" || Array.isArray(via) || !allowedSeverities.includes(via.severity)))) {
      throw new Error("Invalid dependency advisory format.");
    }
    const severities = [item.severity, ...item.via.filter((via) => typeof via !== "string").map((via) => via.severity)];
    if (!severities.some((severity) => ["high", "critical"].includes(severity))) continue;
    blocked.push(name);
  }
  return blocked;
}

function main() {
  const result = spawnSync("npm", ["audit", "--json", "--package-lock-only"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000
  });
  if (result.error || ![0, 1].includes(result.status)) throw new Error("Could not complete npm audit; check your network connection and registry.", { cause: result.error });
  const blocked = assessAudit(JSON.parse(result.stdout));
  if (blocked.length) throw new Error(`High/critical dependency risks found: ${blocked.join(", ")}`);
  console.log("Dependency audit passed the current risk policy; this does not mean there are no vulnerabilities.");
}

module.exports = { assessAudit };
if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
