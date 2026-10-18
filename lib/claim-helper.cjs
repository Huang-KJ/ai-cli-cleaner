const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const pinned = {"formatVersion":1,"binarySha256":"6256623fa7d0bbfbd204020aa6b0647b2ea851b3378f917fe4cb254f9580a435","binaryBytes":121120,"sourceSha256":"7d074e93056e4320ab531aa0e53cf9103f97f7c08bb4a3ec22e0b3ad13a7f231","architectures":["x86_64","arm64"]};

function verifyClaimArtifact(root = path.resolve(__dirname, "..")) {
  try {
    const base = fs.realpathSync(root);
    const vendor = path.join(base, "vendor");
    const directory = fs.lstatSync(vendor);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Native claim directory must be physical.");
    const read = (file, limit, executable = false) => {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.size > limit || (executable && !(info.mode & 0o111))) throw new Error("Invalid native claim artifact format or size.");
        return fs.readFileSync(fd);
      } finally { fs.closeSync(fd); }
    };
    const metadata = JSON.parse(read(path.join(vendor, "claims-provenance.json"), 4096).toString("utf8"));
    if (JSON.stringify(metadata) !== JSON.stringify(pinned)) throw new Error("Native claim provenance differs from the pinned artifact.");
    const binary = path.join(vendor, "macos-claims");
    const bytes = read(binary, pinned.binaryBytes, true);
    if (bytes.length !== pinned.binaryBytes || createHash("sha256").update(bytes).digest("hex") !== pinned.binarySha256) throw new Error("Native claim artifact hash differs.");
    const sourceDirectory = fs.lstatSync(path.join(base, "native"));
    if (!sourceDirectory.isDirectory() || sourceDirectory.isSymbolicLink()) throw new Error("Native claim source directory must be physical.");
    if (createHash("sha256").update(read(path.join(base, "native", "claims.m"), 1024 * 1024)).digest("hex") !== pinned.sourceSha256) throw new Error("Native claim source differs from the built artifact.");
    return binary;
  } catch (error) { throw new Error(`Native claim artifact verification failed: ${error.message}`, { cause: error }); }
}
module.exports = { verifyClaimArtifact };
if (require.main === module) { verifyClaimArtifact(); console.log(JSON.stringify(pinned)); }
