import { fixtureTrash, fixtureTemp } from "./helpers/fixture-trash.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConversations } from "../src/conversations/discover.js";

const fixtureRoot = new URL("./fixtures/opencode-v1.2.27/", import.meta.url);
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { recursive: true, force: true }))); });

interface FixtureManifest {
  formatVersion: number;
  provider: string;
  providerVersion: string;
  evidence: string;
  upstreamDataVerified: boolean;
  upstreamAppReadback: string;
  sources: Array<{ commit: string; sha256: string; url: string }>;
  fixtures: Array<{ file: string; sha256: string; bytes: number }>;
}

describe("fixed upstream SQLite compatibility contracts", () => {
  it("keeps synthetic SQLite rows tied to immutable official schema without claiming app verification", async () => {
    const manifest = JSON.parse(await fixture("manifest.json")) as FixtureManifest;
    expect(manifest).toMatchObject({
      formatVersion: 1, provider: "opencode", providerVersion: "1.2.27",
      evidence: "source-derived-synthetic", upstreamDataVerified: false, upstreamAppReadback: "not-run"
    });
    expect(manifest.sources).toHaveLength(1);
    for (const source of manifest.sources) {
      expect(source.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(source.url).toContain(`/anomalyco/opencode/${source.commit}/`);
      expect(source.url).toContain("session.sql.ts");
    }
    expect(manifest.fixtures.map((entry) => entry.file)).toEqual(["sessions.json"]);
    for (const entry of manifest.fixtures) {
      const contents = await fs.readFile(new URL(entry.file, fixtureRoot));
      expect(contents.byteLength).toBe(entry.bytes);
      expect(createHash("sha256").update(contents).digest("hex")).toBe(entry.sha256);
    }
  });

  it("reads all roots and children from local SQLite and sorts by updated timestamp", async () => {
    const home = await makeHome();
    const db = new DatabaseSync(path.join(home, ".local", "share", "opencode", "opencode.db"));
    db.exec("CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,directory TEXT,time_updated INTEGER)");
    const insert = db.prepare("INSERT INTO session VALUES (?,?,?,?,?)");
    const values = JSON.parse(await fixture("sessions.json")) as Array<{ id: string; parent_id: string | null; title: string; directory: string; time_updated: number }>;
    for (const row of values) insert.run(row.id, row.parent_id, row.title, row.directory, row.time_updated);
    db.close();
    const result = await discoverConversations(["opencode"], { home });
    expect(result.warnings).toEqual([]);
    expect(result.conversations.map((item) => item.id)).toEqual(["ses_fixtureRecent", "ses_fixtureOlder"]);
    expect(result.conversations[0]).toMatchObject({ parentId: "ses_fixtureOlder", sizeKnown: false,
      title: "近期的測試對話", workspace: "/fixtures/recent-project", updatedAt: new Date(1790463600000).toISOString() });
  });

  it("accepts an absent DB only when no legacy conversation store exists", async () => {
    const home = await makeHome();
    expect(await discoverConversations(["opencode"], { home })).toEqual({ conversations: [], warnings: [] });
    const legacy = path.join(home, ".local", "share", "opencode", "storage", "session", "project");
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "session.json"), '{}');
    const result = await discoverConversations(["opencode"], { home });
    expect(result.conversations).toEqual([]);
    expect(result.warnings.join(" ")).toContain("legacy or unverifiable conversation storage");
  });

  it("reports unknown SQLite schema as a visible discovery warning", async () => {
    const home = await makeHome();
    const db = new DatabaseSync(path.join(home, ".local", "share", "opencode", "opencode.db"));
    db.exec("CREATE TABLE session(id TEXT)"); db.close();
    const result = await discoverConversations(["opencode"], { home });
    expect(result.conversations).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^OpenCode:/);
  });
});

async function makeHome(): Promise<string> {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-compat-"));
  homes.push(home);
  await fs.mkdir(path.join(home, ".local", "share", "opencode"), { recursive: true });
  return home;
}

async function fixture(file: string): Promise<string> {
  return fs.readFile(new URL(file, fixtureRoot), "utf8");
}
