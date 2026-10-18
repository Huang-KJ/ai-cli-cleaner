import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareClean } from "../src/cleaners/plan.js";
import type { ProviderId } from "../src/cleaners/types.js";

let home: string;
let moved: string[];
beforeEach(async () => {
  home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "bulk-delete-")));
  moved = [];
  await fs.mkdir(path.join(home, "test-trash"));
});
afterEach(async () => { await fixtureTrash(home, { recursive: true, force: true }); });

async function write(relative: string, text = "synthetic"): Promise<string> {
  const file = path.join(home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  return file;
}
async function trash(files: string[]): Promise<void> {
  for (const file of files) {
    const destination = path.join(home, "test-trash", `${moved.length}-${path.basename(file)}`);
    await fs.rename(file, destination);
    moved.push(file);
  }
}
const closed = async () => ({ supported: true, openPaths: [] as string[] });
const planFor = (targets: ProviderId[]) => prepareClean(targets, { home, trash, checkOpenPaths: closed });

describe("all-conversation deletion", () => {
  it("previews and clears dated Codex workspaces without requiring a .codex directory", async () => {
    const current = await write("Documents/Codex/2026-10-15/project/output.txt", "current workspace");
    const leap = await write("Documents/Codex/2024-02-29/results.txt", "leap workspace");
    const old = await write("Documents/Codex/2023-12-31/notes.txt", "old workspace");
    const empty = path.join(home, "Documents/Codex/2000-02-29");
    await fs.mkdir(empty);
    const kept = await write("Documents/Codex/projects/2026-10-15/notes.txt", "nested date");
    const invalid = await write("Documents/Codex/2023-02-29/notes.txt", "invalid date");
    const century = await write("Documents/Codex/1900-02-29/notes.txt", "invalid century leap day");
    const overflow = await write("Documents/Codex/2026-04-31/notes.txt", "invalid day");
    const malformed = await write("Documents/Codex/2026-1-15/notes.txt", "not YYYY-MM-DD");
    const dateFile = await write("Documents/Codex/2026-10-16", "date-shaped file");
    const outside = await write("Documents/2026-10-15/output.txt", "outside Codex");
    const plan = await planFor(["codex"]);

    expect(plan.entries.map((entry) => entry.path).sort()).toEqual([
      empty,
      path.join(home, "Documents/Codex/2023-12-31"),
      path.join(home, "Documents/Codex/2024-02-29"),
      path.join(home, "Documents/Codex/2026-10-15")
    ].sort());
    expect(moved).toEqual([]);
    expect(await fs.readFile(current, "utf8")).toBe("current workspace");
    await expect(fs.stat(path.join(home, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });

    const result = await plan.execute();

    expect(result.failures).toEqual([]);
    await expect(fs.stat(current)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(leap)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(old)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(empty)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(kept, "utf8")).toBe("nested date");
    expect(await fs.readFile(invalid, "utf8")).toBe("invalid date");
    expect(await fs.readFile(century, "utf8")).toBe("invalid century leap day");
    expect(await fs.readFile(overflow, "utf8")).toBe("invalid day");
    expect(await fs.readFile(malformed, "utf8")).toBe("not YYYY-MM-DD");
    expect(await fs.readFile(dateFile, "utf8")).toBe("date-shaped file");
    expect(await fs.readFile(outside, "utf8")).toBe("outside Codex");
    expect((await fs.stat(path.join(home, "Documents/Codex"))).isDirectory()).toBe(true);
    expect((await planFor(["codex"])).entries).toEqual([]);
  });

  it("ignores a missing dated workspace root and refuses a date directory added after empty preview", async () => {
    const plan = await planFor(["codex"]);
    expect(plan.entries).toEqual([]);
    const added = await write("Documents/Codex/2026-10-15/output.txt", "new workspace");

    await expect(plan.execute()).rejects.toThrow(/Cleanup data was added or removed after preview/);

    expect(moved).toEqual([]);
    expect(await fs.readFile(added, "utf8")).toBe("new workspace");
  });

  it("refuses a new date directory after preview before moving any provider", async () => {
    const existing = await write("Documents/Codex/2026-10-14/output.txt", "planned workspace");
    const other = await write(".copilot/session-state/one/events.jsonl", "planned conversation");
    const plan = await planFor(["codex", "copilot"]);
    const added = await write("Documents/Codex/2026-10-15/output.txt", "new workspace");

    await expect(plan.execute()).rejects.toThrow(/Cleanup data was added or removed after preview/);

    expect(moved).toEqual([]);
    expect(await fs.readFile(existing, "utf8")).toBe("planned workspace");
    expect(await fs.readFile(other, "utf8")).toBe("planned conversation");
    expect(await fs.readFile(added, "utf8")).toBe("new workspace");
  });

  it("refuses nested workspace changes after preview before moving any provider", async () => {
    const existing = await write("Documents/Codex/2026-10-15/project/output.txt", "planned workspace");
    const other = await write(".copilot/session-state/one/events.jsonl", "planned conversation");
    const plan = await planFor(["codex", "copilot"]);
    await fs.writeFile(existing, "changed workspace with a different size");

    await expect(plan.execute()).rejects.toThrow(/Path changed/);

    expect(moved).toEqual([]);
    expect(await fs.readFile(existing, "utf8")).toBe("changed workspace with a different size");
    expect(await fs.readFile(other, "utf8")).toBe("planned conversation");
  });

  it("refuses a nested workspace file added after preview before moving any provider", async () => {
    const existing = await write("Documents/Codex/2026-10-15/project/output.txt", "planned workspace");
    const other = await write(".copilot/session-state/one/events.jsonl", "planned conversation");
    const plan = await planFor(["codex", "copilot"]);
    const added = await write("Documents/Codex/2026-10-15/project/new/results.txt", "new nested content");

    await expect(plan.execute()).rejects.toThrow(/Path changed/);

    expect(moved).toEqual([]);
    expect(await fs.readFile(existing, "utf8")).toBe("planned workspace");
    expect(await fs.readFile(added, "utf8")).toBe("new nested content");
    expect(await fs.readFile(other, "utf8")).toBe("planned conversation");
  });

  it.each(["Documents/Codex", "Documents/Codex/2026-10-15"])(
    "refuses %s replaced by a symlink after preview before moving any provider",
    async (relative) => {
      const existing = await write("Documents/Codex/2026-10-15/project/output.txt", "planned workspace");
      const other = await write(".copilot/session-state/one/events.jsonl", "planned conversation");
      const replacement = await write("replacement-workspace/2026-10-15/project/output.txt", "keep replacement");
      const plan = await planFor(["codex", "copilot"]);
      const replaced = path.join(home, relative);
      const held = path.join(home, "held-workspace");
      await fs.rename(replaced, held);
      await fs.symlink(path.join(home, "replacement-workspace"), replaced);

      await expect(plan.execute()).rejects.toThrow(/redirected path|dated symbolic link/);

      expect(moved).toEqual([]);
      expect(await fs.readFile(path.join(held, path.relative(replaced, existing)), "utf8")).toBe("planned workspace");
      expect(await fs.readFile(replacement, "utf8")).toBe("keep replacement");
      expect(await fs.readFile(other, "utf8")).toBe("planned conversation");
    }
  );

  it.each(["Documents", "Documents/Codex"])("refuses a redirected dated workspace root through %s", async (relative) => {
    const kept = await write("held-workspaces/2026-10-15/output.txt", "keep workspace");
    const link = path.join(home, relative);
    await fs.mkdir(path.dirname(link), { recursive: true });
    const target = relative === "Documents" ? home : path.join(home, "held-workspaces");
    await fs.symlink(target, link);

    await expect(planFor(["codex"])).rejects.toThrow(/redirected path/);

    expect(moved).toEqual([]);
    expect(await fs.readFile(kept, "utf8")).toBe("keep workspace");
  });

  it("refuses a date-named symlink without following its contents", async () => {
    const kept = await write("held-workspace/output.txt", "keep workspace");
    await fs.mkdir(path.join(home, "Documents/Codex"), { recursive: true });
    await fs.symlink(path.dirname(kept), path.join(home, "Documents/Codex/2026-10-15"));

    await expect(planFor(["codex"])).rejects.toThrow(/symbolic link|redirected path/);

    expect(moved).toEqual([]);
    expect(await fs.readFile(kept, "utf8")).toBe("keep workspace");
  });

  it("refuses a file in place of the dated workspace root", async () => {
    const file = await write("Documents/Codex", "keep root file");

    await expect(planFor(["codex"])).rejects.toThrow(/directory/);

    expect(moved).toEqual([]);
    expect(await fs.readFile(file, "utf8")).toBe("keep root file");
  });

  it("refuses an open dated workspace before moving any provider", async () => {
    const file = await write("Documents/Codex/2026-10-15/project/output.txt", "open workspace");
    const other = await write(".copilot/session-state/one/events.jsonl", "planned conversation");
    await expect(prepareClean(["codex", "copilot"], {
      home, trash,
      checkOpenPaths: async (paths) => ({
        supported: true,
        openPaths: paths.includes(path.join(home, "Documents/Codex/2026-10-15")) ? [file] : []
      })
    })).rejects.toThrow(/Open files:/);

    expect(moved).toEqual([]);
    expect(await fs.readFile(file, "utf8")).toBe("open workspace");
    expect(await fs.readFile(other, "utf8")).toBe("planned conversation");
  });

  it("prepares without moving data, then clears the selected provider and preserves the others and settings", async () => {
    const selected = await write(".copilot/session-state/one/events.jsonl");
    const second = await write(".copilot/session-state/two/events.jsonl");
    const other = await write(".grok/sessions/group/kept/summary.json");
    const config = await write(".copilot/config.json", "keep settings");
    const cache = await write("Library/Caches/copilot/cache", "keep cache");
    const workspace = await write("Documents/Codex/2026-10-15/kept.txt", "keep Codex workspace");
    const plan = await planFor(["copilot"]);
    expect(moved).toEqual([]);
    expect(await fs.readFile(selected, "utf8")).toBe("synthetic");
    const result = await plan.execute();
    expect(result.failures).toEqual([]);
    await expect(fs.stat(selected)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(second)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(other, "utf8")).toBe("synthetic");
    expect(await fs.readFile(config, "utf8")).toBe("keep settings");
    expect(await fs.readFile(cache, "utf8")).toBe("keep cache");
    expect(await fs.readFile(workspace, "utf8")).toBe("keep Codex workspace");
    expect((await planFor(["copilot"])).entries).toEqual([]);
    await expect(plan.execute()).rejects.toThrow(/already been executed/);
  });

  it("clears known stores across all five providers while preserving credentials", async () => {
    await write(".codex/sessions/orphan.jsonl", JSON.stringify({ type: "session_meta", payload: { id: "orphan" } }) + "\n");
    await write(".copilot/session-state/orphan/events.jsonl");
    await write(".gemini/antigravity-cli/cache/lastConversations.json", "[]");
    await write(".gemini/antigravity-ide/brain/orphan/artifact.md");
    await write(".local/share/opencode/storage/session/orphan.json");
    await write(".grok/sessions/group/orphan/summary.json");
    const auth = await write(".codex/auth.json", "credentials");
    const workspace = await write("Documents/Codex/2026-10-15/output.txt", "dated workspace");
    const targets: ProviderId[] = ["codex", "copilot", "antigravity", "opencode", "grok"];
    const result = await (await planFor(targets)).execute();
    expect(result.failures).toEqual([]);
    expect(new Set(result.deleted.map((entry) => entry.providerId))).toEqual(new Set(targets));
    expect(await fs.readFile(auth, "utf8")).toBe("credentials");
    await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    const remaining = await planFor(targets);
    expect(remaining.entries).toEqual([]);
    expect(remaining.operations).toEqual([]);
  });

  it("clears known OpenCode legacy conversation trees while preserving persistent storage", async () => {
    const conversationFiles = [
      "session/project/selected.json", "message/selected/message.json", "part/message/part.json",
      "todo/selected.json", "session_share/selected.json", "session_diff/selected.json"
    ];
    const conversations = await Promise.all(conversationFiles.map((file) =>
      write(`.local/share/opencode/storage/${file}`, "synthetic conversation")));
    const permission = await write(".local/share/opencode/storage/permission/project.json", "permanent permission");
    const project = await write(".local/share/opencode/storage/project/project.json", "permanent project");
    const unknown = await write(".local/share/opencode/storage/custom/value.json", "unclassified data");
    const auth = await write(".local/share/opencode/auth.json", "synthetic credential");

    const result = await (await planFor(["opencode"])).execute();

    expect(result.failures).toEqual([]);
    for (const file of conversations) await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(permission, "utf8")).toBe("permanent permission");
    expect(await fs.readFile(project, "utf8")).toBe("permanent project");
    expect(await fs.readFile(unknown, "utf8")).toBe("unclassified data");
    expect(await fs.readFile(auth, "utf8")).toBe("synthetic credential");
    expect((await planFor(["opencode"])).entries).toEqual([]);
  });

  it("clears Codex local index references while retaining remote references and settings", async () => {
    const state = await write(".codex/state_5.sqlite", "");
    const db = new DatabaseSync(state);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT); INSERT INTO threads VALUES ('local-id', '/fixture/rollout.jsonl');");
    db.close();
    const global = await write(".codex/.codex-global-state.json", JSON.stringify({
      "pinned-thread-ids": ["local-id", "remote-id"], theme: "dark"
    }));
    const result = await (await planFor(["codex"])).execute();
    expect(result.failures).toEqual([]);
    expect(JSON.parse(await fs.readFile(global, "utf8"))).toEqual({
      "pinned-thread-ids": ["remote-id"], theme: "dark"
    });
    expect(moved.some((file) => file.includes("/.ai-cli-cleaner/recovery/"))).toBe(true);
  });

  it("ignores an unrelated JSONL file named after an old bulk sentinel", async () => {
    const index = await write(".codex/.ai-cli-cleaner-bulk-no-index.jsonl", "unrelated index");
    const rollout = await write(".codex/sessions/selected.jsonl",
      JSON.stringify({ type: "session_meta", payload: { id: "selected" } }) + "\n");
    const global = await write(".codex/.codex-global-state.json", JSON.stringify({
      "pinned-thread-ids": ["selected", "remote"], theme: "dark"
    }));
    const result = await (await planFor(["codex"])).execute();
    expect(result.failures).toEqual([]);
    await expect(fs.stat(rollout)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await fs.readFile(global, "utf8"))).toEqual({
      "pinned-thread-ids": ["remote"], theme: "dark"
    });
    expect(await fs.readFile(index, "utf8")).toBe("unrelated index");
    expect(moved).not.toContain(index);
  });

  it("refuses an unknown database even when its name matches a retired bulk sentinel", async () => {
    const state = await write(".codex/.ai-cli-cleaner-bulk-no-state.sqlite", "unrelated database");
    const rollout = await write(".codex/sessions/selected.jsonl",
      JSON.stringify({ type: "session_meta", payload: { id: "selected" } }) + "\n");
    const global = await write(".codex/.codex-global-state.json", JSON.stringify({
      "pinned-thread-ids": ["selected", "remote"], theme: "dark"
    }));
    await expect(planFor(["codex"])).rejects.toThrow(/Unsupported Codex conversation databases detected/);
    expect(moved).toEqual([]);
    expect(await fs.readFile(state, "utf8")).toBe("unrelated database");
    expect(JSON.parse(await fs.readFile(rollout, "utf8")).payload.id).toBe("selected");
    expect(JSON.parse(await fs.readFile(global, "utf8"))).toEqual({
      "pinned-thread-ids": ["selected", "remote"], theme: "dark"
    });
  });

  it("blocks every write if any target is open or lsof is unavailable", async () => {
    const file = await write(".copilot/session-state/one/events.jsonl");
    for (const check of [{ supported: true, openPaths: [file] }, { supported: false, openPaths: [] }]) {
      const expectedError = check.supported
        ? /Quit the relevant agents completely, or add --force-stop.*Open files:/
        : /Cannot check open-file status; ensure lsof is available/;
      await expect(prepareClean(["copilot"], { home, trash, checkOpenPaths: async () => check })).rejects.toThrow(expectedError);
    }
    expect(moved).toEqual([]);
    expect(await fs.readFile(file, "utf8")).toBe("synthetic");
  });

  it("rechecks occupancy after confirmation and before moving files", async () => {
    const file = await write(".copilot/session-state/one/events.jsonl");
    const check = vi.fn().mockResolvedValueOnce({ supported: true, openPaths: [] })
      .mockResolvedValue({ supported: true, openPaths: [file] });
    const plan = await prepareClean(["copilot"], { home, trash, checkOpenPaths: check });
    await expect(plan.execute()).rejects.toThrow(/Quit the relevant agents completely, or add --force-stop.*Open files:/);
    expect(moved).toEqual([]);
  });

  it("rejects changes made after the displayed plan before moving any provider", async () => {
    await write(".copilot/session-state/one/events.jsonl");
    const plan = await planFor(["copilot", "grok"]);
    await write(".copilot/session-state/new/events.jsonl");
    await expect(plan.execute()).rejects.toThrow("Path changed");
    expect(moved).toEqual([]);
  });

  it.each([".copilot/session-store.db", ".copilot/command-history-state.json"])(
    "refuses a previously missing %s before moving any planned data",
    async (relative) => {
      const existing = await write(".copilot/session-state/one/events.jsonl", "planned data");
      const plan = await planFor(["copilot"]);
      const added = await write(relative, "new data");

      await expect(plan.execute()).rejects.toThrow(/Cleanup data was added or removed after preview/);

      expect(moved).toEqual([]);
      expect(await fs.readFile(existing, "utf8")).toBe("planned data");
      expect(await fs.readFile(added, "utf8")).toBe("new data");
    }
  );

  it("refuses new data when the original plan was empty", async () => {
    const plan = await planFor(["copilot"]);
    expect(plan.entries).toEqual([]);
    const added = await write(".copilot/session-state/new/events.jsonl", "new data");

    await expect(plan.execute()).rejects.toThrow(/Cleanup data was added or removed after preview/);

    expect(moved).toEqual([]);
    expect(await fs.readFile(added, "utf8")).toBe("new data");
  });

  it("refuses a disappeared planned path before moving another provider", async () => {
    const existing = await write(".copilot/session-state/one/events.jsonl", "keep planned data");
    const missing = await write(".grok/active_sessions.json", "disappearing data");
    const plan = await planFor(["copilot", "grok"]);
    await fs.rename(missing, path.join(home, "held-index.json"));

    await expect(plan.execute()).rejects.toThrow(/Cleanup data was added or removed after preview/);

    expect(moved).toEqual([]);
    expect(await fs.readFile(existing, "utf8")).toBe("keep planned data");
  });

  it("does not silently report success for unknown Codex database versions", async () => {
    await write(".codex/state_6.sqlite");
    await expect(planFor(["codex"])).rejects.toThrow(/Unsupported Codex conversation databases detected/);
    expect(moved).toEqual([]);
  });

  it("blocks a new unknown database created while the confirmation is displayed", async () => {
    await write(".codex/history.jsonl", '{"session_id":"old","text":"old"}\n');
    const plan = await planFor(["codex"]);
    await write(".codex/state_6.sqlite");
    await expect(plan.execute()).rejects.toThrow(/Unsupported Codex conversation databases detected/);
    expect(moved).toEqual([]);
  });

  it("refuses unsafe scan paths before making a partial deletion", async () => {
    await write(".grok/config.toml", "keep");
    await fs.symlink(path.join(home, ".grok"), path.join(home, ".grok", "sessions"));
    await expect(planFor(["grok"])).rejects.toThrow("redirected path");
    expect(moved).toEqual([]);
  });

  it("refuses an in-home provider symlink that redirects deletion into another provider", async () => {
    const kept = await write(".codex/sessions/keep.jsonl", "keep");
    await fs.symlink(path.join(home, ".codex"), path.join(home, ".grok"));
    await expect(planFor(["grok"])).rejects.toThrow("redirected path");
    expect(await fs.readFile(kept, "utf8")).toBe("keep");
    expect(moved).toEqual([]);
  });

  it("reports a no-op Trash helper as a failure", async () => {
    await write(".copilot/session-state/one/events.jsonl");
    const noOp = vi.fn(async () => undefined);
    const plan = await prepareClean(["copilot"], { home, trash: noOp, checkOpenPaths: closed });
    const result = await plan.execute();
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toContain("Original path still exists after the Trash operation");
  });
});
