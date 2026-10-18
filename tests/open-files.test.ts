import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findOpenPaths,
  getLsofFailureResult,
  parseLsofOutput
} from "../src/fs/open-files.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((dir) => fixtureTrash(dir, { recursive: true, force: true }))
  );
});

describe("open file detection", () => {
  it("recognizes an open file reported using its canonical path", async () => {
    const root = await fixtureTemp(path.join(tmpdir(), "ai-cli-cleaner-open-"));
    tempDirectories.push(root);
    await mkdir(path.join(root, "actual"), { recursive: true });
    await symlink(path.join(root, "actual"), path.join(root, "alias"));
    const file = path.join(root, "alias", "active.log");
    await writeFile(file, "active");
    const canonical = await realpath(file);
    const runner = vi.fn(async () => ({ supported: true, stdout: `n${canonical}\n` }));
    expect(await findOpenPaths([file], "darwin", runner)).toEqual({
      supported: true, openPaths: [file]
    });
  });

  it("parses literal path names and deduplicates lsof output", () => {
    const first = "/tmp/name with spaces/state.db";
    const second = "/tmp/state\0db";
    const output = `p100\nf1\nn${first}\nf2\nn${first}\nf3\nn/unrelated\nf4\nn${second}\n`;

    expect(parseLsofOutput(output)).toEqual([first, "/unrelated", second]);
  });

  it("reports unsupported platforms without invoking lsof", async () => {
    await expect(findOpenPaths(["/tmp/state.db"], "win32")).resolves.toEqual({
      supported: false,
      openPaths: []
    });
  });

  it("checks files directly and directory contents recursively", async () => {
    const root = await fixtureTemp(path.join(tmpdir(), "ai-cli-cleaner-open-"));
    const directory = path.join(root, "sessions");
    const file = path.join(root, "state.db");
    const openChild = path.join(directory, "active.jsonl");
    await mkdir(directory, { recursive: true });
    await writeFile(file, "db");
    await writeFile(openChild, "session");
    tempDirectories.push(root);
    const runner = vi.fn(async (args: string[]) => ({
      supported: true,
      stdout: args.includes("+D") ? `n${openChild}\n` : `n${file}\n`
    }));

    const result = await findOpenPaths([file, directory], "darwin", runner);

    expect(result.openPaths).toEqual([file, openChild]);
    expect(runner).toHaveBeenCalledWith(["-nP", "-Fn", "--", file]);
    expect(runner).toHaveBeenCalledWith(["-nP", "-Fn", "+D", directory]);
  });

  it("does not mistake lsof errors for an empty open-file result", () => {
    expect(
      getLsofFailureResult({ code: 1, stdout: "", stderr: "permission denied" })
    ).toEqual({ supported: false, stdout: "" });
    expect(
      getLsofFailureResult({ code: 1, stdout: "n/tmp/open.db\n", stderr: "" })
    ).toEqual({ supported: true, stdout: "n/tmp/open.db\n" });
    expect(getLsofFailureResult({ code: "ENOENT" })).toEqual({
      supported: false,
      stdout: ""
    });
  });

  it("narrows error objects without treating unknown exit codes or output types as text", () => {
    expect(getLsofFailureResult(null)).toBeUndefined();
    expect(getLsofFailureResult("failure")).toBeUndefined();
    expect(getLsofFailureResult({ code: "1" })).toBeUndefined();
    expect(getLsofFailureResult({ code: 2, stdout: "n/tmp/open.db\n" })).toBeUndefined();
    expect(getLsofFailureResult({ code: 1, stdout: Buffer.from("unrecognized"), stderr: 42 }))
      .toEqual({ supported: true, stdout: "" });
  });

  it("checks large file selections in bounded batches and retains late open results", async () => {
    const root = await fixtureTemp(path.join(tmpdir(), "ai-cli-cleaner-open-"));
    tempDirectories.push(root);
    const files = Array.from({ length: 65 }, (_, index) => path.join(root, `${index}.jsonl`));
    await Promise.all(files.map((file) => writeFile(file, "fixture")));
    const canonical = await realpath(files[64]!);
    const runner = vi.fn(async (args: string[]) => ({ supported: true,
      stdout: args.includes(files[64]!) ? `n${canonical}\n` : "" }));
    expect(await findOpenPaths(files, "darwin", runner)).toEqual({ supported: true, openPaths: [files[64]] });
    expect(runner.mock.calls.map(([args]) => args.length - 3)).toEqual([64, 1]);
    runner.mockImplementation(async (args) => ({ supported: !args.includes(files[64]!), stdout: "" }));
    expect(await findOpenPaths(files, "darwin", runner)).toEqual({ supported: false, openPaths: [] });
  });
});
