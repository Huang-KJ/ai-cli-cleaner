import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import { containsPath } from "../fs/paths.js";

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function trustedHome(home: string): Promise<string> {
  if (!path.isAbsolute(home)) throw new Error("Recovery home must be an absolute path.");
  const stat = await fs.lstat(home);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Recovery home must be a regular directory.");
  return fs.realpath(home);
}

// 每個家目錄以下的元件都須是本人持有的私有一般目錄。
export async function privateDirectory(home: string, directory: string, create = false): Promise<void> {
  const root = path.resolve(home);
  const target = path.resolve(directory);
  if (!containsPath(root, target) || root === target) throw new Error("Recovery directory is outside the home directory.");
  const canonical = await trustedHome(root);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (create) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
        await syncDirectory(path.dirname(current));
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      }
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
      throw new Error(`Recovery path must be a directory owned by the current user with mode 0700: ${current}`);
    }
    const expected = path.join(canonical, path.relative(root, current));
    if (await fs.realpath(current) !== expected) throw new Error("Recovery directory was redirected.");
  }
}

export async function openPrivateFile(home: string, file: string): Promise<FileHandle> {
  await privateDirectory(home, path.dirname(file));
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const current = await fs.lstat(file);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
      current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new Error(`Recovery file must be a regular file owned by the current user with mode 0600: ${file}`);
    }
    await privateDirectory(home, path.dirname(file));
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readPrivateFile(home: string, file: string): Promise<Buffer> {
  const handle = await openPrivateFile(home, file);
  try {
    if ((await handle.stat()).size > 32 * 1024 * 1024) throw new Error("Recovery record exceeds the size limit.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function syncPrivateFile(home: string, file: string): Promise<void> {
  const handle = await openPrivateFile(home, file);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error("Sync path must be a regular directory.");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writePrivateSnapshot(home: string, file: string, value: unknown): Promise<void> {
  await privateDirectory(home, path.dirname(file));
  try {
    const existing = await openPrivateFile(home, file);
    await existing.close();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = path.join(path.dirname(file), `${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // 同步失敗時保留暫存紀錄；不繼續修改來源資料。
  await privateDirectory(home, path.dirname(file));
  await fs.rename(temporary, file);
  await syncDirectory(path.dirname(file));
}
