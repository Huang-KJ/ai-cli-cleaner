import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { prepareClean } from "../src/cleaners/plan.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});
const closed = async () => ({ supported: true, openPaths: [] as string[] });

describe("Copilot session operation lock metadata", () => {
  it("does not offer the lock directory as a conversation and preserves it during selected deletion", async () => {
    const fixture = await makeFixture();
    const discovery = await discoverConversations(["copilot"], { home: fixture.home });
    expect(discovery.warnings).toEqual([]);
    expect(discovery.conversations.map((item) => item.id).sort()).toEqual([".retained-hidden", "selected"]);
    const selected = discovery.conversations.find((item) => item.id === "selected")!;
    const result = await deleteConversations([selected], {
      home: fixture.home, trash: fixture.move, checkOpenPaths: closed
    });
    expect(result.failures).toEqual([]);
    expect(result.deleted).toEqual([selected]);
    expect(await fs.readFile(fixture.lock, "utf8")).toBe("synthetic lock metadata");
    expect(await fs.readFile(fixture.retained, "utf8")).toBe("synthetic retained content");
  });

  it("moves shared operation locks with the complete stopped-provider session store during bulk cleanup", async () => {
    const fixture = await makeFixture();
    const plan = await prepareClean(["copilot"], {
      home: fixture.home, trash: fixture.move, checkOpenPaths: closed
    });
    expect(plan.entries.some((item) => item.path === path.dirname(path.dirname(fixture.lock)))).toBe(true);
    const result = await plan.execute();
    expect(result.failures).toEqual([]);
    await expect(fs.lstat(fixture.lock)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(fixture.config, "utf8")).toBe("synthetic settings");
  });
});

async function makeFixture() {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-copilot-lock-")));
  homes.push(home);
  const root = path.join(home, ".copilot");
  const lock = path.join(root, "session-state", ".session-operation-locks", "synthetic.lock");
  const selected = path.join(root, "session-state", "selected", "events.jsonl");
  const retained = path.join(root, "session-state", ".retained-hidden", "events.jsonl");
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.mkdir(path.dirname(selected));
  await fs.mkdir(path.dirname(retained));
  await fs.writeFile(lock, "synthetic lock metadata");
  await fs.writeFile(selected, "synthetic selected content");
  await fs.writeFile(retained, "synthetic retained content");
  const config = path.join(root, "config.json");
  await fs.writeFile(config, "synthetic settings");
  const database = new DatabaseSync(path.join(root, "session-store.db"));
  database.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('selected'), ('.retained-hidden')");
  database.close();
  let moved = 0;
  const move = async (files: string[]) => {
    const sink = path.join(home, "fixture-trash");
    await fs.mkdir(sink, { recursive: true });
    for (const source of files) await fs.rename(source, path.join(sink, String(moved++)));
  };
  return { home, lock, retained, config, move };
}
