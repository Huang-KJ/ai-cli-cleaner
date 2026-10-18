import { fixtureTrashSync, fixtureTempSync } from "./helpers/fixture-trash.js";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { execFile, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const packagedFiles = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "docs/installation.md",
  "docs/recovery.md",
  "docs/compatibility.md",
  "docs/releasing.md",
  "package.json",
  "lib/native-helper.cjs",
  "lib/claim-helper.cjs",
  "lib/version.cjs",
  "vendor/macos-trash",
  "vendor/license",
  "vendor/provenance.json",
  "vendor/macos-claims",
  "vendor/claims-provenance.json",
  "native/claims.m",
  ...compiledFiles(join(root, "src"))
].sort();

describe("package and CI contract", () => {
  it("derives runtime files from regular TypeScript sources only", () => {
    const scratch = fixtureTempSync(join(tmpdir(), "ai-cli-cleaner-sources-"));
    const sources = join(scratch, "src");
    const outside = join(scratch, "outside");
    mkdirSync(join(sources, "nested"), { recursive: true });
    mkdirSync(outside);
    try {
      writeFileSync(join(sources, "index.ts"), "");
      writeFileSync(join(sources, "nested", "module.ts"), "");
      writeFileSync(join(sources, "module.d.ts"), "");
      writeFileSync(join(sources, "module.ts.map"), "");
      writeFileSync(join(sources, "module.js"), "");
      writeFileSync(join(outside, "linked.ts"), "");
      symlinkSync(outside, join(sources, "linked"));
      symlinkSync(join(outside, "linked.ts"), join(sources, "linked.ts"));
      expect(compiledFiles(sources).sort()).toEqual(["dist/index.js", "dist/nested/module.js"]);
    } finally { fixtureTrashSync(scratch, { recursive: true, force: true }); }
  });

  it("keeps package metadata, lockfile, and the CI Node matrix aligned", () => {
    expect(packageJson).toMatchObject({
      name: "ai-cli-cleaner",
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/",
        tag: "beta"
      },
      allowScripts: { fsevents: false },
      type: "module",
      bin: { "ai-cleaner": "./dist/index.js" },
      files: ["dist", "lib/native-helper.cjs", "lib/claim-helper.cjs", "native/claims.m", "lib/version.cjs", "vendor", "docs/*.md", "SECURITY.md", "CONTRIBUTING.md"],
      os: ["darwin"],
      engines: {
        npm: ">=12 <13"
      },
      scripts: {
        prebuild: "npm run clean",
        pretest: "npm run build",
        check: "npm run typecheck && npm test"
      }
    });
    expect(packageJson).not.toHaveProperty("private");
    expect(packageLock).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
      lockfileVersion: 3,
      packages: {
        "": {
          name: packageJson.name,
          version: packageJson.version,
          dependencies: packageJson.dependencies,
          bundleDependencies: Object.keys(packageJson.dependencies),
          devDependencies: packageJson.devDependencies,
          engines: packageJson.engines,
          os: packageJson.os
        }
      }
    });

    const nodeEngineRanges = [
      ...String(packageJson.engines.node).matchAll(/\^(\d+)\.\d+\.\d+/g)
    ];
    expect(nodeEngineRanges.length).toBeGreaterThan(0);
    const nodeMinimums = nodeEngineRanges.map((match) => match[0].slice(1));
    const supportedNodeMajors = nodeEngineRanges.map((match) => Number(match[1]));
    const expectedNodeVersions = [...new Set([
      ...nodeMinimums,
      ...supportedNodeMajors.map(String)
    ])].sort();

    const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toContain("os: [macos-26]");
    expect(workflow).toContain("runs-on: ${{ matrix.os }}");
    expect(workflow.match(/^ {4}steps:$/gm)).toHaveLength(1);
    const matrixNodeVersions = workflow
      .match(/^[ \t]*node-version:[ \t]*\[([^\]]+)\]/m)?.[1]
      ?.split(",")
      .map((version) => version.trim())
      .sort();
    expect(matrixNodeVersions).toEqual(expectedNodeVersions);
    const intelNodeVersion = workflow.match(
      /^[ \t]*- os: macos-26-intel\r?\n[ \t]+node-version: (\d+)$/m
    )?.[1];
    expect(intelNodeVersion).toMatch(/^\d+$/);
    expect(supportedNodeMajors).toContain(Number(intelNodeVersion));
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("timeout-minutes: 20");
    for (const action of ["actions/checkout", "actions/setup-node"]) {
      expect(workflow).toContain(`uses: ${action}@`);
    }
    const actionPins = [...workflow.matchAll(/^[ \t]*-[ \t]+uses: [^@\s]+@([^\s#]+)/gm)]
      .map((match) => match[1]);
    expect(actionPins).toHaveLength(2);
    for (const pin of actionPins) expect(pin).toMatch(/^[a-f0-9]{40}$/);
    expect(workflow).toContain("cache: npm");
    expect(workflow.match(/check-latest: true/g)).toHaveLength(1);
    const npmVersion = String(packageJson.packageManager).match(/^npm@(.+)$/)?.[1];
    expect(npmVersion).toBeDefined();
    const bootstrap = createRequire(import.meta.url)("../scripts/bootstrap-npm.cjs") as { version: string };
    expect(bootstrap.version).toBe(npmVersion);
    for (const name of ["ci.yml", "release.yml", "dependency-audit.yml"]) {
      const configured = readFileSync(join(root, ".github", "workflows", name), "utf8");
      expect(configured).toContain('node scripts/bootstrap-npm.cjs "$RUNNER_TEMP/ai-cleaner-npm"');
      expect(configured).toContain('echo "$RUNNER_TEMP/ai-cleaner-npm/node_modules/.bin" >> "$GITHUB_PATH"');
      expect(configured).not.toContain("npm install --prefix");
      expect(configured).not.toContain("npm install --global");
      expect(configured).toContain("persist-credentials: false");
    }
    const releaseWorkflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
    expect(releaseWorkflow).toContain("group: ${{ github.workflow }}-${{ github.ref }}");
    expect(releaseWorkflow).toContain("cancel-in-progress: false");
    expect(releaseWorkflow).toContain("timeout-minutes: 30");
    expect(releaseWorkflow).toContain("run: node scripts/draft-release.mjs");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow.match(/- run: npm ci/g)).toHaveLength(1);
    expect(workflow.match(/- run: npm run check/g)).toHaveLength(1);
  });

  it("installs the bundled release directly from a URL with npm 12 remote opt-in", async () => {
    const scratch = fixtureTempSync(join(tmpdir(), "ai-cli-cleaner-url-install-"));
    const prefix = join(scratch, "prefix");
    const home = join(scratch, "home");
    const cache = join(scratch, "cache");
    for (const directory of [prefix, home, cache]) mkdirSync(directory);
    const run = promisify(execFile);
    const environment = { ...process.env, HOME: home, npm_config_cache: cache, npm_config_offline: "false" };
    const requests: string[] = [];
    let archive: Buffer;
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/release.tgz") {
        response.writeHead(302, { Location: "/asset.tgz" });
        response.end();
      } else if (request.url === "/asset.tgz") {
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": archive.length });
        response.end(archive);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    try {
      const packed = await run("npm", ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", scratch],
        { cwd: root, env: environment, timeout: 30_000, killSignal: "SIGKILL" });
      archive = readFileSync(join(scratch, parsePackRecords(packed.stdout)[0]!.filename));
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture server did not start.");
      const base = `http://127.0.0.1:${address.port}`;
      await run("npm", ["install", "--global", "--prefix", prefix, "--allow-remote=all", "--ignore-scripts",
        "--no-audit", "--no-fund", "--registry", `${base}/registry`, `${base}/release.tgz`],
      { cwd: prefix, env: environment, timeout: 30_000, killSignal: "SIGKILL" });
      expect(requests).toContain("/release.tgz");
      expect(requests).toContain("/asset.tgz");
      expect(requests.every((request) => request === "/release.tgz" || request === "/asset.tgz")).toBe(true);
      const installed = await run(join(prefix, "bin", "ai-cleaner"), ["--version"],
        { cwd: prefix, env: environment, timeout: 10_000, killSignal: "SIGKILL" });
      expect(installed.stdout.trim()).toBe(packageJson.version);
      const installedRoot = join(prefix, "lib", "node_modules", "ai-cli-cleaner");
      for (const [packagePath, metadata] of getRuntimePackages()) {
        expect(JSON.parse(readFileSync(join(installedRoot, packagePath, "package.json"), "utf8")).version).toBe(metadata.version);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fixtureTrashSync(scratch, { recursive: true, force: true });
    }
  }, 80_000);

  // 離線封裝、安裝與 14 個 CLI 命令共用總預算，單一同步子程序也有上限。
  it("installs the actual tarball in isolation and runs its safe commands", () => {
    const deadline = performance.now() + 80_000;
    const childTimeout = () => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error("Isolated package verification exceeded its time budget.");
      return Math.min(30_000, remaining);
    };
    const scratch = fixtureTempSync(join(tmpdir(), "ai-cli-cleaner-install-"));
    const npmCache = join(scratch, "npm-cache");
    const packDirectory = join(scratch, "pack");
    const unpackDirectory = join(scratch, "unpacked");
    const prefix = join(scratch, "prefix");
    const prefixNodeModules = join(prefix, "lib", "node_modules");
    const fakeHome = join(scratch, "fake-home");
    const fakeTmp = join(scratch, "fake-tmp");
    for (const directory of [npmCache, packDirectory, unpackDirectory, prefixNodeModules]) {
      mkdirSync(directory, { recursive: true });
    }
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeTmp, { recursive: true });

    try {
      const packed = spawnSync(
        "npm",
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--offline",
          "--pack-destination",
          packDirectory
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: childTimeout(),
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            HOME: fakeHome,
            npm_config_cache: npmCache,
            npm_config_offline: "true"
          }
        }
      );
      expectSuccessful(packed);
      const packRecords = parsePackRecords(packed.stdout);
      expect(packRecords).toHaveLength(1);
      expect(packRecords[0]?.name).toBe(packageJson.name);
      expect(packRecords[0]?.files.map((file) => file.path).filter((file) => !file.startsWith("node_modules/")).sort()).toEqual(packagedFiles);
      const archive = join(packDirectory, packRecords[0]!.filename);
      expect(existsSync(archive)).toBe(true);

      const listing = spawnSync("tar", ["-tzf", archive], {
        encoding: "utf8",
        timeout: childTimeout(),
        killSignal: "SIGKILL"
      });
      expectSuccessful(listing);
      const archivedFiles = listing.stdout
        .trim()
        .split("\n")
        .filter((file) => file.startsWith("package/") && !file.endsWith("/"))
        .map((file) => file.slice("package/".length))
        .sort();
      expect(archivedFiles.filter((file) => !file.startsWith("node_modules/"))).toEqual(packagedFiles);
      const runtimePackages = getRuntimePackages();
      const archivedPackages = archivedFiles
        .filter((file) => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file))
        .map((file) => file.slice(0, -"/package.json".length));
      expect(archivedPackages.sort()).toEqual(runtimePackages.map(([packagePath]) => packagePath).sort());
      for (const file of archivedFiles.filter((entry) => entry.startsWith("node_modules/"))) {
        expect(runtimePackages.some(([packagePath]) => file.startsWith(`${packagePath}/`)), file).toBe(true);
      }

      const unpacked = spawnSync("tar", ["-xzf", archive, "-C", unpackDirectory], {
        encoding: "utf8",
        timeout: childTimeout(),
        killSignal: "SIGKILL"
      });
      expectSuccessful(unpacked);
      const extractedPackage = join(unpackDirectory, "package");
      const extractedMetadata = JSON.parse(
        readFileSync(join(extractedPackage, "package.json"), "utf8")
      ) as Record<string, any>;
      expect(extractedMetadata.name).toBe(packageJson.name);
      expect(extractedMetadata).not.toHaveProperty("private");
      expect(extractedMetadata.publishConfig).toEqual(packageJson.publishConfig);
      const { verifyNativeArtifact } = createRequire(import.meta.url)(join(extractedPackage, "lib", "native-helper.cjs"));
      expect(verifyNativeArtifact(extractedPackage)).toBe(realpathSync(join(extractedPackage, "vendor", "macos-trash")));
      const { verifyClaimArtifact } = createRequire(import.meta.url)(join(extractedPackage, "lib", "claim-helper.cjs"));
      expect(verifyClaimArtifact(extractedPackage)).toBe(realpathSync(join(extractedPackage, "vendor", "macos-claims")));

      for (const [packagePath, metadata] of runtimePackages) {
        const bundled = JSON.parse(readFileSync(join(extractedPackage, packagePath, "package.json"), "utf8"));
        expect(bundled.version, packagePath).toBe(metadata.version);
      }

      const installed = spawnSync(
        "npm",
        [
          "install",
          "--global",
          archive,
          "--offline",
          "--ignore-scripts",
          "--omit=dev",
          "--no-save",
          "--no-audit",
          "--no-fund",
          "--prefix",
          prefix
        ],
        {
          cwd: prefix,
          encoding: "utf8",
          timeout: childTimeout(),
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            HOME: fakeHome,
            npm_config_cache: npmCache,
            npm_config_offline: "true"
          }
        }
      );
      expectSuccessful(installed);
      const installedPackage = join(prefixNodeModules, String(packageJson.name));
      const installedClaims = createRequire(import.meta.url)(join(installedPackage, "lib", "claim-helper.cjs"));
      expect(installedClaims.verifyClaimArtifact(installedPackage)).toBe(realpathSync(join(installedPackage, "vendor", "macos-claims")));
      for (const [packagePath, metadata] of runtimePackages) {
        const dependency = JSON.parse(readFileSync(join(installedPackage, packagePath, "package.json"), "utf8"));
        expect(dependency.version, packagePath).toBe(metadata.version);
      }
      expect(existsSync(join(installedPackage, "node_modules", "vitest"))).toBe(false);
      expect(existsSync(join(installedPackage, "node_modules", "typescript"))).toBe(false);

      const installedExecutable = join(
        prefixNodeModules,
        String(packageJson.name),
        "dist",
        "index.js"
      );
      expect(existsSync(installedExecutable)).toBe(true);
      expect(readFileSync(installedExecutable, "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
      expect(statSync(installedExecutable).mode & 0o111).not.toBe(0);
      expect(existsSync(join(prefixNodeModules, "vitest"))).toBe(false);
      expect(existsSync(join(prefixNodeModules, "typescript"))).toBe(false);

      const isolatedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: fakeHome,
        CODEX_HOME: join(fakeHome, ".codex"),
        COPILOT_HOME: join(fakeHome, ".copilot"),
        XDG_CONFIG_HOME: join(fakeHome, ".config"),
        XDG_DATA_HOME: join(fakeHome, ".local", "share"),
        XDG_STATE_HOME: join(fakeHome, ".local", "state"),
        XDG_CACHE_HOME: join(fakeHome, ".cache"),
        TMPDIR: fakeTmp,
        NO_COLOR: "1"
      };
      delete isolatedEnv.NODE_PATH;

      const updateModule = spawnSync(process.execPath, ["--input-type=module", "-e",
        `const update = await import(${JSON.stringify(pathToFileURL(join(installedPackage, "dist", "update.js")).href)});\n` +
        "if (typeof update.checkForUpdate !== 'function' || typeof update.installUpdate !== 'function') throw new Error('Missing updater exports');\n" +
        "console.log(update.compareVersions('1.0.0', '1.0.0-beta.1'));"], {
        cwd: prefix, env: isolatedEnv, encoding: "utf8", timeout: childTimeout(), killSignal: "SIGKILL"
      });
      expectSuccessful(updateModule);
      expect(updateModule.stdout.trim()).toBe("1");
      expect(updateModule.stderr).toBe("");

      const help = runInstalledCli(installedExecutable, prefix, isolatedEnv, childTimeout(), "--help");
      expectSuccessful(help);
      expect(help.stdout).toContain("Usage: ai-cleaner");
      expect(help.stdout).toMatch(/^\s+clean\b/m);
      expect(help.stdout).toMatch(/^\s+conversations\b/m);
      expect(help.stdout).toMatch(/^\s+doctor\b/m);
      expect(help.stdout).toMatch(/^\s+recovery\b/m);
      expect(help.stdout).toMatch(/^\s+update\b/m);
      expect(help.stdout).not.toMatch(/\p{Script=Han}/u);
      expect(help.stdout).not.toMatch(/^\s+(?:scan|targets)\b/m);
      expect(help.stderr).toBe("");

      const conversationHelp = runInstalledCli(installedExecutable, prefix, isolatedEnv, childTimeout(), "conversations", "--help");
      expectSuccessful(conversationHelp);
      for (const option of ["--target", "--dry-run", "--force-stop", "--allow-running", "--timezone"]) {
        expect(conversationHelp.stdout).toContain(option);
      }
      for (const option of ["--search", "--workspace", "--older-than", "--min-size", "--force-open", "--yes"]) {
        expect(conversationHelp.stdout).not.toContain(option);
      }
      expect(conversationHelp.stderr).toBe("");

      const cleanHelp = runInstalledCli(installedExecutable, prefix, isolatedEnv, childTimeout(), "clean", "--help");
      expectSuccessful(cleanHelp);
      for (const option of ["--all", "--target", "--dry-run", "--yes", "--force-stop"]) {
        expect(cleanHelp.stdout).toContain(option);
      }
      for (const option of ["--cache-only", "--allow-partial", "--stop-processes", "--json"]) {
        expect(cleanHelp.stdout).not.toContain(option);
      }
      expect(cleanHelp.stdout).not.toMatch(/^\s+--force(?:\s|,)/m);
      expect(cleanHelp.stderr).toBe("");

      const updateHelp = runInstalledCli(installedExecutable, prefix, isolatedEnv, childTimeout(), "update", "--help");
      expectSuccessful(updateHelp);
      expect(updateHelp.stdout).toContain("--install");
      expect(updateHelp.stdout).toContain("--prerelease");
      expect(updateHelp.stdout).not.toMatch(/\p{Script=Han}/u);

      const emptyClean = runInstalledCli(installedExecutable, prefix, isolatedEnv, childTimeout(), "clean", "--all", "--dry-run", "--force-stop");
      expectSuccessful(emptyClean);
      expect(emptyClean.stdout).toContain("No conversation data to clean up");
      for (const target of ["codex", "copilot", "antigravity", "opencode", "grok"]) {
        const pipedConversations = runInstalledCli(installedExecutable, prefix, isolatedEnv, childTimeout(),
          "conversations", "--target", target, "--dry-run");
        expect(pipedConversations.error).toBeUndefined();
        expect(pipedConversations.signal).toBeNull();
        expect(pipedConversations.status).toBe(1);
        expect(pipedConversations.stdout).toBe("");
        expect(pipedConversations.stderr).toContain("Conversation selection requires an interactive terminal.");
      }

      const recoveryList = runInstalledCli(installedExecutable, prefix, isolatedEnv, childTimeout(), "recovery", "list", "--json");
      expectSuccessful(recoveryList);
      expect(JSON.parse(recoveryList.stdout)).toEqual([]);
      expect(existsSync(join(fakeHome, ".ai-cli-cleaner"))).toBe(false);

      const installedBin = join(prefix, "bin", "ai-cleaner");
      expect(existsSync(installedBin)).toBe(true);
      expect(statSync(installedBin).mode & 0o111).not.toBe(0);
      const version = spawnSync(installedBin, ["--version"], {
        cwd: prefix,
        encoding: "utf8",
        timeout: childTimeout(),
        killSignal: "SIGKILL",
        env: isolatedEnv
      });
      expectSuccessful(version);
      expect(version.stdout.trim()).toBe(packageJson.version);
      expect(version.stderr).toBe("");

      const missingTarget = runInstalledCli(installedExecutable, prefix, isolatedEnv, childTimeout(), "clean", "--dry-run");
      expect(missingTarget.status).toBe(1);
      expect(missingTarget.stdout).toBe("");
      expect(missingTarget.stderr).toContain("--all");
      expect(missingTarget.stderr).toContain("--target");

      const invalidTarget = runInstalledCli(
        installedExecutable,
        prefix,
        isolatedEnv,
        childTimeout(),
        "clean",
        "--target",
        "unsupported-target"
      );
      expect(invalidTarget.status).toBe(1);
      expect(invalidTarget.stdout).toBe("");
      expect(invalidTarget.stderr).toContain("unsupported-target");
    } finally {
      fixtureTrashSync(scratch, { recursive: true, force: true });
    }
  }, 90_000);
});

