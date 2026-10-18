import { execFile } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

declare module "vitest" {
  interface ProvidedContext {
    fixtureTrash: string;
  }
}

interface FixtureSink {
  path: string;
  device: number;
  inode: number;
}

const temporaryRoot = realpathSync(tmpdir());
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const executeFile = promisify(execFile);
const native = createRequire(import.meta.url)(path.join(projectRoot, "lib/native-helper.cjs")) as {
  verifyNativeArtifact(root: string): string;
};

function inspectSink(directory: string): FixtureSink {
  if (!path.isAbsolute(directory)) throw new Error(`Fixture Trash directory must be absolute: ${directory}`);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Fixture Trash directory must be a real directory: ${directory}`);
  }
  const canonical = realpathSync(directory);
  if (canonical === temporaryRoot ||
      path.dirname(canonical) !== temporaryRoot || !path.basename(canonical).startsWith("ai-cleaner-fixture-trash-")) {
    throw new Error(`Fixture Trash directory must be a physical tmpdir child with the ai-cleaner-fixture-trash- prefix: ${directory}`);
  }
  return { path: canonical, device: info.dev, inode: info.ino };
}

function assertOwnedSinkUnchanged(sink: FixtureSink): void {
  const info = lstatSync(sink.path);
  const canonical = realpathSync(sink.path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== sink.device || info.ino !== sink.inode ||
      canonical !== sink.path || canonical === temporaryRoot || path.dirname(canonical) !== temporaryRoot ||
      !path.basename(canonical).startsWith("ai-cleaner-fixture-trash-")) {
    throw new Error(`Refusing to move a changed fixture Trash directory; inspect the original path: ${sink.path}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function setup(project: TestProject): (() => Promise<void>) | undefined {
  const configured = process.env.AI_CLEANER_FIXTURE_TRASH;
  let sink: FixtureSink;
  try {
    sink = inspectSink(configured ?? mkdtempSync(path.join(tmpdir(), "ai-cleaner-fixture-trash-")));
  } catch (error) {
    const location = configured ?? "the newly created temporary fixture sink";
    throw new Error(`Cannot initialize test fixture Trash directory (${location}): ${errorText(error)}`, { cause: error });
  }

  project.provide("fixtureTrash", sink.path);
  if (configured) return;

  process.stdout.write(`Synthetic test fixture sink: ${sink.path} (moved to macOS Trash after tests)\n`);
  return async () => {
    let binary: string;
    try {
      assertOwnedSinkUnchanged(sink);
      binary = native.verifyNativeArtifact(projectRoot);
    } catch (error) {
      throw new Error(`Test fixture Trash cleanup failed; inspect the original path ${sink.path}: ${errorText(error)}`, { cause: error });
    }
    try {
      await executeFile(binary, [sink.path], { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    } catch (error) {
      throw new Error(`Test fixture Trash cleanup failed; inspect the original path ${sink.path}: ${errorText(error)}`, { cause: error });
    }
    try {
      lstatSync(sink.path);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw new Error(`Test fixture Trash cleanup failed; inspect the original path ${sink.path}: ${errorText(error)}`, { cause: error });
    }
    throw new Error(`Native Trash returned successfully but left the fixture sink at ${sink.path}`);
  };
}
