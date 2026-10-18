import { assertConversationId } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function antigravityHistoryId(value: unknown): string | undefined {
  if (!isRecord(value)) throw new Error("Antigravity history row must be an object.");
  const ids = ["conversationId", "conversation_id"].filter((key) => Object.hasOwn(value, key)).map((key) => value[key]);
  if (!ids.length) return undefined;
  for (const id of ids) {
    if (typeof id !== "string") throw new Error("Antigravity history conversation ID must be a string.");
    assertConversationId(id);
  }
  if (new Set(ids).size !== 1) throw new Error("Antigravity history conversation ID fields do not match.");
  return ids[0] as string;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return undefined;
}

export function asIso(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function firstDate(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asIso(record[key]);
    if (value) return value;
  }
  return undefined;
}

export function cleanTitle(title: string | undefined, fallback: string): string {
  const cleaned = title?.replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 64 ? `${cleaned.slice(0, 61)}...` : cleaned;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