function compiledFiles(sourceRoot: string): string[] {
  const visit = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return visit(file);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) return [];
    const sourcePath = relative(sourceRoot, file).split(sep).join("/");
    return [`dist/${sourcePath.slice(0, -3)}.js`];
  });
  return visit(sourceRoot);
}

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as Record<string, any>;
}

interface NpmPackRecord {
  name: string;
  filename: string;
  files: Array<{ path: string }>;
}

function parsePackRecords(output: string): NpmPackRecord[] {
  const payload: unknown = JSON.parse(output);
  if (Array.isArray(payload)) {
    return payload as NpmPackRecord[];
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("npm pack returned an unexpected JSON shape.");
  }
  if ("name" in payload && "files" in payload) {
    return [payload as NpmPackRecord];
  }

  return Object.entries(payload).flatMap(([name, value]) => {
    const records = Array.isArray(value) ? value : [value];
    return records.map((record) => ({
      ...(record as Record<string, unknown>),
      name: typeof (record as Record<string, unknown>).name === "string"
        ? (record as Record<string, unknown>).name as string
        : name
    })) as NpmPackRecord[];
  });
}

function runInstalledCli(
  executablePath: string,
  prefix: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
  ...arguments_: string[]
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [executablePath, ...arguments_], {
    cwd: prefix,
    encoding: "utf8",
    env,
    timeout,
    killSignal: "SIGKILL"
  });
}

function getRuntimePackages(): Array<[string, Record<string, unknown>]> {
  const lockPackages = packageLock.packages as Record<string, Record<string, unknown>>;
  return Object.entries(lockPackages).filter(([packagePath, metadata]) =>
    packagePath.startsWith("node_modules/") &&
    metadata.inBundle === true &&
    metadata.dev !== true &&
    metadata.devOptional !== true &&
    metadata.link !== true &&
    typeof metadata.version === "string"
  );
}

function expectSuccessful(result: SpawnSyncReturns<string>): void {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
}
