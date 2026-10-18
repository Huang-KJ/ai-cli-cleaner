import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, compareVersions, installUpdate, type UpdateResult, type UpdateTransport, type UpdateRunner } from "../src/update.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { moveToSystemTrash } from "../src/fs/trash.js";
import { snapshotClaimIdentity } from "../src/fs/claims.js";

const executions = vi.hoisted(() => [] as { file: string; env?: NodeJS.ProcessEnv }[]);
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = promisify(actual.execFile);
  return { ...actual, execFile: Object.assign(actual.execFile.bind(null), {
    [Symbol.for("nodejs.util.promisify.custom")]: async (file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      executions.push({ file, env: options.env });
      return run(file, args, options);
    }
  }) };
});

const api = "https://api.github.com/repos/Huang-KJ/ai-cli-cleaner";
const roots: string[] = [];
afterEach(async () => {
  executions.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((directory) => fixtureTrash(directory, { recursive: true, force: true })));
});
function release(number = "1.0.0", options: Record<string, unknown> = {}) {
  return {
    tag_name: `v${number}`, draft: false, prerelease: number.includes("-"), published_at: "2026-10-01T00:00:00Z",
    html_url: `https://github.com/Huang-KJ/ai-cli-cleaner/releases/tag/v${number}`,
    assets: [
      { id: 1, name: `ai-cli-cleaner-${number}.tgz`, size: 1, url: `${api}/releases/assets/1` },
      { id: 2, name: "SHA256SUMS", size: 1, url: `${api}/releases/assets/2` }
    ], ...options
  };
}
const metadata = (data: unknown): UpdateTransport => vi.fn(async () => Buffer.from(JSON.stringify(data)));
function archive(number = "1.0.0", name = "ai-cli-cleaner", extra: Record<string, unknown> = {}): Buffer {
  const manifest = Buffer.from(JSON.stringify({ name, version: number, ...extra }));
  const header = Buffer.alloc(512);
  header.write("package/package.json");
  header.write(`${manifest.length.toString(8).padStart(11, "0")}\0`, 124);
  header[156] = 48;
  header.fill(32, 148, 156);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(Buffer.concat([header, manifest, Buffer.alloc(512 - manifest.length), Buffer.alloc(1024)]));
}
async function fixture(bytes = archive(), sum?: string) {
  const directory = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-update-test-"));
  roots.push(directory);
  const prefix = path.join(directory, "prefix");
  const globalRoot = path.join(prefix, "lib", "node_modules");
  const packageRoot = path.join(globalRoot, "ai-cli-cleaner");
  await fs.mkdir(packageRoot, { recursive: true });
  // CI 可另外安裝 npm；只在合成 prefix 明確連結測試啟動器的工具鏈。
  const npmCli = process.env.npm_execpath ?? path.resolve(path.dirname(await fs.realpath(process.execPath)), "../lib/node_modules/npm/bin/npm-cli.js");
  await fs.symlink(path.resolve(await fs.realpath(npmCli), "../.."), path.join(globalRoot, "npm"));
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "ai-cli-cleaner", version: "0.1.0-beta.1" }));
  const sums = Buffer.from(`${sum ?? createHash("sha256").update(bytes).digest("hex")}  ai-cli-cleaner-1.0.0.tgz\n`);
  const entry = release();
  entry.assets[0]!.size = bytes.length;
  entry.assets[1]!.size = sums.length;
  const transport: UpdateTransport = vi.fn(async (url) => url.endsWith("/1") ? bytes : url.endsWith("/2") ? sums : Buffer.from(JSON.stringify([entry])));
  const result = await checkForUpdate({ currentVersion: "0.1.0-beta.1", transport });
  const run = vi.fn<UpdateRunner>(async (args) => {
    if (args[0] === "install") await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "ai-cli-cleaner", version: "1.0.0" }));
    return args[0] === "prefix" ? prefix : args[0] === "root" ? globalRoot : args[0] === "--version" ? "12.2.0" : "installed";
  });
  const trash = vi.fn(async (paths: string[]) => { await fixtureTrash(paths[0]!); });
  const createTemp = async () => {
    const stage = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-update-"));
    roots.push(stage);
    return stage;
  };
  return { directory, prefix, globalRoot, packageRoot, transport, result, run, trash, createTemp, uid: 501 };
}

