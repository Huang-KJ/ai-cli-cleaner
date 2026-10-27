import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CleanerManifest, PreservationGuard, ScanEntry } from "../cleaners/types.js";
import {
  containsPath,
  createPathWalkBudget,
  expandHome,
  getCanonicalPath,
  getPathSnapshot,
  getSQLiteBasePath,
  readDirectoryBounded,
  resolvePattern,
  SQLITE_SIDECAR_SUFFIXES
} from "./paths.js";
import { snapshotPreservedPath, validatePreservationGuards } from "./preservation.js";

export interface ScanOptions {
  home?: string;
}

export async function scanManifests(
  manifests: CleanerManifest[],
  options: ScanOptions = {}
): Promise<ScanEntry[]> {
  const home = options.home ?? homedir();
  const canonicalHome = await getCanonicalPath(home);
  const entries: ScanEntry[] = [];

  for (const manifest of manifests) {
    const preservedPaths = [...manifest.preservedPaths, ...(manifest.memoryDeletePatterns ?? []).flatMap(memoryPreservedPaths)].map((preservedPath) =>
      expandHome(preservedPath, home)
    );
    const canonicalPreservedPaths = await Promise.all(
      preservedPaths.map((preservedPath) => getCanonicalPath(preservedPath))
    );

    const patterns = [
      ...manifest.deletePatterns.map((pattern) => ({ pattern, dated: false, policy: undefined as string[] | undefined })),
      ...(manifest.datedDirectoryRoots ?? []).map((pattern) => ({ pattern, dated: true, policy: undefined as string[] | undefined })),
      ...(manifest.protectedChildRoots ?? []).map(({ root, childNames }) => ({ pattern: root, dated: false, policy: childNames }))
    ];
    for (const { pattern, dated, policy } of patterns) {
      const entryBase = {
        providerId: manifest.id,
        providerName: manifest.name,
        pattern
      };
      let resolvedPaths: string[];
      let preservation = new Map<string, PreservationGuard[]>();
      try {
        if (policy) preservation = await resolveProtectedChildren(pattern, policy, home, canonicalHome);
        resolvedPaths = policy ? [...preservation.keys()] : dated
          ? await resolveDatedDirectories(pattern, home, canonicalHome)
          : await resolvePattern(pattern, home);
      } catch (error) {
        entries.push({
          ...entryBase,
          path: expandHome(pattern, home),
          exists: false,
          sizeBytes: 0,
          error: toScanError(error)
        });
        continue;
      }

      for (const resolvedPath of resolvedPaths) {
        try {
          const canonicalResolvedPath = await getCanonicalPath(resolvedPath);
          if (!containsPath(home, resolvedPath) || !containsPath(canonicalHome, canonicalResolvedPath)) {
            throw new Error(`Refusing to inspect a path outside allowed roots: ${resolvedPath}`);
          }
          if (path.join(canonicalHome, path.relative(home, resolvedPath)) !== canonicalResolvedPath) {
            throw new Error(`Refusing to clean a redirected path: ${resolvedPath}`);
          }
          const overlappingPreservedPath = preservedPaths.find((preservedPath, index) =>
            pathsOverlap(resolvedPath, preservedPath) ||
            pathsOverlap(canonicalResolvedPath, canonicalPreservedPaths[index]!)
          );
          if (overlappingPreservedPath) {
            throw new Error(`Refusing to clean a path that contains preserved data: ${overlappingPreservedPath}`);
          }

          const snapshot = await getPathSnapshot(resolvedPath);
          const preservationGuards = preservation.get(resolvedPath);
          if (preservationGuards) await validatePreservationGuards(preservationGuards);
          const identity = snapshot?.identity;
          if (dated && identity && identity.kind !== "directory") {
            throw new Error(`Refusing to clean a dated path that is not a directory: ${resolvedPath}`);
          }
          const exists = snapshot !== undefined;
          const sizeBytes = snapshot?.sizeBytes ?? 0;

          entries.push({
            ...entryBase,
            path: resolvedPath,
            exists,
            sizeBytes,
            preservationGuards,
            identity: identity
              ? { ...identity, canonicalPath: canonicalResolvedPath }
              : undefined
          });
        } catch (error) {
          entries.push({
            ...entryBase,
            path: resolvedPath,
            exists: false,
            sizeBytes: 0,
            error: toScanError(error)
          });
        }
      }
    }
  }

  annotateSQLiteGroups(entries);

  return entries;
}

