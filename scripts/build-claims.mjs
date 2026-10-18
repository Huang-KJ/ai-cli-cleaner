import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "native", "claims.m");
const binary = path.join(root, "vendor", "macos-claims");
execFileSync("/usr/bin/clang", ["-arch", "x86_64", "-arch", "arm64", "-mmacosx-version-min=13.3", "-O2", "-fobjc-arc", "-framework", "Foundation", source, "-o", binary], { stdio: "inherit" });
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const pinned = { formatVersion: 1, binarySha256: hash(binary), binaryBytes: statSync(binary).size, sourceSha256: hash(source), architectures: ["x86_64", "arm64"] };
writeFileSync(path.join(root, "vendor", "claims-provenance.json"), `${JSON.stringify(pinned)}\n`);
const verifier = path.join(root, "lib", "claim-helper.cjs");
writeFileSync(verifier, readFileSync(verifier, "utf8").replace(/^const pinned = .*;$/m, `const pinned = ${JSON.stringify(pinned)};`));
console.log(JSON.stringify(pinned));
