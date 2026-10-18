import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rewriteJsonl, validateJsonl } from "../src/conversations/metadata-jsonl.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});

async function fixture(content: string) {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-jsonl-"));
  homes.push(home);
  const file = path.join(home, "history.jsonl");
  await fs.writeFile(file, content, { mode: 0o600 });
  return file;
}

describe.each(["Codex", "Antigravity"])("%s strict JSONL filtering", (label) => {
  it("preserves original bytes and file identity when no record is selected", async () => {
    const original = '\r\n  { "id": "retained", "number": 1e2 }\r\n \t\r\n{"id":"another"}';
    const file = await fixture(original);
    const before = await fs.stat(file);
    const rename = vi.spyOn(fs, "rename");
    const changed = vi.fn();
    await validateJsonl(file, label);
    await rewriteJsonl(file, label, () => true, undefined, changed);
    expect(await fs.readFile(file, "utf8")).toBe(original);
    const after = await fs.stat(file);
    expect([after.ino, after.mtimeMs, after.mode]).toEqual([before.ino, before.mtimeMs, before.mode]);
    expect(rename).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("retains unselected raw content with existing blank-line and trailing-newline normalization", async () => {
    const retained = '  { "number": 1e2, "id": "retained", "text": "\\u53f0" } \t';
    const file = await fixture(`\r\n{"id":"selected"}\r\n \t\r\n${retained}`);
    const changed = vi.fn();
    await rewriteJsonl(file, label, (row) => row.id !== "selected", undefined, changed);
    expect(await fs.readFile(file, "utf8")).toBe(`${retained}\n`);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it.each(["{broken", "[]", "null", "17"])("rejects %s after a selected record before writing", async (invalid) => {
    const original = `{"id":"selected"}\n \n${invalid}\n`;
    const file = await fixture(original);
    const rename = vi.spyOn(fs, "rename");
    const changed = vi.fn();
    const message = invalid === "{broken" ? `Invalid ${label} JSONL at line 3` : `${label} JSONL line 3 must be an object`;
    await expect(validateJsonl(file, label)).rejects.toThrow(message);
    await expect(rewriteJsonl(file, label, () => false, undefined, changed)).rejects.toThrow(message);
    expect(await fs.readFile(file, "utf8")).toBe(original);
    expect(rename).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("writes an empty file when every content record is selected", async () => {
    const file = await fixture('\n{"id":"selected"}\n \t\n');
    await rewriteJsonl(file, label, () => false);
    expect(await fs.readFile(file, "utf8")).toBe("");
  });
});
