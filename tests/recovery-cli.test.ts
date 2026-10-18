import { describe, expect, it } from "vitest";
import { createCliTestFixture, runCliCommand as command } from "./helpers/cli.js";

function fixture() {
  const events: string[] = [];
  const test = createCliTestFixture({
    confirm: async () => { throw new Error("不可確認"); }, selectAgent: async () => undefined, checkbox: async () => [],
    listRecovery: async () => { events.push("list"); return [{ id: "test-id", kind: "clean", target: ["codex"], startedAt: "2026-10-13T00:00:00Z", status: "partial" }]; },
    inspectRecovery: async (id) => { events.push(`inspect:${id}`); return { operation: { id, formatVersion: 1, kind: "clean", target: ["codex"], startedAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z", status: "partial", phase: "ended", plannedPaths: [], movedPaths: [], uncertainPaths: [], remainingPaths: [], metadata: [], helperFailed: false }, backups: [], instructions: ["Inspect manually"], claims: [] }; },
  });
  return { dependencies: test.dependencies, output: test.output, events };
}
describe("read-only recovery CLI entry point", () => {
  it("lists operation summaries as JSON without invoking mutation dependencies", async () => {
    const test = fixture();
    expect(await command(["recovery", "list", "--json"], test.dependencies)).toBe(0);
    expect(test.events).toEqual(["list"]);
    expect(JSON.parse(test.output[0]!)[0]).toMatchObject({ id: "test-id", status: "partial", target: ["codex"] });
  });
  it("inspect selects exactly one operation ID and prints its manual instructions", async () => {
    const test = fixture();
    expect(await command(["recovery", "inspect", "test-id"], test.dependencies)).toBe(0);
    expect(test.events).toEqual(["inspect:test-id"]);
    expect(test.output.join("\n")).toContain("Inspect manually");
  });
  it.each([false, true])("shows terminal-safe linked claim mappings in inspection (json=%s)", async (json) => {
    const test = fixture();
    const inspect = test.dependencies.inspectRecovery!;
    const directory = "/fixture/claim\u202e";
    const target = { source: "/fixture/原始\u200f", slot: "000-state\u061c\u2066.sqlite", state: "claimed" };
    test.dependencies.inspectRecovery = async (id) => ({ ...await inspect(id), claims: [{ directory,
      recordPath: `${directory}/claim.json`, status: "recorded", state: "committed", targets: [target] }] });
    expect(await command(["recovery", "inspect", "test-id", ...(json ? ["--json"] : [])], test.dependencies)).toBe(0);
    expect(test.output[0]).not.toMatch(/\p{Bidi_Control}/u);
    const report = JSON.parse(test.output[0]!);
    expect(report.claims).toEqual([{ directory, recordPath: `${directory}/claim.json`, status: "recorded", state: "committed", targets: [target] }]);
    expect(test.output[0]).toContain("原始");
  });
  it("never converts inspection failure into a successful command", async () => {
    const test = fixture();
    test.dependencies.inspectRecovery = async () => { throw new Error("The record was changed."); };
    expect(await command(["recovery", "inspect", "bad-id", "--json"], test.dependencies)).toBe(1);
    expect(test.output.join("\n")).toContain("The record was changed.");
  });
});
