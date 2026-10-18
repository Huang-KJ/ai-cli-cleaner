import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CleanerManifest, ScanEntry } from "../cleaners/types.js";
import {
  containsPath,
  expandHome,
  getCanonicalPath,
  getPathSnapshot,
  getSQLiteBasePath,
  resolvePattern
} from "./paths.js";

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
    const preservedPaths = manifest.preservedPaths.map((preservedPath) =>
      expandHome(preservedPath, home)
    );
    const canonicalPreservedPaths = await Promise.all(
      preservedPaths.map((preservedPath) => getCanonicalPath(preservedPath))
    );

    const patterns = [
      ...manifest.deletePatterns.map((pattern) => ({ pattern, dated: false })),
      ...(manifest.datedDirectoryRoots ?? []).map((pattern) => ({ pattern, dated: true }))
    ];
    for (const { pattern, dated } of patterns) {
      const entryBase = {
        providerId: manifest.id,
        providerName: manifest.name,
        pattern
      };
      let resolvedPaths: string[];
      try {
        resolvedPaths = dated
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
