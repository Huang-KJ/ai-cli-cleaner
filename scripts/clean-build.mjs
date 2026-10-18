import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import native from "../lib/native-helper.cjs";

const run = promisify(execFile);

export async function cleanBuild(directory = fileURLToPath(new URL("../dist", import.meta.url)), options = {}) {
  const absolute = path.resolve(directory);
  let info;
  try {
    info = await fs.lstat(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Build cleanup only accepts a real dist directory; symlinks are not allowed.");
  }
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("Build cleanup only supports the macOS system Trash.");
  }
  const binary = native.verifyNativeArtifact();
  // 固定使用原生 helper，失敗時保留資料並中止 build。
  await (options.run ?? ((helper, paths) => run(helper, paths, { timeout: 60_000 })))(binary, [absolute]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cleanBuild();
}
