const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { promises: fs } = require("node:fs");
const path = require("node:path");

const version = "12.2.0";
const integrity = "ZsJjKpTnlmSXOLLXiU1xDCzC4Wlok4IwZmh/aw2KUuXytU7q6qMv/cUT7MoeSf95Slwuw/lRXYefGzGCspHPNQ==";
const limit = 20 * 1024 * 1024;

async function downloadArchive() {
  const response = await fetch(`https://registry.npmjs.org/npm/-/npm-${version}.tgz`, {
    redirect: "error", signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) {
    throw new Error("Cannot download the pinned npm archive.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("The npm archive exceeded the size limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function bootstrapNpm(destination, download = downloadArchive) {
  if (!destination || !path.isAbsolute(destination)) throw new Error("An absolute npm destination is required.");
  const bytes = await download();
  if (!Buffer.isBuffer(bytes) || bytes.length > limit || createHash("sha512").update(bytes).digest("base64") !== integrity) {
    throw new Error("npm archive integrity verification failed.");
  }
  // 驗證完整 archive 後才建立目錄、解壓及執行工具。
  await fs.mkdir(destination, { mode: 0o700 });
  const modules = path.join(destination, "node_modules");
  const npm = path.join(modules, "npm");
  const bin = path.join(modules, ".bin");
  await fs.mkdir(modules);
  await fs.mkdir(npm);
  await fs.mkdir(bin);
  execFileSync("/usr/bin/tar", ["-xz", "--strip-components=1", "-C", npm], { input: bytes });
  await fs.symlink("../npm/bin/npm-cli.js", path.join(bin, "npm"));
  const installed = execFileSync(process.execPath, [path.join(npm, "bin/npm-cli.js"), "--version"], { encoding: "utf8" }).trim();
  if (installed !== version) throw new Error("The pinned npm version does not match.");
  console.log(installed);
}

module.exports = { bootstrapNpm, version };
if (require.main === module) bootstrapNpm(process.argv[2]).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
