import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";
import { deleteConversations } from "../src/conversations/delete.js";
import { getCodexMetadataPaths } from "../src/conversations/codex-paths.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true, recursive: true })));
});

describe("Codex artifact ownership", () => {
  it("disables both IDs when dotted snapshot names match a short and exact ID", async () => {
    const item = await collisionFixture();
    const discovery = await discoverConversations(["codex"], { home: item.home });
    const byId = new Map(discovery.conversations.map((conversation) => [conversation.id, conversation]));

    expect([...byId.keys()].sort()).toEqual(["alpha", "alpha.beta"]);
    expect(byId.get("alpha")?.disabledReason).toMatch(/ambiguous|multiple|ownership/i);
    expect(byId.get("alpha.beta")?.disabledReason).toMatch(/ambiguous|multiple|ownership/i);
  });

  it("refuses batch and manually re-enabled dry-run deletion while preserving metadata", async () => {
    const item = await collisionFixture();
    const discovery = await discoverConversations(["codex"], { home: item.home });
    const calls: string[][] = [];
    const trash = movingTrash(item.home, calls);
    const options = { home: item.home, checkOpenPaths: closed, trash };
    const batch = await deleteConversations(discovery.conversations, options);
    const manuallyEnabled = discovery.conversations.map((conversation) => ({
      ...conversation,
      disabledReason: undefined
    }));
    const dryRun = await deleteConversations(manuallyEnabled, { ...options, dryRun: true });

    expect(batch.deleted).toEqual([]);
    expect(batch.failures).toHaveLength(2);
    expect(dryRun.previewed).toEqual([]);
    expect(dryRun.failures).toHaveLength(2);
    expect(calls).toEqual([]);
    await expect(fs.readFile(item.paths.sessionIndex, "utf8")).resolves.toBe(item.indexText);
    await expect(fs.readFile(item.paths.historyFile!, "utf8")).resolves.toBe(item.historyText);
    for (const rollout of item.rollouts.values()) {
      await expect(fs.readFile(rollout.path, "utf8")).resolves.toBe(rollout.text);
    }
    const database = new DatabaseSync(item.paths.stateDatabase, { readOnly: true });
    try {
      expect(database.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual([
        { id: "alpha" }, { id: "alpha.beta" }
      ]);
      expect(database.prepare("SELECT thread_id FROM thread_items ORDER BY thread_id").all()).toEqual([
        { thread_id: "alpha" }, { thread_id: "alpha.beta" }
      ]);
    } finally { database.close(); }
  });

  it.each(["alpha", "alpha.beta"])("rejects a forged single selection for %s after disabledReason is removed", async (id) => {
    const item = await collisionFixture();
    const discovery = await discoverConversations(["codex"], { home: item.home });
    const selected = discovery.conversations.find((conversation) => conversation.id === id)!;
    const calls: string[][] = [];
    const forged = { ...selected, disabledReason: undefined };
    const result = await deleteConversations([forged], {
      home: item.home, checkOpenPaths: closed, trash: movingTrash(item.home, calls)
    });

    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(calls).toEqual([]);
    await expect(fs.readFile(path.join(item.root, "shell_snapshots", "alpha.beta"), "utf8"))
      .resolves.toContain("synthetic");
    await expect(fs.readFile(path.join(item.root, "visualizations", "alpha.beta.snapshot"), "utf8"))
      .resolves.toContain("synthetic");
  });

  it.each(["SQLite residual row", "rollout file"] as const)("includes a longer ID known only through a %s", async (source) => {
    const item = await makeHome(["alpha"]);
    const snapshot = path.join(item.root, "shell_snapshots", "alpha.beta");
    await fs.mkdir(path.dirname(snapshot), { recursive: true });
    await fs.writeFile(snapshot, "synthetic shared snapshot\n");
    if (source === "SQLite residual row") {
      const database = new DatabaseSync(item.paths.logsDatabase!);
      database.exec("CREATE TABLE logs (thread_id TEXT, body TEXT)");
      database.prepare("INSERT INTO logs VALUES (?, ?)").run("alpha.beta", "synthetic residual ID");
      database.close();
    } else {
      const rollout = path.join(item.root, "sessions", "alpha.beta.jsonl");
      await fs.writeFile(rollout, JSON.stringify({ type: "session_meta", payload: { id: "alpha.beta" } }) + "\n");
    }

    const discovery = await discoverConversations(["codex"], { home: item.home });
    const alpha = discovery.conversations.find((conversation) => conversation.id === "alpha")!;
    const longer = discovery.conversations.find((conversation) => conversation.id === "alpha.beta")!;
    expect(discovery.conversations.map((conversation) => conversation.id).sort()).toEqual(["alpha", "alpha.beta"]);
    expect(alpha.disabledReason).toMatch(/ambiguous|multiple|ownership/i);
    expect(longer.disabledReason).toMatch(/ambiguous|multiple|ownership/i);
    const calls: string[][] = [];
    const result = await deleteConversations([{ ...alpha, disabledReason: undefined }], {
      home: item.home, checkOpenPaths: closed, trash: movingTrash(item.home, calls)
    });

    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(calls).toEqual([]);
    await expect(fs.readFile(snapshot, "utf8")).resolves.toBe("synthetic shared snapshot\n");
  });

  it.each(["alpha.beta.JSONL", "alpha.beta.JsOnL"] as const)(
    "discovers a mixed-case longer rollout and refuses forged deletion (%s)",
    async (rolloutName) => {
      const item = await makeHome(["alpha"], false);
      const snapshot = path.join(item.root, "shell_snapshots", "alpha.beta");
      const rollout = path.join(item.root, "sessions", rolloutName);
      await fs.mkdir(path.dirname(snapshot), { recursive: true });
      await fs.writeFile(snapshot, "synthetic shared snapshot\n");
      await fs.writeFile(rollout, JSON.stringify({ type: "session_meta", payload: { id: "alpha.beta" } }) + "\n");
      const discovery = await discoverConversations(["codex"], { home: item.home });
      const alpha = discovery.conversations.find((conversation) => conversation.id === "alpha")!;
      const longer = discovery.conversations.find((conversation) => conversation.id === "alpha.beta")!;
      expect(discovery.conversations.map((conversation) => conversation.id).sort()).toEqual(["alpha", "alpha.beta"]);
      expect(alpha.disabledReason).toMatch(/ambiguous|multiple|ownership/i);
      expect(longer.disabledReason).toMatch(/ambiguous|multiple|ownership/i);
      const calls: string[][] = [];
      const result = await deleteConversations([{ ...alpha, disabledReason: undefined }], {
        home: item.home, checkOpenPaths: closed, trash: movingTrash(item.home, calls)
      });

      expect(result.deleted).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(calls).toEqual([]);
      await expect(fs.readFile(snapshot, "utf8")).resolves.toBe("synthetic shared snapshot\n");
      await expect(fs.readFile(rollout, "utf8")).resolves.toContain('"id":"alpha.beta"');
    }
  );

  it.each(["alpha.beta.JSONL", "alpha.beta.JsOnL"] as const)(
    "rechecks rollout-only ownership when %s appears during source-group checking",
    async (rolloutName) => {
    const item = await makeHome(["alpha"], false);
    const snapshot = path.join(item.root, "shell_snapshots", "alpha.beta");
    const newRollout = path.join(item.root, "sessions", rolloutName);
    await fs.mkdir(path.dirname(snapshot), { recursive: true });
    await fs.writeFile(snapshot, "synthetic snapshot\n");
    const discovery = await discoverConversations(["codex"], { home: item.home });
    const selected = discovery.conversations.find((conversation) => conversation.id === "alpha")!;
    expect(selected.dataPaths).toEqual([snapshot]);
    let snapshotChecks = 0;
    let injected = false;
    const calls: string[][] = [];
    const result = await deleteConversations([selected], {
      home: item.home,
      trash: movingTrash(item.home, calls),
      checkOpenPaths: async (files) => {
        if (files.some((file) => path.resolve(file) === path.resolve(snapshot))) {
          snapshotChecks += 1;
          if (snapshotChecks === 2) {
            injected = true;
            await fs.writeFile(newRollout,
              JSON.stringify({ type: "session_meta", payload: { id: "alpha.beta" } }) + "\n");
          }
        }
        return { supported: true, openPaths: [] };
      }
    });

    expect(snapshotChecks).toBeGreaterThanOrEqual(2);
    expect(injected).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(calls).toEqual([]);
    await expect(fs.readFile(snapshot, "utf8")).resolves.toBe("synthetic snapshot\n");
    await expect(fs.readFile(newRollout, "utf8")).resolves.toContain('"id":"alpha.beta"');
    }
  );

  it("rejects a newly added shorter ID for a previously unique dotted ID before moving its artifact", async () => {
    const item = await makeHome(["alpha.beta"], false);
    const snapshot = path.join(item.root, "shell_snapshots", "alpha.beta.snapshot");
    await fs.mkdir(path.dirname(snapshot), { recursive: true });
    await fs.writeFile(snapshot, "synthetic dotted snapshot\n");
    const discovery = await discoverConversations(["codex"], { home: item.home });
    const selected = discovery.conversations.find((conversation) => conversation.id === "alpha.beta")!;
    expect(selected.disabledReason).toBeUndefined();
    let snapshotChecks = 0;
    let injected = false;
    const calls: string[][] = [];
    const result = await deleteConversations([selected], {
      home: item.home,
      trash: movingTrash(item.home, calls),
      checkOpenPaths: async (files) => {
        if (files.some((file) => path.resolve(file) === path.resolve(snapshot))) {
          snapshotChecks += 1;
          if (snapshotChecks === 2) {
            injected = true;
            await fs.appendFile(item.paths.sessionIndex,
              JSON.stringify({ id: "alpha", thread_name: "synthetic shorter ID" }) + "\n");
            await fs.appendFile(item.paths.historyFile!,
              JSON.stringify({ session_id: "alpha", text: "synthetic shorter history" }) + "\n");
            const database = new DatabaseSync(item.paths.stateDatabase);
            try { database.prepare("INSERT INTO threads VALUES (?, NULL)").run("alpha"); }
            finally { database.close(); }
          }
        }
        return { supported: true, openPaths: [] };
      }
    });

    expect(injected).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(calls).toEqual([]);
    await expect(fs.readFile(snapshot, "utf8")).resolves.toBe("synthetic dotted snapshot\n");
    await expect(fs.readFile(item.paths.sessionIndex, "utf8")).resolves.toContain('"id":"alpha"');
  });

  it("keeps the final ownership check correct through the /var home alias", async () => {
    const item = await makeHome(["alpha"], false);
    const snapshot = path.join(item.root, "shell_snapshots", "alpha.beta");
    await fs.mkdir(path.dirname(snapshot), { recursive: true });
    await fs.writeFile(snapshot, "synthetic aliased snapshot\n");
    const realHome = await fs.realpath(item.home);
    const aliasHome = realHome.startsWith("/private/var/")
      ? realHome.slice("/private".length)
      : realHome;
    expect(aliasHome).not.toBe(realHome);
    expect(await fs.realpath(aliasHome)).toBe(realHome);

    const discovery = await discoverConversations(["codex"], { home: aliasHome });
    const selected = discovery.conversations.find((conversation) => conversation.id === "alpha")!;
    const aliasSnapshot = path.join(aliasHome, ".codex", "shell_snapshots", "alpha.beta");
    const newRollout = path.join(aliasHome, ".codex", "sessions", "alpha.beta.JsOnL");
    expect(selected.dataPaths).toEqual([aliasSnapshot]);
    let snapshotChecks = 0;
    let injected = false;
    const calls: string[][] = [];
    const result = await deleteConversations([selected], {
      home: aliasHome,
      trash: movingTrash(aliasHome, calls),
      checkOpenPaths: async (files) => {
        if (files.some((file) => path.basename(file) === "alpha.beta" &&
          path.dirname(file).endsWith(path.join(".codex", "shell_snapshots")))) {
          snapshotChecks += 1;
          if (snapshotChecks === 2) {
            injected = true;
            await fs.writeFile(newRollout,
              JSON.stringify({ type: "session_meta", payload: { id: "alpha.beta" } }) + "\n");
          }
        }
        return { supported: true, openPaths: [] };
      }
    });

    expect(snapshotChecks).toBeGreaterThanOrEqual(2);
    expect(injected).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(calls).toEqual([]);
    await expect(fs.readFile(snapshot, "utf8")).resolves.toBe("synthetic aliased snapshot\n");
    await expect(fs.readFile(newRollout, "utf8")).resolves.toContain('"id":"alpha.beta"');
  });

  it.each(["session index", "App local catalog"] as const)(
    "includes a longer ID known only through the %s",
    async (source) => {
      const item = await makeHome(["alpha"], false);
      const snapshot = path.join(item.root, "shell_snapshots", "alpha.beta");
      await fs.mkdir(path.dirname(snapshot), { recursive: true });
      await fs.writeFile(snapshot, "synthetic shared snapshot\n");
      if (source === "session index") {
        await fs.appendFile(item.paths.sessionIndex,
          JSON.stringify({ id: "alpha.beta", thread_name: "synthetic index-only ID" }) + "\n");
      } else {
        await fs.mkdir(path.dirname(item.paths.appDatabase!), { recursive: true });
        const database = new DatabaseSync(item.paths.appDatabase!);
        database.exec("CREATE TABLE local_thread_catalog (thread_id TEXT, host_id TEXT)");
        database.prepare("INSERT INTO local_thread_catalog VALUES (?, ?)").run("alpha.beta", "local");
        database.close();
      }

      const discovery = await discoverConversations(["codex"], { home: item.home });
      const alpha = discovery.conversations.find((conversation) => conversation.id === "alpha")!;
      const longer = discovery.conversations.find((conversation) => conversation.id === "alpha.beta")!;
      expect(discovery.conversations.map((conversation) => conversation.id).sort()).toEqual(["alpha", "alpha.beta"]);
      expect(alpha.disabledReason).toMatch(/ambiguous|multiple|ownership/i);
      expect(longer.disabledReason).toMatch(/ambiguous|multiple|ownership/i);
      const calls: string[][] = [];
      const result = await deleteConversations([{ ...alpha, disabledReason: undefined }], {
        home: item.home, checkOpenPaths: closed, trash: movingTrash(item.home, calls)
      });

      expect(result.deleted).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(calls).toEqual([]);
      await expect(fs.readFile(snapshot, "utf8")).resolves.toBe("synthetic shared snapshot\n");
    }
  );

  it("keeps a unique dotted ID deletable with exact, dated, generated, and SQLite artifacts", async () => {
    const item = await makeHome(["only.one"]);
    const generated = path.join(item.root, "generated_images", "only.one");
    const exact = path.join(item.root, "visualizations", "only.one");
    const dated = path.join(item.root, "visualizations", "2026", "10", "15", "only.one");
    const snapshot = path.join(item.root, "shell_snapshots", "only.one.snapshot");
    const sqlite = path.join(item.root, "shell_snapshots", "only.one.sqlite");
    const sidecars = [sqlite, sqlite + "-wal", sqlite + "-shm"];
    await fs.mkdir(generated, { recursive: true });
    await fs.writeFile(path.join(generated, "image.bin"), "synthetic image\n");
    await fs.mkdir(dated, { recursive: true });
    await fs.writeFile(path.join(dated, "output.bin"), "synthetic dated visualization\n");
    await fs.mkdir(path.dirname(exact), { recursive: true });
    await fs.writeFile(exact, "synthetic exact visualization\n");
    await fs.mkdir(path.dirname(snapshot), { recursive: true });
    await fs.writeFile(snapshot, "synthetic dotted snapshot\n");
    for (const file of sidecars) await fs.writeFile(file, "synthetic sqlite artifact\n");

    const discovery = await discoverConversations(["codex"], { home: item.home });
    const selected = discovery.conversations.find((conversation) => conversation.id === "only.one")!;
    const calls: string[][] = [];
    const result = await deleteConversations([selected], {
      home: item.home, checkOpenPaths: closed, trash: movingTrash(item.home, calls)
    });

    expect(selected.disabledReason).toBeUndefined();
    expect(result.failures).toEqual([]);
    expect(result.deleted).toEqual([selected]);
    for (const file of [generated, exact, dated, snapshot, ...sidecars]) {
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(calls.some((files) => sidecars.every((file) => files.includes(file)))).toBe(true);
  });
});

async function makeHome(ids: string[], withRollouts = true) {
  const home = await fs.realpath(await fixtureTemp(path.join(tmpdir(), "ai-cleaner-codex-artifact-")));
  homes.push(home);
  const root = path.join(home, ".codex");
  const paths = getCodexMetadataPaths(home);
  await fs.mkdir(path.join(root, "sessions"), { recursive: true });
  const database = new DatabaseSync(paths.stateDatabase);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT); CREATE TABLE thread_items (thread_id TEXT, contents TEXT);");
  const rollouts = new Map<string, { path: string; text: string }>();
  for (const id of ids) {
    const file = path.join(root, "sessions", id + ".jsonl");
    const text = JSON.stringify({ type: "session_meta", payload: { id } }) + "\n";
    if (withRollouts) await fs.writeFile(file, text);
    database.prepare("INSERT INTO threads VALUES (?, ?)").run(id, withRollouts ? file : null);
    database.prepare("INSERT INTO thread_items VALUES (?, ?)").run(id, "synthetic contents for " + id);
    if (withRollouts) rollouts.set(id, { path: file, text });
  }
  database.close();
  const indexText = ids.map((id) => JSON.stringify({ id, thread_name: "synthetic " + id })).join("\n") + "\n";
  const historyText = ids.map((id) => JSON.stringify({ session_id: id, text: "synthetic history for " + id })).join("\n") + "\n";
  await fs.writeFile(paths.sessionIndex, indexText);
  await fs.writeFile(paths.historyFile!, historyText);
  return { home, root, paths, rollouts, indexText, historyText };
}

async function collisionFixture() {
  const item = await makeHome(["alpha", "alpha.beta"]);
  const shell = path.join(item.root, "shell_snapshots", "alpha.beta");
  const visualization = path.join(item.root, "visualizations", "alpha.beta.snapshot");
  await fs.mkdir(path.dirname(shell), { recursive: true });
  await fs.mkdir(path.dirname(visualization), { recursive: true });
  await fs.writeFile(shell, "synthetic dotted shell snapshot\n");
  await fs.writeFile(visualization, "synthetic dotted visualization\n");
  return item;
}

const closed = async () => ({ supported: true, openPaths: [] as string[] });

function movingTrash(home: string, calls: string[][]) {
  let sequence = 0;
  return async (files: string[]) => {
    calls.push([...files]);
    const destination = path.join(home, "fixture-trash");
    await fs.mkdir(destination, { recursive: true });
    for (const file of files) {
      await fs.rename(file, path.join(destination, String(sequence++)));
    }
  };
}
