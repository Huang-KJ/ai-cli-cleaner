import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const { createTemporaryDirectory } = await vi.importActual<typeof import("../src/fs/temporary.js")>("../src/fs/temporary.js");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fixtureTrash(root, { recursive: true, force: true })));
});

function substitutedArchive(marker: string): Buffer {
  const entries = [
    ["package/package.json", JSON.stringify({ name: "npm", version: "12.2.0" })],
    ["package/bin/npm-cli.js", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); console.log("12.2.0");`]
  ];
  const chunks: Buffer[] = [];
  for (const [name, source] of entries) {
    const body = Buffer.from(source!);
    const header = Buffer.alloc(512);
    header.write(name!);
    header.write("0000755\0", 100);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header[156] = 48;
    header.fill(32, 148, 156);
    header.write(`${header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

describe("pinned npm workflow bootstrap", () => {
  it("rejects substituted npm bytes before writing or extracting downloaded code", async () => {
    const root = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-bootstrap-test-"));
    roots.push(root);
    const destination = path.join(root, "npm");
    const marker = path.join(root, "executed");
    const { bootstrapNpm } = createRequire(import.meta.url)("../scripts/bootstrap-npm.cjs") as {
      bootstrapNpm: (destination: string, download?: () => Promise<Buffer>) => Promise<void>;
    };
    await expect(bootstrapNpm(destination, async () => substitutedArchive(marker)))
      .rejects.toThrow("npm archive integrity verification failed");
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("private temporary staging", () => {
  it.each(["parent", "ancestor", "acl"])("refuses an untrusted %s before creating preflight copies", async (kind) => {
    const root = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-temp-test-"));
    roots.push(root);
    const parent = path.join(root, "parent");
    const target = kind === "ancestor" ? path.join(parent, "private") : parent;
    await fs.mkdir(parent, { mode: 0o700 });
    if (kind === "ancestor") await fs.mkdir(target, { mode: 0o700 });
    if (kind === "acl") {
      await promisify(execFile)("/bin/chmod", ["+a", "everyone allow add_file,add_subdirectory,delete_child", parent]);
    } else await fs.chmod(parent, 0o777);
    await expect(createTemporaryDirectory(path.join(target, "ai-cleaner-preflight-"))).rejects.toThrow(/writable|untrusted/);
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("creates private copies only under the canonical trusted parent", async () => {
    const root = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-temp-test-"));
    roots.push(root);
    const directory = await createTemporaryDirectory(path.join(root, "ai-cleaner-preflight-"));
    const info = await fs.lstat(directory);
    expect(path.dirname(await fs.realpath(directory))).toBe(await fs.realpath(root));
    expect(info.uid).toBe(process.getuid?.());
    expect(info.mode & 0o7777).toBe(0o700);
  });
});