function memoryPreservedPaths(pattern: string): string[] {
  if (!pattern.includes("*")) return [pattern];
  const base = pattern.endsWith("*") ? pattern.slice(0, -1) : "";
  if (!base || getSQLiteBasePath(base) !== base) throw new Error("Unsupported memory preservation pattern.");
  return [base, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${base}${suffix}`)];
}

async function resolveProtectedChildren(
  root: string,
  names: string[],
  home: string,
  canonicalHome: string
): Promise<Map<string, PreservationGuard[]>> {
  if (!names.length || names.some((name) => !name || name === "." || name === ".." || /[/\\\x00]/.test(name))) {
    throw new Error("Invalid protected child name.");
  }
  const expanded = expandHome(root, home);
  const result = new Map<string, PreservationGuard[]>();
  const physicalDirectory = async (directory: string, optional = false): Promise<PreservationGuard | undefined> => {
    const guard = await snapshotPreservedPath(directory);
    if (!path.isAbsolute(directory) || !containsPath(home, directory) ||
        !containsPath(canonicalHome, guard.canonicalPath) ||
        guard.canonicalPath !== path.join(canonicalHome, path.relative(home, directory))) {
      throw new Error(`Refusing to clean a redirected protected storage path: ${directory}`);
    }
    if (!guard.identity && optional) return undefined;
    if (guard.identity?.kind !== "directory") throw new Error(`Protected storage path is not a physical directory: ${directory}`);
    return guard;
  };
  const rootGuard = await physicalDirectory(expanded, true);
  if (!rootGuard) return result;
  const parentGuard = await physicalDirectory(path.dirname(expanded));
  const rootGuards = [parentGuard!, rootGuard];
  const budget = createPathWalkBudget();
  for await (const project of readDirectoryBounded(expanded, budget)) {
    const projectPath = path.join(expanded, project.name);
    if (project.isSymbolicLink()) throw new Error(`Protected project storage is a symbolic link: ${projectPath}`);
    if (!project.isDirectory()) {
      result.set(projectPath, rootGuards);
      continue;
    }
    const projectGuard = await physicalDirectory(projectPath);
    const memoryGuards: PreservationGuard[] = [];
    for (const name of names) {
      const file = path.join(projectPath, name);
      const guard = await snapshotPreservedPath(file);
      if (guard.canonicalPath !== path.join(canonicalHome, path.relative(home, file)) ||
          (guard.identity && guard.identity.kind !== "directory")) {
        throw new Error(`Preserved memory is not a physical directory: ${file}`);
      }
      memoryGuards.push(guard);
    }
    const guards = [...rootGuards, projectGuard!, ...memoryGuards];
    for await (const child of readDirectoryBounded(projectPath, budget, 1)) {
      if (names.includes(child.name)) continue;
      const candidate = path.join(projectPath, child.name);
      if (child.isSymbolicLink()) throw new Error(`Protected project data is a symbolic link: ${candidate}`);
      result.set(candidate, guards);
    }
    await validatePreservationGuards(guards);
  }
  await validatePreservationGuards(rootGuards);
  return new Map([...result].sort(([first], [second]) => first.localeCompare(second)));
}

async function resolveDatedDirectories(root: string, home: string, canonicalHome: string): Promise<string[]> {
  const expanded = expandHome(root, home);
  const canonical = await getCanonicalPath(expanded);
  if (!path.isAbsolute(expanded) || !containsPath(home, expanded) || !containsPath(canonicalHome, canonical)) {
    throw new Error(`Refusing to inspect a path outside allowed roots: ${expanded}`);
  }
  // 列舉前先檢查根目錄與祖先，避免透過符號連結讀取其他位置。
  if (path.join(canonicalHome, path.relative(home, expanded)) !== canonical) {
    throw new Error(`Refusing to clean a redirected path: ${expanded}`);
  }
  try {
    const stat = await fs.lstat(expanded);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to clean a redirected path: ${expanded}`);
    if (!stat.isDirectory()) throw new Error(`Dated workspace root is not a directory: ${expanded}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const children = await fs.readdir(expanded, { withFileTypes: true });
  const matches: string[] = [];
  for (const child of children) {
    if (!isCalendarDate(child.name)) continue;
    const candidate = path.join(expanded, child.name);
    if (child.isSymbolicLink()) throw new Error(`Refusing to clean a dated symbolic link: ${candidate}`);
    if (child.isDirectory()) matches.push(candidate);
  }
  return matches.sort();
}

function isCalendarDate(name: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return false;
  const year = Number(name.slice(0, 4));
  const month = Number(name.slice(5, 7));
  const day = Number(name.slice(8, 10));
  if (year === 0 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

export function annotateSQLiteGroups(entries: ScanEntry[]): void {
  const groups = new Map<string, { basePath: string; entries: ScanEntry[] }>();

  for (const entry of entries) {
    const basePath = getSQLiteBasePath(entry.path);
    if (!basePath) continue;

    const key = `${entry.providerId}\0${basePath}`;
    const group = groups.get(key) ?? { basePath, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }

  for (const { basePath, entries: groupEntries } of groups.values()) {
    const members = [...new Set(
      groupEntries.filter((entry) => entry.exists && !entry.error).map((entry) => entry.path)
    )].sort();
    const complete = groupEntries.every((entry) => !entry.error);

    for (const entry of groupEntries) {
      entry.sqliteGroup = { basePath, members, complete };
    }
  }
}

function toScanError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function pathsOverlap(firstPath: string, secondPath: string): boolean {
  return containsPath(firstPath, secondPath) || containsPath(secondPath, firstPath);
}
