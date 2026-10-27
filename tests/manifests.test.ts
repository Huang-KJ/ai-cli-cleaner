import { describe, expect, it } from "vitest";
import {
  assertDefaultDataRoots,
  getManifests,
  manifests,
  parseTargets
} from "../src/cleaners/manifests.js";

describe("AI Agent cleaner manifests", () => {
  it("rejects custom data roots only for selected providers", () => {
    expect(() => assertDefaultDataRoots(["codex"], { CODEX_HOME: "/custom" }, "/fixture")).toThrow(/CODEX_HOME/);
    expect(() => assertDefaultDataRoots(["copilot"], { COPILOT_HOME: "relative" }, "/fixture")).toThrow(/COPILOT_HOME/);
    expect(() => assertDefaultDataRoots(["opencode"], { XDG_DATA_HOME: "/external" }, "/fixture")).toThrow(/XDG_DATA_HOME/);
    expect(() => assertDefaultDataRoots(["claude"], { CLAUDE_CONFIG_DIR: "/external" }, "/fixture")).toThrow(/CLAUDE_CONFIG_DIR/);
    expect(() => assertDefaultDataRoots(["claude"], { CLAUDE_CONFIG_DIR: "/fixture/.claude/" }, "/fixture")).not.toThrow();
    expect(() => assertDefaultDataRoots(["copilot"], { CODEX_HOME: "/custom" }, "/fixture")).not.toThrow();
    expect(() => assertDefaultDataRoots(["codex"], { CODEX_HOME: "/fixture/.codex/" }, "/fixture")).not.toThrow();
  });

  it("supports all active targets but not Gemini CLI", () => {
    expect(manifests.map((manifest) => manifest.id)).toEqual([
      "codex", "copilot", "antigravity", "opencode", "grok", "claude"
    ]);
    expect(parseTargets("codex,antigravity,grok,codex")).toEqual([
      "codex", "antigravity", "grok"
    ]);
    expect(() => parseTargets("gemini")).toThrow(/Unknown target/);
    expect(() => parseTargets("legacy-agent")).toThrow(/Unknown target/);
    expect(parseTargets("Claude,claude")).toEqual(["claude"]);
  });

  it("cleans IDE and CLI conversations, indexes, and artifacts", () => {
    const manifest = manifests.find((candidate) => candidate.id === "antigravity");
    expect(manifest?.deletePatterns).toEqual(expect.arrayContaining([
      "~/.gemini/antigravity-cli/brain",
      "~/.gemini/antigravity-cli/conversations",
      "~/.gemini/antigravity-cli/conversation_summaries.db*",
      "~/.gemini/antigravity-cli/history.jsonl",
      "~/.gemini/antigravity-cli/cache",
      "~/.gemini/antigravity-ide/brain",
      "~/.gemini/antigravity-ide/conversations",
      "~/.gemini/antigravity-ide/html_artifacts",
      "~/.gemini/antigravity-ide/code_tracker",
      "~/.gemini/antigravity-ide/context_state"
    ]));
  });

  it("excludes general cache, logs, and recent-document lists", () => {
    const patterns = manifests.filter((manifest) => manifest.id !== "claude").flatMap((manifest) => manifest.deletePatterns);
    expect(patterns.some((pattern) => pattern.startsWith("~/Library/Caches/"))).toBe(false);
    expect(patterns).not.toContain("~/.codex/cache");
    expect(patterns).not.toContain("~/.cache/opencode");
    expect(patterns).not.toContain("~/.grok/logs");
    expect(patterns.some((pattern) => /\/(?:log|logs)(?:\/|$)|recentdocuments/i.test(pattern))).toBe(false);
    expect(patterns).toContain("~/.gemini/antigravity-cli/cache");
  });

  it("cleans documented Claude application records without deleting the configuration root", () => {
    const claude = manifests.find((manifest) => manifest.id === "claude")!;
    expect(claude.deletePatterns).toEqual(expect.arrayContaining([
      "~/.claude/history.jsonl", "~/.claude/file-history",
      "~/.claude/debug", "~/.claude/logs", "~/.claude/paste-cache", "~/.claude/usage-data"
    ]));
    expect(claude.memoryDeletePatterns).toContain("~/.claude/agent-memory");
    expect(claude.protectedChildRoots).toEqual([{ root: "~/.claude/projects", childNames: ["memory"] }]);
    expect(claude.deletePatterns).not.toContain("~/.claude");
    expect(claude.preservedPaths).toEqual(expect.arrayContaining([
      "~/.claude.json", "~/.claude/.credentials.json", "~/.claude/settings.json",
      "~/.claude/CLAUDE.md", "~/.claude/plugins", "~/.claude/skills", "~/.claude/agents"
    ]));
  });

  it("includes memory deletion only through an explicit option", () => {
    for (const id of ["codex", "grok", "claude"] as const) {
      const retained = getManifests([id])[0]!;
      const included = getManifests([id], { includeMemories: true })[0]!;
      for (const memory of retained.memoryDeletePatterns ?? []) {
        expect(retained.deletePatterns).not.toContain(memory);
        expect(included.deletePatterns).toContain(memory);
      }
      expect(included.memoryDeletePatterns).toBeUndefined();
    }
    expect(getManifests(["claude"])[0]?.deletePatterns).not.toContain("~/.claude/projects");
    expect(getManifests(["claude"], { includeMemories: true })[0]?.deletePatterns).toContain("~/.claude/projects");
    expect(getManifests(["claude"], { includeMemories: true })[0]?.protectedChildRoots).toBeUndefined();
  });

  it("preserves settings, runtime, MCP, plugins, knowledge, and app preferences", () => {
    const manifest = manifests.find((candidate) => candidate.id === "antigravity");
    expect(manifest?.preservedPaths).toEqual(expect.arrayContaining([
      "~/.gemini/antigravity-cli/bin",
      "~/.gemini/antigravity-cli/mcp",
      "~/.gemini/antigravity-cli/settings.json",
      "~/.gemini/antigravity-ide/mcp",
      "~/.gemini/antigravity-ide/plugins",
      "~/.gemini/antigravity-ide/user_settings.pb",
      "~/Library/Application Support/Antigravity",
      "~/Library/Preferences/com.google.antigravity.plist"
    ]));
    for (const preserved of manifest?.preservedPaths ?? []) {
      expect(manifest?.deletePatterns).not.toContain(preserved);
    }
  });

  it("returns only selected provider manifests", () => {
    expect(getManifests()).toEqual(manifests);
    expect(getManifests(["antigravity"])).toEqual([
      expect.objectContaining({ id: "antigravity" })
    ]);
    expect(getManifests([])).toEqual([]);
  });

  it("keeps provider configuration while clearing conversation data", () => {
    const codex = manifests.find((manifest) => manifest.id === "codex");
    const copilot = manifests.find((manifest) => manifest.id === "copilot");
    const opencode = manifests.find((manifest) => manifest.id === "opencode");
    const grok = manifests.find((manifest) => manifest.id === "grok");
    expect(codex?.deletePatterns).toContain("~/.codex/sessions");
    expect(codex?.preservedPaths).toContain("~/.codex/config.toml");
    expect(copilot?.deletePatterns).toContain("~/.copilot/session-state");
    expect(copilot?.preservedPaths).toContain("~/.copilot/settings.json");
    expect(opencode?.deletePatterns).toContain("~/.local/share/opencode/opencode.db*");
    expect(opencode?.preservedPaths).toContain("~/.config/opencode");
    expect(grok?.deletePatterns).toContain("~/.grok/sessions");
    expect(grok?.preservedPaths).toContain("~/.grok/config.toml");
  });
});
