import { promises as fs } from "node:fs";
import { pathExists } from "../fs/paths.js";
import { atomicRewrite, type MetadataInventory } from "./metadata-safety.js";
import { isRecord } from "./metadata-values.js";

// 上限保留大型本機索引的空間，同時限制每次解析與保留資料的總工作量。
export const JSONL_LIMITS = { bytes: 64 * 1024 * 1024, lineBytes: 1024 * 1024, lines: 200_000 } as const;

export async function* readJsonlLines(file: string): AsyncGenerator<{ line: string; index: number }> {
  const handle = await fs.open(file, "r");
  try {
    if ((await handle.stat()).size > JSONL_LIMITS.bytes) throw resourceError(file);
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    let bytes = 0;
    let index = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > JSONL_LIMITS.bytes) throw resourceError(file);
      let offset = 0;
      for (let cursor = 0; cursor < bytesRead; cursor++) {
        if (chunk[cursor] !== 10) continue;
        if (pending.length + cursor - offset > JSONL_LIMITS.lineBytes || ++index > JSONL_LIMITS.lines) {
          throw resourceError(file);
        }
        const row = Buffer.concat([pending, chunk.subarray(offset, cursor)]);
        yield { line: row.toString("utf8").replace(/\r$/, ""), index };
        pending = Buffer.alloc(0);
        offset = cursor + 1;
      }
      if (pending.length + bytesRead - offset > JSONL_LIMITS.lineBytes) throw resourceError(file);
      pending = Buffer.concat([pending, chunk.subarray(offset, bytesRead)]);
    }
    if (pending.length > 0) {
      if (++index > JSONL_LIMITS.lines) throw resourceError(file);
      yield { line: pending.toString("utf8"), index };
    }
  } finally { await handle.close(); }
}

function resourceError(file: string): Error {
  return new Error(`JSONL resource limit exceeded; refusing incomplete metadata: ${file}`);
}

async function* jsonlRows(file: string, label: string): AsyncGenerator<{
  line: string;
  value: Record<string, unknown>;
}> {
  for await (const { index, line } of readJsonlLines(file)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid ${label} JSONL at line ${index}: ${file}`);
    }
    if (!isRecord(value)) throw new Error(`${label} JSONL line ${index} must be an object: ${file}`);
    yield { line, value };
  }
}

export async function validateJsonl(file: string | undefined, label: string): Promise<void> {
  if (!file || !(await pathExists(file))) return;
  for await (const _entry of jsonlRows(file, label)) { /* 逐列驗證，不保留解析結果。 */ }
}

export async function rewriteJsonl(
  file: string | undefined,
  label: string,
  keep: (value: Record<string, unknown>) => boolean,
  inventory?: MetadataInventory,
  markChanged?: () => void
): Promise<void> {
  if (!file || !(await pathExists(file))) return;
  let changed = false;
  for await (const { value } of jsonlRows(file, label)) {
    if (!keep(value)) changed = true;
  }
  // 保留原始內容列；實際移除資料時才套用既有空白列與尾端換行規則。
  if (changed) {
    async function* retained(): AsyncGenerator<string> {
      for await (const { line, value } of jsonlRows(file!, label)) {
        if (keep(value)) yield `${line}\n`;
      }
    }
    await atomicRewrite(file, retained(), inventory);
    markChanged?.();
  }
}
