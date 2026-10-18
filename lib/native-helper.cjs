const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const provenance = Object.freeze({
  name: "macos-trash",
  version: "3.0.0",
  repository: "https://github.com/sindresorhus/macos-trash",
  tag: "v3.0.0",
  tagObject: "83b3414c0c0fc657e75f91228c5a05ad1d1c6248",
  commit: "9358749ddd1bff42e2251168e35f2e11dbbb88db",
  archiveUrl: "https://github.com/sindresorhus/macos-trash/releases/download/v3.0.0/trash.zip",
  archiveSha256: "194b75a70218a256c044f5022d48711d0f16c8248e34ca02113a93b46aa1415f",
  archiveBytes: 280858,
  binarySha256: "cc802989bab3f97ce608b5b88838302dda65f1481bb8775b3c342830677bde68",
  binaryBytes: 726312,
  licenseUrl: "https://raw.githubusercontent.com/sindresorhus/macos-trash/9358749ddd1bff42e2251168e35f2e11dbbb88db/license",
  licenseSha256: "5c932d88256b4ab958f64a856fa48e8bd1f55bc1d96b8149c65689e0c61789d3",
  licenseBytes: 1117
});
const projectRoot = path.resolve(__dirname, "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function regularFile(file, size, executable = false) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== size || (executable && !(info.mode & 0o111))) {
    throw new Error(`Invalid native artifact format, size, or executable permission: ${file}`);
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== size) throw new Error("Native artifact changed before verification.");
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function verifyNativeArtifact(root = projectRoot) {
  try {
    const base = fs.realpathSync(root);
    const directory = path.join(base, "vendor");
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error("Native artifact directory must be a real directory.");
    const metadataFile = path.join(directory, "provenance.json");
    const metadataInfo = fs.lstatSync(metadataFile);
    if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.size > 4096) throw new Error("Invalid native artifact provenance.");
    const metadata = JSON.parse(regularFile(metadataFile, metadataInfo.size).toString("utf8"));
    if (!metadata || Object.keys(metadata).length !== Object.keys(provenance).length ||
      !Object.entries(provenance).every(([key, value]) => Object.hasOwn(metadata, key) && metadata[key] === value)) {
      throw new Error("Native artifact provenance does not match the pinned version.");
    }
    const binary = path.join(directory, "macos-trash");
    if (hash(regularFile(binary, provenance.binaryBytes, true)) !== provenance.binarySha256) throw new Error("Native artifact SHA-256 mismatch.");
    if (hash(regularFile(path.join(directory, "license"), provenance.licenseBytes)) !== provenance.licenseSha256) throw new Error("Native artifact license is incomplete.");
    return binary;
  } catch (error) {
    throw new Error(`Native Trash artifact verification failed: ${error.message}`, { cause: error });
  }
}

async function verifyUpstream() {
  // 只讀固定官方來源；來源紀錄不能提供任意下載位址。
  const api = "https://api.github.com/repos/sindresorhus/macos-trash";
  const deadline = performance.now() + 90_000;
  const hosts = new Set(["api.github.com", "github.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
  async function download(url, limit, redirects = 0) {
    const address = new URL(url);
    if (address.protocol !== "https:" || !hosts.has(address.hostname) || redirects > 3) throw new Error("Invalid native artifact upstream source.");
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error("Native artifact upstream check timed out.");
    const headers = { "User-Agent": "ai-cli-cleaner-native-verifier" };
    if (address.hostname === "api.github.com" && process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(Math.min(30_000, remaining)) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Invalid native artifact upstream redirect.");
      return download(new URL(location, address).href, limit, redirects + 1);
    }
    if (!response.ok || !response.body) throw new Error(`Native artifact upstream check failed: HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error("Native artifact upstream response exceeded the size limit.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  const json = async (url) => JSON.parse((await download(url, 128 * 1024)).toString("utf8"));
  const ref = await json(`${api}/git/ref/tags/${provenance.tag}`);
  if (ref.object?.type !== "tag" || ref.object.sha !== provenance.tagObject) throw new Error("Native artifact upstream tag object mismatch.");
  const tag = await json(`${api}/git/tags/${provenance.tagObject}`);
  if (tag.object?.type !== "commit" || tag.object.sha !== provenance.commit) throw new Error("Native artifact upstream commit mismatch.");
  const release = await json(`${api}/releases/tags/${provenance.tag}`);
  const assets = release.assets?.filter((asset) => asset.name === "trash.zip");
  if (release.tag_name !== provenance.tag || !Array.isArray(assets) || assets.length !== 1 ||
    assets[0].browser_download_url !== provenance.archiveUrl || assets[0].size !== provenance.archiveBytes ||
    assets[0].digest !== `sha256:${provenance.archiveSha256}`) throw new Error("Native artifact official release metadata mismatch.");
  const archive = await download(provenance.archiveUrl, provenance.archiveBytes);
  if (archive.length !== provenance.archiveBytes || hash(archive) !== provenance.archiveSha256) throw new Error("Native artifact official archive SHA-256 mismatch.");
  const license = await download(provenance.licenseUrl, provenance.licenseBytes);
  if (license.length !== provenance.licenseBytes || hash(license) !== provenance.licenseSha256) throw new Error("Native artifact official license SHA-256 mismatch.");
  const latest = await json(`${api}/releases/latest`);
  if (!/^v\d+\.\d+\.\d+$/.test(latest.tag_name)) throw new Error("Invalid latest native artifact release metadata.");
  return { pinnedSourceVerified: true, latest: latest.tag_name, updateAvailable: latest.tag_name !== provenance.tag };
}

module.exports = { verifyNativeArtifact };
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some((arg) => arg !== "--upstream")) throw new Error("Only --upstream is accepted.");
    verifyNativeArtifact();
    const upstream = args.includes("--upstream") ? await verifyUpstream() : undefined;
    console.log(JSON.stringify({ version: provenance.version, binarySha256: provenance.binarySha256, licenseSha256: provenance.licenseSha256, upstream }));
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