describe("GitHub release update checks", () => {
  it("orders every SemVer prerelease type and ignores build metadata", () => {
    const versions = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "2.0.0"];
    for (let i = 1; i < versions.length; i++) expect(compareVersions(versions[i]!, versions[i - 1]!)).toBe(1);
    expect(compareVersions("1.0.0+one", "1.0.0+two")).toBe(0);
    expect(compareVersions("999999999999999999999.0.0", "2.0.0")).toBe(1);
    for (const invalid of ["01.0.0", "1.0", "1.0.0-beta.01", "1.0.0/../x"]) expect(() => compareVersions(invalid, "1.0.0")).toThrow("Invalid release version");
  });
  it("selects the highest published stable release and requires explicit prereleases", async () => {
    const transport = metadata([release("2.0.0-beta.1"), release("1.0.0"), release("1.1.0"), release("5.0.0", { draft: true }), release("9.0.0", { published_at: null })]);
    expect((await checkForUpdate({ currentVersion: "0.1.0-beta.1", transport })).latestVersion).toBe("1.1.0");
    expect((await checkForUpdate({ currentVersion: "0.1.0-beta.1", prerelease: true, transport })).latestVersion).toBe("2.0.0-beta.1");
    expect(transport).toHaveBeenCalledWith(`${api}/releases?per_page=100&page=1`, expect.objectContaining({ maxBytes: 2097152 }));
  });
  it("finds a stable release after more than 100 published beta releases", async () => {
    const betas = Array.from({ length: 100 }, (_, index) => release(`3.0.0-beta.${index}`));
    const transport: UpdateTransport = vi.fn(async (url) => Buffer.from(JSON.stringify(url.endsWith("page=1") ? betas : [release("2.0.0-beta.1"), release("1.2.0")])));
    const result = await checkForUpdate({ currentVersion: "0.1.0-beta.1", transport });
    expect(result.latestVersion).toBe("1.2.0");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenLastCalledWith(`${api}/releases?per_page=100&page=2`, expect.objectContaining({ maxBytes: 2097152 }));
  });
  it("compares all pages rather than assuming GitHub's publication order is version order", async () => {
    const older = Array.from({ length: 100 }, (_, index) => release(`1.0.${index}`));
    const transport: UpdateTransport = vi.fn(async (url) => Buffer.from(JSON.stringify(url.endsWith("page=1") ? older : [release("4.0.0-beta.1"), release("3.0.0")])));
    expect((await checkForUpdate({ currentVersion: "1.0.0", transport })).latestVersion).toBe("3.0.0");
    expect((await checkForUpdate({ currentVersion: "1.0.0", prerelease: true, transport })).latestVersion).toBe("4.0.0-beta.1");
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it("requires a final short page when the release count is exactly a page boundary", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => release(`1.0.${index}`));
    const transport: UpdateTransport = vi.fn(async (url) => Buffer.from(JSON.stringify(url.endsWith("page=1") ? entries : [])));
    expect((await checkForUpdate({ currentVersion: "1.0.0", transport })).latestVersion).toBe("1.0.99");
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("fails the whole check on a later HTTP or metadata error instead of returning an earlier candidate", async () => {
    const entries = Array.from({ length: 100 }, () => release());
    const failures: (() => Promise<Buffer>)[] = [
      async () => { throw new Error("GitHub update request failed (HTTP 503)."); },
      async () => Buffer.from("not JSON"),
      async () => Buffer.from(JSON.stringify({ message: "Not Found" })),
      async () => Buffer.from(JSON.stringify(Array.from({ length: 101 }, () => release())))
    ];
    for (const fail of failures) {
      const transport: UpdateTransport = vi.fn(async (url) => url.endsWith("page=1") ? Buffer.from(JSON.stringify(entries)) : fail());
      await expect(checkForUpdate({ currentVersion: "0.1.0-beta.1", transport })).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(2);
    }
  });
  it("fails closed after ten full pages even if they contain eligible releases", async () => {
    const body = Buffer.from(JSON.stringify(Array.from({ length: 100 }, () => release())));
    const transport: UpdateTransport = vi.fn(async () => body);
    await expect(checkForUpdate({ currentVersion: "0.1.0-beta.1", transport })).rejects.toThrow("latest version could not be determined safely");
    expect(transport).toHaveBeenCalledTimes(10);
    expect(transport).toHaveBeenLastCalledWith(`${api}/releases?per_page=100&page=10`, expect.anything());
  });
  it("bounds aggregate metadata size across individually valid pages", async () => {
    const body = Buffer.from(JSON.stringify(Array.from({ length: 100 }, () => release("1.0.0", { body: "x".repeat(18500) }))));
    expect(body.length).toBeLessThan(2 * 1024 * 1024);
    const transport: UpdateTransport = vi.fn(async () => body);
    await expect(checkForUpdate({ currentVersion: "0.1.0-beta.1", transport })).rejects.toThrow("size limit");
    expect(transport).toHaveBeenCalledTimes(5);
    const calls = vi.mocked(transport).mock.calls;
    expect(calls[4]![1].maxBytes).toBe(8 * 1024 * 1024 - 4 * body.length);
  });
  it("preserves build metadata and accepts only fixed raw or encoded release tag URLs", async () => {
    for (const html_url of ["https://github.com/Huang-KJ/ai-cli-cleaner/releases/tag/v1.0.0+build.1", "https://github.com/Huang-KJ/ai-cli-cleaner/releases/tag/v1.0.0%2Bbuild.1"]) {
      const result = await checkForUpdate({ currentVersion: "0.1.0-beta.1", transport: metadata([release("1.0.0+build.1", { html_url })]) });
      expect(result.latestVersion).toBe("1.0.0+build.1");
      expect(result.archive.name).toBe("ai-cli-cleaner-1.0.0+build.1.tgz");
      expect(result.releaseUrl).toBe("https://github.com/Huang-KJ/ai-cli-cleaner/releases/tag/v1.0.0%2Bbuild.1");
    }
    for (const html_url of ["https://github.com/other/ai-cli-cleaner/releases/tag/v1.0.0%2Bbuild.1", "https://github.com/Huang-KJ/ai-cli-cleaner/releases/tag/v1.0.0%252Bbuild.1"]) {
      await expect(checkForUpdate({ currentVersion: "0.1.0-beta.1", transport: metadata([release("1.0.0+build.1", { html_url })]) })).rejects.toThrow("Invalid GitHub release metadata");
    }
  });
  it("reports no newer release without offering a downgrade", async () => {
    expect((await checkForUpdate({ currentVersion: "2.0.0", transport: metadata([release()]) })).available).toBe(false);
    expect((await checkForUpdate({ currentVersion: "1.0.0", transport: metadata([release()]) })).available).toBe(false);
  });
  it("explains unavailable private/draft or stable releases", async () => {
    await expect(checkForUpdate({ currentVersion: "0.1.0-beta.1", transport: metadata([release("1.0.0-beta.1")]) })).rejects.toThrow("Private repositories and draft releases");
    await expect(checkForUpdate({ currentVersion: "1.0.0", transport: metadata({ message: "Not Found" }) })).rejects.toThrow("invalid release metadata");
  });
  it("rejects invalid JSON and oversized metadata", async () => {
    await expect(checkForUpdate({ currentVersion: "1.0.0", transport: async () => Buffer.from("invalid") })).rejects.toThrow("invalid release metadata");
    await expect(checkForUpdate({ currentVersion: "1.0.0", transport: async () => Buffer.alloc(2097153) })).rejects.toThrow("size limit");
  });
  it("rejects missing/duplicate assets, foreign URLs, huge assets and mismatched release links", async () => {
    const missing = release(); missing.assets.pop();
    const duplicate = release(); duplicate.assets.push(duplicate.assets[0]!);
    const foreign = release(); foreign.assets[0]!.url = "https://127.0.0.1/evil";
    const huge = release(); huge.assets[0]!.size = 41 * 1024 * 1024;
    for (const entry of [missing, duplicate, foreign, huge, release("1.0.0", { html_url: "https://evil.invalid" })]) {
      await expect(checkForUpdate({ currentVersion: "0.1.0-beta.1", transport: metadata([entry]) })).rejects.toThrow();
    }
  });
  it("blocks redirects to HTTP, loopback, credentials and unrelated hosts", async () => {
    for (const location of ["http://release-assets.githubusercontent.com/file", "https://127.0.0.1/file", "https://user:secret@release-assets.githubusercontent.com/file", "https://example.org/file"]) {
      const spy = vi.spyOn(https, "get").mockImplementation(((_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
        const outgoing = new EventEmitter();
        queueMicrotask(() => {
          const incoming = new PassThrough();
          Object.assign(incoming, { statusCode: 302, headers: { location } });
          callback(incoming);
        });
        return outgoing;
      }) as typeof https.get);
      await expect(checkForUpdate({ currentVersion: "1.0.0" })).rejects.toThrow("untrusted host");
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    }
  });
  it("maps inaccessible and rate-limited GitHub API responses to actionable errors", async () => {
    for (const [statusCode, message] of [[404, "No public GitHub release"], [429, "Retry later"]] as const) {
      const spy = vi.spyOn(https, "get").mockImplementation(((_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
        const outgoing = new EventEmitter();
        queueMicrotask(() => { const incoming = new PassThrough(); Object.assign(incoming, { statusCode, headers: {} }); callback(incoming); });
        return outgoing;
      }) as typeof https.get);
      await expect(checkForUpdate({ currentVersion: "1.0.0" })).rejects.toThrow(message);
      spy.mockRestore();
    }
  });
});

describe("GitHub HTTPS transport", () => {
  it("downloads both verified assets through allowed GitHub release-assets redirects", async () => {
    const setup = await fixture();
    const bytes = await setup.transport(setup.result.archive.url, { maxBytes: setup.result.archive.size, accept: "application/octet-stream" });
    const sums = await setup.transport(setup.result.checksums.url, { maxBytes: setup.result.checksums.size, accept: "application/octet-stream" });
    const spy = vi.spyOn(https, "get").mockImplementation(((url: URL, _options: unknown, callback: (response: unknown) => void) => {
      const outgoing = new EventEmitter();
      queueMicrotask(() => {
        const incoming = new PassThrough();
        const id = url.pathname.endsWith("/1") ? "1" : "2";
        const redirected = url.hostname === "release-assets.githubusercontent.com";
        Object.assign(incoming, { statusCode: redirected ? 200 : 302, headers: redirected ? {} : { location: `https://release-assets.githubusercontent.com/${id}?signed=fixture` } });
        callback(incoming);
        if (redirected) incoming.end(id === "1" ? bytes : sums);
      });
      return outgoing;
    }) as typeof https.get);
    await installUpdate(setup.result, { ...setup, transport: undefined });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy.mock.calls.map(([url]) => (url as URL).hostname)).toEqual(["api.github.com", "release-assets.githubusercontent.com", "api.github.com", "release-assets.githubusercontent.com"]);
    for (const [, options] of spy.mock.calls) expect((options as { headers: object }).headers).not.toHaveProperty("Authorization");
    expect(setup.trash).toHaveBeenCalledOnce();
  });
  it("rejects malformed redirect URLs without an uncaught callback error", async () => {
    const spy = vi.spyOn(https, "get").mockImplementation(((_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
      const outgoing = new EventEmitter();
      queueMicrotask(() => {
        const incoming = new PassThrough();
        Object.assign(incoming, { statusCode: 302, headers: { location: "https://[invalid" } });
        callback(incoming);
      });
      return outgoing;
    }) as typeof https.get);
    await expect(checkForUpdate({ currentVersion: "1.0.0" })).rejects.toThrow("Invalid GitHub download redirect");
    expect(spy).toHaveBeenCalledOnce();
  });
  it("rejects an interrupted response stream", async () => {
    vi.spyOn(https, "get").mockImplementation(((_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
      const outgoing = new EventEmitter();
      queueMicrotask(() => {
        const incoming = new PassThrough();
        Object.assign(incoming, { statusCode: 200, headers: {} });
        callback(incoming);
        incoming.write("[");
        incoming.emit("aborted");
        incoming.destroy();
      });
      return outgoing;
    }) as typeof https.get);
    await expect(checkForUpdate({ currentVersion: "1.0.0" })).rejects.toThrow("download was interrupted");
  });
  it("caps streamed bytes even when Content-Length is absent", async () => {
    let incoming: PassThrough | undefined;
    vi.spyOn(https, "get").mockImplementation(((_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
      const outgoing = new EventEmitter();
      queueMicrotask(() => {
        incoming = new PassThrough();
        Object.assign(incoming, { statusCode: 200, headers: {} });
        callback(incoming);
        incoming.write(Buffer.alloc(1024 * 1024));
        incoming.write(Buffer.alloc(1024 * 1024 + 1));
      });
      return outgoing;
    }) as typeof https.get);
    await expect(checkForUpdate({ currentVersion: "1.0.0" })).rejects.toThrow("size limit");
    expect(incoming?.destroyed).toBe(true);
  });
  it("enforces one 30-second deadline across redirects and destroys the active request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requests: (EventEmitter & { destroy: ReturnType<typeof vi.fn> })[] = [];
    vi.spyOn(https, "get").mockImplementation(((_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
      const outgoing = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      outgoing.destroy.mockImplementation((error: Error) => outgoing.emit("error", error));
      requests.push(outgoing);
      if (requests.length === 1) setTimeout(() => {
        const incoming = new PassThrough();
        Object.assign(incoming, { statusCode: 302, headers: { location: "https://release-assets.githubusercontent.com/fixture" } });
        callback(incoming);
      }, 29_000);
      return outgoing;
    }) as unknown as typeof https.get);
    const result = expect(checkForUpdate({ currentVersion: "1.0.0" })).rejects.toThrow("request timed out");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(requests[0]!.destroy).not.toHaveBeenCalled();
    expect(requests[1]!.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("verified GitHub release installation", () => {
  it("refuses a renameable temporary ancestor before downloads or npm execution", async () => {
    const setup = await fixture();
    const parent = path.join(setup.directory, "unsafe-temp");
    await fs.mkdir(parent, { mode: 0o777 });
    await fs.chmod(parent, 0o777);
    vi.stubEnv("TMPDIR", parent);
    vi.mocked(setup.transport).mockClear();
    await expect(installUpdate(setup.result, { ...setup,
      createTemp: async () => fs.mkdtemp(path.join(parent, "ai-cleaner-update-")) })).rejects.toThrow(/writable|staging|temporary/i);
    expect(setup.run).not.toHaveBeenCalled();
    expect(setup.transport).not.toHaveBeenCalled();
  });

  it("refuses a stage that is readable by other users", async () => {
    const setup = await fixture();
    const createTemp = async () => {
      const stage = await setup.createTemp();
      await fs.chmod(stage, 0o755);
      return stage;
    };
    await expect(installUpdate(setup.result, { ...setup, createTemp })).rejects.toThrow(/staging/);
    expect(setup.run.mock.calls.some(([args]) => args[0] === "install")).toBe(false);
  });

  it("does not pass inherited credentials or loader settings to the shared Trash runner", async () => {
    const setup = await fixture();
    const target = path.join(setup.directory, "trash-me");
    await fs.mkdir(target);
    vi.stubEnv("GH_TOKEN", "synthetic-secret");
    vi.stubEnv("DYLD_PRINT_LIBRARIES", "1");
    await moveToSystemTrash([target], new Map([[target, snapshotClaimIdentity(target)]]));
    const cleanup = executions.find(({ file }) => file.endsWith("/vendor/macos-trash"));
    expect(cleanup?.env).toBeDefined();
    expect(cleanup?.env).not.toHaveProperty("GH_TOKEN");
    expect(cleanup?.env).not.toHaveProperty("DYLD_PRINT_LIBRARIES");
  });
  it("does not pass inherited credentials or loader settings to update cleanup", async () => {
    const setup = await fixture();
    vi.stubEnv("GH_TOKEN", "synthetic-secret");
    vi.stubEnv("DYLD_PRINT_LIBRARIES", "1");
    await installUpdate(setup.result, { ...setup, trash: undefined });
    const cleanup = executions.find(({ file }) => file.endsWith("/trash"));
    expect(cleanup?.env).toBeDefined();
    expect(cleanup?.env).not.toHaveProperty("GH_TOKEN");
    expect(cleanup?.env).not.toHaveProperty("DYLD_PRINT_LIBRARIES");
  });
  it("rejects writable npm code loaded by a safe entrypoint before executing it", async () => {
    const setup = await fixture();
    const npm = path.join(setup.globalRoot, "npm");
    await fixtureTrash(npm);
    await fs.mkdir(path.join(npm, "bin"), { recursive: true });
    await fs.mkdir(path.join(npm, "lib"));
    await fs.writeFile(path.join(npm, "bin", "npm-cli.js"), "require('../lib/cli.cjs');");
    const marker = path.join(setup.directory, "executed");
    const sibling = path.join(npm, "lib", "cli.cjs");
    await fs.writeFile(sibling, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); console.log('unexpected');`);
    await fs.chmod(sibling, 0o666);
    await expect(installUpdate(setup.result, { ...setup, run: undefined })).rejects.toThrow("Cannot bind a trusted npm");
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("ignores PATH npm and node replacements during a real offline update", async () => {
    const setup = await fixture();
    const bin = path.join(setup.directory, "bin");
    await fs.mkdir(bin);
    const marker = path.join(setup.directory, "executed");
    for (const tool of ["npm", "node"]) {
      await fs.writeFile(path.join(bin, tool), `#!/bin/sh\nprintf executed > '${marker}'\nexit 97\n`, { mode: 0o700 });
    }
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("npm_config_prefix", setup.prefix);
    const loader = path.join(setup.directory, "loader.cjs");
    await fs.writeFile(loader, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loader');`);
    vi.stubEnv("NODE_OPTIONS", `--require=${loader}`);
    vi.stubEnv("NODE_PATH", bin);
    vi.stubEnv("GH_TOKEN", "synthetic-secret");
    await installUpdate(setup.result, { ...setup, run: undefined });
    expect(JSON.parse(await fs.readFile(path.join(setup.packageRoot, "package.json"), "utf8")).version).toBe("1.0.0");
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
  it("verifies a local archive and installs only into the owning prefix, offline without lifecycle scripts", async () => {
    const setup = await fixture();
    vi.stubEnv("npm_config_registry", "https://untrusted.invalid");
    vi.stubEnv("GH_TOKEN", "synthetic-secret");
    await installUpdate(setup.result, setup);
    const install = setup.run.mock.calls.find(([args]) => args[0] === "install")!;
    expect(install[0]).toEqual(["install", "--global", "--prefix", setup.prefix, "--ignore-scripts", "--offline", "--engine-strict", "--no-audit", "--no-fund", "--allow-file=all", "--cache", expect.stringMatching(/ai-cleaner-update-.*\/npm-cache$/), "--", expect.stringMatching(/ai-cleaner-update-.*\/ai-cli-cleaner-1\.0\.0\.tgz$/)]);
    expect(install[1]?.env.npm_config_registry).toBeUndefined();
    expect(install[1]?.env.npm_config_userconfig).not.toBe(install[1]?.env.npm_config_globalconfig);
    for (const [, options] of setup.run.mock.calls) {
      expect(options?.env.GH_TOKEN).toBeUndefined();
      expect(options?.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    }
    expect(setup.trash).toHaveBeenCalledOnce();
  });
  it("refuses root, sudo, same-version and downgrade updates before launching npm", async () => {
    const setup = await fixture();
    await expect(installUpdate(setup.result, { ...setup, uid: 0 })).rejects.toThrow("without sudo");
    vi.stubEnv("SUDO_UID", "501");
    await expect(installUpdate(setup.result, setup)).rejects.toThrow("without sudo");
    vi.unstubAllEnvs();
    for (const latestVersion of [setup.result.currentVersion, "0.0.1"]) await expect(installUpdate({ ...setup.result, latestVersion }, setup)).rejects.toThrow("reinstall or downgrade");
    expect(setup.run).not.toHaveBeenCalled();
  });
  it("refuses a broken npm installation in the owning prefix without falling back to PATH", async () => {
    const setup = await fixture();
    await fixtureTrash(path.join(setup.globalRoot, "npm"));
    await fs.mkdir(path.join(setup.globalRoot, "npm"));
    await expect(installUpdate(setup.result, { ...setup, run: undefined })).rejects.toThrow("Cannot bind a trusted npm");
    expect(setup.transport).toHaveBeenCalledTimes(1);
  });
  it("refuses source checkouts and changed installed versions", async () => {
    const setup = await fixture();
    await fs.mkdir(path.join(setup.packageRoot, ".git"));
    await expect(installUpdate(setup.result, setup)).rejects.toThrow("Source checkouts");
    const changed = await fixture();
    await fs.writeFile(path.join(changed.packageRoot, "package.json"), JSON.stringify({ name: "ai-cli-cleaner", version: "0.1.0-beta.2" }));
    await expect(installUpdate(changed.result, changed)).rejects.toThrow("installed package changed");
    expect(setup.run).not.toHaveBeenCalled();
  });
  it("refuses npm link and another npm global prefix", async () => {
    const setup = await fixture();
    const linked = path.join(setup.directory, "linked");
    await fs.symlink(setup.packageRoot, linked);
    await expect(installUpdate(setup.result, { ...setup, packageRoot: linked })).rejects.toThrow("npm link");
    const run = vi.fn(async (args: string[]) => args[0] === "prefix" ? setup.directory : setup.globalRoot);
    await expect(installUpdate(setup.result, { ...setup, run })).rejects.toThrow("active npm global prefix");
    expect(run.mock.calls.some(([args]) => args[0] === "install")).toBe(false);
  });
  it("refuses unsupported npm before downloading assets", async () => {
    const setup = await fixture();
    const run = vi.fn(async (args: string[]) => args[0] === "prefix" ? setup.prefix : args[0] === "root" ? setup.globalRoot : "11.0.0");
    await expect(installUpdate(setup.result, { ...setup, run })).rejects.toThrow("npm 12");
    expect(setup.transport).toHaveBeenCalledTimes(1);
  });
  it("rejects corrupt archives, incorrect package names and version substitution", async () => {
    for (const [bytes, sum, error] of [[archive(), "0".repeat(64), "checksum verification"], [archive("2.0.0"), undefined, "name or version"], [archive("1.0.0", "other"), undefined, "name or version"], [Buffer.from("not gzip"), undefined, "Invalid or oversized"]] as const) {
      const setup = await fixture(bytes, sum);
      await expect(installUpdate(setup.result, setup)).rejects.toThrow(error);
      expect(setup.run.mock.calls.some(([args]) => args[0] === "install")).toBe(false);
      expect(setup.trash).not.toHaveBeenCalled();
    }
  });
  it("rejects duplicate checksum entries and forged asset endpoints", async () => {
    const setup = await fixture();
    const bad = { ...setup.result, checksums: { ...setup.result.checksums, url: "https://localhost/secret" } } as UpdateResult;
    await expect(installUpdate(bad, setup)).rejects.toThrow("Invalid GitHub release asset");
    const sums = Buffer.from(`${"0".repeat(64)}  ${setup.result.archive.name}\n`.repeat(2));
    const transport: UpdateTransport = async () => sums;
    await expect(installUpdate({ ...setup.result, checksums: { ...setup.result.checksums, size: sums.length } }, { ...setup, transport })).rejects.toThrow("exactly one archive checksum");
  });
  it("installs a verified archive with real npm into an isolated global prefix", async () => {
    const setup = await fixture(archive("1.0.0", "ai-cli-cleaner", { engines: { node: ">=22", npm: ">=12 <13" } }));
    vi.stubEnv("npm_config_prefix", setup.prefix);
    await installUpdate(setup.result, { ...setup, run: undefined });
    expect(JSON.parse(await fs.readFile(path.join(setup.packageRoot, "package.json"), "utf8")).version).toBe("1.0.0");
    expect(setup.trash).toHaveBeenCalledOnce();
  }, 30_000);
  it("real npm rejects incompatible engines without replacing the installed package", async () => {
    const setup = await fixture(archive("1.0.0", "ai-cli-cleaner", { engines: { node: ">=999" } }));
    vi.stubEnv("npm_config_prefix", setup.prefix);
    await expect(installUpdate(setup.result, { ...setup, run: undefined })).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(setup.packageRoot, "package.json"), "utf8")).version).toBe("0.1.0-beta.1");
    expect(setup.trash).toHaveBeenCalledOnce();
  }, 30_000);
  it("does not report success when npm leaves the old version installed", async () => {
    const setup = await fixture();
    const run = vi.fn(async (args: string[]) => args[0] === "install" ? "no change" : setup.run(args));
    await expect(installUpdate(setup.result, { ...setup, run })).rejects.toThrow("expected package version");
    expect(setup.trash).toHaveBeenCalledOnce();
  });
  it("reports its owned directory when cleanup fails to move it", async () => {
    const setup = await fixture();
    const trash = vi.fn(async () => {});
    await expect(installUpdate(setup.result, { ...setup, trash })).rejects.toThrow(/Move this directory to Trash manually: .*ai-cleaner-update-/);
  });
  it("moves its owned staging directory to Trash even when npm installation fails", async () => {
    const setup = await fixture();
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "install") throw new Error("npm failed");
      return setup.run(args);
    });
    await expect(installUpdate(setup.result, { ...setup, run })).rejects.toThrow("npm failed");
    expect(setup.trash).toHaveBeenCalledOnce();
    await expect(fs.stat(setup.trash.mock.calls[0]![0][0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
