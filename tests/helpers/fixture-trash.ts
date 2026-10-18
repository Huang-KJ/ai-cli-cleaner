import { promises as fs, lstatSync, mkdtempSync, realpathSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

interface FixtureRoot {
  path: string;
  canonical: string;
  device: number;
  inode: number;
}
interface CleanupOptions { force?: boolean; recursive?: boolean }
const roots: FixtureRoot[] = [];
let staging: string | undefined;
const temporaryRoot = realpathSync(tmpdir());

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function registerFixtureRoot(directory: string): string {
  const absolute = path.resolve(directory);
  const info = lstatSync(absolute);
  const canonical = realpathSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical === temporaryRoot ||
      path.dirname(canonical) !== temporaryRoot || !within(temporaryRoot, canonical)) {
    throw new Error("Test fixture root must be a physical child directory created for this run inside tmpdir.");
  }
  roots.push({ path: absolute, canonical, device: info.dev, inode: info.ino });
  return directory;
}

export function fixtureTempSync(prefix: string): string {
  if (realpathSync(path.dirname(path.resolve(prefix))) !== temporaryRoot) {
    throw new Error("Test fixture directories can only be created inside tmpdir.");
  }
  return registerFixtureRoot(mkdtempSync(prefix));
}

export async function fixtureTemp(prefix: string): Promise<string> {
  if (realpathSync(path.dirname(path.resolve(prefix))) !== temporaryRoot) {
    throw new Error("Test fixture directories can only be created inside tmpdir.");
  }
  return registerFixtureRoot(await fs.mkdtemp(prefix));
}

function fixtureStaging(): string {
  if (staging) return staging;
  const configured = process.env.AI_CLEANER_FIXTURE_TRASH;
  const directory = configured ?? mkdtempSync(path.join(tmpdir(), "ai-cleaner-fixture-trash-"));
  const info = lstatSync(directory);
  const canonical = realpathSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(canonical) !== temporaryRoot ||
      !path.basename(canonical).startsWith("ai-cleaner-fixture-trash-") ||
      roots.some((root) => within(root.canonical, canonical))) {
    throw new Error("Test fixture staging directory must be an isolated physical directory inside tmpdir.");
  }
  staging = canonical;
  if (!configured) process.stdout.write(`Synthetic test data staging directory: ${staging}\n`);
  return staging;
}

// 只搬移登記的合成資料，保留內容與 inode，供驗證後統一送垃圾桶。
export function fixtureTrashSync(source: string, options: CleanupOptions = {}): string | undefined {
  const absolute = path.resolve(source);
  const root = roots.find((entry) => within(entry.path, absolute) || within(entry.canonical, absolute));
  if (!path.isAbsolute(source) || !root) throw new Error("Refusing to move unregistered test fixture data.");
  try {
    const rootInfo = lstatSync(root.path);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() ||
        rootInfo.dev !== root.device || rootInfo.ino !== root.inode || realpathSync(root.path) !== root.canonical) {
      throw new Error("Test fixture root identity changed; refusing to move it.");
    }
    const info = lstatSync(absolute);
    const parent = realpathSync(path.dirname(absolute));
    const isRoot = absolute === root.path || absolute === root.canonical;
    if ((!isRoot && !within(root.canonical, parent)) ||
        (isRoot && (info.isSymbolicLink() || info.dev !== root.device || info.ino !== root.inode))) {
      throw new Error("Test path resolves through a symbolic link outside the registered temporary directory.");
    }
    const destination = path.join(fixtureStaging(), `${randomUUID()}-${path.basename(absolute)}`);
    renameSync(absolute, destination);
    return destination;
  } catch (error) {
    if (options.force && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function fixtureTrash(source: string, options: CleanupOptions = {}): Promise<string | undefined> {
  return fixtureTrashSync(source, options);
}
