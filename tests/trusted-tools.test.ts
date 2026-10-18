import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { findRunningAgents } from "../src/fs/agent-processes.js";
import { findOpenPaths } from "../src/fs/open-files.js";
import { trustedToolPath } from "../src/fs/trusted-tools.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fixtureTrash(root)));
});

async function poisonedPath(tool: string): Promise<string> {
  const root = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-tools-"));
  roots.push(root);
  const marker = path.join(root, "executed");
  await fs.writeFile(path.join(root, tool), `#!/bin/sh\nprintf executed > '${marker}'\nexit 97\n`, { mode: 0o700 });
  vi.stubEnv("PATH", `${root}:${process.env.PATH ?? ""}`);
  return marker;
}

it("reads real process status without executing a PATH-provided ps", async () => {
  const marker = await poisonedPath("ps");
  await expect(findRunningAgents([])).resolves.toEqual([]);
  await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("detects a real open file without executing a PATH-provided lsof", async () => {
  const marker = await poisonedPath("lsof");
  const file = path.join(path.dirname(marker), "open.txt");
  const handle = await fs.open(file, "w");
  try {
    const result = await findOpenPaths([file]);
    expect(result.supported).toBe(true);
    expect(result.openPaths).toContain(file);
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await handle.close(); }
});

it("rejects writable tool ancestors and symlink aliases", async () => {
  const marker = await poisonedPath("npm");
  const root = path.dirname(marker);
  const unsafe = path.join(root, "unsafe");
  await fs.mkdir(unsafe);
  await fs.chmod(unsafe, 0o777);
  const alias = path.join(unsafe, "npm");
  await fs.symlink(path.join(root, "npm"), alias);
  await expect(trustedToolPath(alias, "executable")).rejects.toThrow("untrusted principal");
  await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects ACL write grants even when POSIX permissions are restrictive", async () => {
  const marker = await poisonedPath("npm");
  const file = path.join(path.dirname(marker), "npm");
  await promisify(execFile)("/bin/chmod", ["+a", "everyone allow write", file]);
  await expect(trustedToolPath(file, "executable")).rejects.toThrow("untrusted principal");
});

it("rejects an intermediate symlink target in a writable directory", async () => {
  const marker = await poisonedPath("npm");
  const root = path.dirname(marker);
  const unsafe = path.join(root, "unsafe");
  await fs.mkdir(unsafe);
  await fs.chmod(unsafe, 0o777);
  await fs.symlink(path.join(root, "npm"), path.join(unsafe, "bridge"));
  const alias = path.join(root, "alias");
  await fs.symlink(path.join(unsafe, "bridge"), alias);
  await expect(trustedToolPath(alias, "executable")).rejects.toThrow("untrusted principal");
});
