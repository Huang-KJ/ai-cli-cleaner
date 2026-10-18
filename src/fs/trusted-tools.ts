import { constants, promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export const systemTools = { ps: "/bin/ps", lsof: "/usr/sbin/lsof" } as const;

export function toolEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", HOME: userInfo().homedir };
}

// 信任錨點由呼叫端固定；權限檢查不能讓任意 PATH 候選變成可信工具。
export async function trustedToolPath(
  file: string,
  kind: "executable" | "file" | "directory",
  system = false,
  contents = false
): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error("Trusted tools require an absolute path.");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Cannot identify the tool owner.");
  const checked = new Set<string>();
  const inspect = async (target: string, rootOnly = system): Promise<void> => {
    for (let current = path.resolve(target);; current = path.dirname(current)) {
      if (checked.has(current)) break;
      const info = await fs.lstat(current);
      const owner = info.uid === 0 || (!rootOnly && info.uid === uid);
      // sticky root 暫存目錄只能保護由可信擁有者持有的下一層項目。
      const sticky = info.isDirectory() && info.uid === 0 && (info.mode & 0o1000) !== 0;
      if (!owner || (!info.isSymbolicLink() && (info.mode & 0o022) !== 0 && !sticky)) {
        throw new Error("Tool path is writable by an untrusted principal.");
      }
      checked.add(current);
      if (info.isSymbolicLink()) {
        await inspect(path.resolve(path.dirname(current), await fs.readlink(current)), rootOnly);
      }
      if (current === path.dirname(current)) break;
    }
  };
  await inspect("/bin/ls", true);
  const absolute = path.resolve(file);
  // 同時檢查連結所在目錄與實際目標，避免可寫的別名目錄繞過檢查。
  await inspect(absolute);
  const canonical = await fs.realpath(absolute);
  await inspect(canonical);
  if (contents) {
    const visited = new Set<string>();
    const walk = async (target: string): Promise<void> => {
      await inspect(target);
      const resolved = await fs.realpath(target);
      const relative = path.relative(canonical, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Tool code resolves outside its trusted package.");
      }
      if (visited.has(resolved)) return;
      visited.add(resolved);
      const info = await fs.lstat(resolved);
      if (info.isDirectory()) {
        for (const entry of await fs.readdir(resolved)) await walk(path.join(resolved, entry));
      } else if (!info.isFile()) throw new Error("Invalid trusted tool code type.");
    };
    await walk(canonical);
  }
  // macOS ACL 可在 POSIX mode 之外授予寫入權限；固定工具以唯讀方式檢查。
  const paths = [...checked];
  for (let offset = 0; offset < paths.length; offset += 128) {
    const { stdout, stderr } = await execute("/bin/ls", ["-lde", ...paths.slice(offset, offset + 128)], {
      env: toolEnvironment(), timeout: 10_000, maxBuffer: 1024 * 1024
    });
    if (stderr.trim() || /^\s*\d+:.*\ballow\b.*\b(?:write\w*|append|add_file|add_subdirectory|delete\w*|chown)\b/m.test(stdout)) {
      throw new Error("Tool path ACL is writable by an untrusted principal.");
    }
  }
  const info = await fs.lstat(canonical);
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) throw new Error("Invalid trusted tool path type.");
  await fs.access(canonical, kind === "executable" ? constants.X_OK : constants.R_OK);
  return canonical;
}
