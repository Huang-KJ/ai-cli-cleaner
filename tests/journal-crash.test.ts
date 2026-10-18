import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { inspectOperation, listOperations } from "../src/recovery/operations.js";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";

it("keeps durable intent incomplete when its own helper process is killed before catch", async () => {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-crash-"));
  const first = path.join(home, "first.jsonl");
  const second = path.join(home, "second.jsonl");
  const moved = path.join(home, "simulated-trash");
  let child: ChildProcess | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await fs.writeFile(first, "first synthetic conversation");
    await fs.writeFile(second, "second synthetic conversation");
    const moduleUrl = new URL("../dist/recovery/operations.js", import.meta.url).href;
    const script = `
      import { rename } from "node:fs/promises";
      import { withOperation, wrapOperationTrash } from ${JSON.stringify(moduleUrl)};
      const [home, first, second, moved] = JSON.parse(process.argv[1]);
      await withOperation({ home, kind: "conversations", target: ["codex"] }, async () => {
        await wrapOperationTrash(async (paths) => {
          await rename(paths[0], moved);
          process.stdout.write("READY\\n");
          // 等待父程序終止，不執行 catch 或搬移第二筆資料。
          await new Promise(() => { setInterval(() => {}, 1000); });
        })([first, second]);
      });
    `;
    // 只建立合成子程序，使用明確 home；不呼叫真垃圾桶或 Agent。
    child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify([home, first, second, moved])], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const spawned = child;
    closed = new Promise((resolve) => {
      spawned.once("close", (code, signal) => resolve({ code, signal }));
    });
    let output = "";
    let errors = "";
    spawned.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    const ready = new Promise<void>((resolve, reject) => {
      spawned.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("READY\n")) resolve();
      });
      spawned.once("error", reject);
      void closed!.then(() => {
        if (!output.includes("READY\n")) reject(new Error(`合成子程序未抵達中斷點：${errors}`));
      });
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (spawned.exitCode === null && spawned.signalCode === null) spawned.kill("SIGKILL");
        reject(new Error("合成子程序中斷測試超過 10 秒。"));
      }, 10_000);
    });
    await Promise.race([ready, deadline]);
    // 只能終止本測試自己 spawn 且持有物件的子程序。
    expect(spawned.kill("SIGKILL")).toBe(true);
    const exit = await Promise.race([closed, deadline]);
    expect(exit.signal).toBe("SIGKILL");
    const [summary] = await listOperations(home);
    expect(summary!.status).toBe("incomplete");
    const inspected = await inspectOperation(summary!.id, home);
    expect(inspected.operation.phase).toBe("trash-intent");
    expect(inspected.operation.plannedPaths).toEqual([first, second]);
    expect(inspected.operation.uncertainPaths).toEqual([first, second]);
    expect(inspected.operation.movedPaths).toEqual([]);
    expect(inspected.operation.endedAt).toBeUndefined();
    await expect(fs.lstat(first)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(moved, "utf8")).toBe("first synthetic conversation");
    expect(await fs.readFile(second, "utf8")).toBe("second synthetic conversation");
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await fixtureTrash(home, { force: true, recursive: true });
  }
}, 15_000);
