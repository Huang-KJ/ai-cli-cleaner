import { homedir } from "node:os";
import path from "node:path";
import type { CleanerManifest, ProviderId } from "./types.js";

export const manifests: CleanerManifest[] = [
  {
    id: "codex",
    name: "Codex",
    deletePatterns: [
      "~/.codex/history.jsonl",
      "~/.codex/session_index.jsonl",
      "~/.codex/sessions",
      "~/.codex/archived_sessions",
      "~/.codex/attachments",
      "~/.codex/dictation-history",
      "~/.codex/generated_images",
      "~/.codex/transcription-history.jsonl",
      "~/.codex/visualizations",
      "~/.codex/logs_2.sqlite*",
      "~/.codex/goals_1.sqlite*",
      "~/.codex/queue_1.sqlite*",
      "~/.codex/state_5.sqlite*",
      "~/.codex/thread_history_1.sqlite*",
      "~/.codex/thread-writer-locks",
      "~/.codex/rollout-migrations",
      "~/.codex/shell_snapshots",
      "~/.codex/..codex-global-state.json.tmp-*",
      "~/Documents/Codex/.DS_Store",
    ],
    memoryDeletePatterns: ["~/.codex/memories_1.sqlite*", "~/.codex/memories_v2_1.sqlite*", "~/.codex/memories"],
    datedDirectoryRoots: ["~/Documents/Codex"],
    preservedPaths: [
      "~/.codex/.codex-global-state.json",
      "~/.codex/.codex-global-state.json.bak",
      "~/.codex/AGENTS.md",
      "~/.codex/agents",
      "~/.codex/auth.json",
      "~/.codex/chrome-native-hosts-v2.json",
      "~/.codex/chrome-native-hosts.json",
      "~/.codex/computer-use",
      "~/.codex/config.toml",
      "~/.codex/installation_id",
      "~/.codex/sqlite",
      "~/.codex/plugins",
      "~/.codex/process_manager",
      "~/.codex/skills",
      "~/.codex/state",
      "~/.codex/rules",
      "~/.codex/vendor_imports"
    ]
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    deletePatterns: [
      "~/.copilot/session-state",
      "~/.copilot/session-store.db*",
      "~/.copilot/command-history-state.json",
      "~/.copilot/command-history-state",
      "~/.copilot/vscode.session.metadata.cache.json",
    ],
    preservedPaths: [
      "~/.copilot/agents",
      "~/.copilot/config.json",
      "~/.copilot/copilot-instructions.md",
      "~/.copilot/data.db",
      "~/.copilot/extensions",
      "~/.copilot/hooks",
      "~/.copilot/settings.json",
      "~/.copilot/mcp-config.json",
      "~/.copilot/mcp-oauth-config",
      "~/.copilot/mcp-secrets",
      "~/.copilot/permissions-config.json",
      "~/.copilot/ide",
      "~/.copilot/installed-plugins",
      "~/.copilot/instructions",
      "~/.copilot/plugin-data",
      "~/.copilot/pkg",
      "~/.copilot/providers.json",
      "~/.copilot/skills",
      "~/.config/github-copilot"
    ]
  },
  {
    id: "antigravity",
    name: "Google Antigravity",
    deletePatterns: [
      "~/.gemini/antigravity-cli/conversation_summaries.db*",
      "~/.gemini/antigravity-cli/jetbox_summaries_proto.pb",
      "~/.gemini/antigravity-cli/annotations",
      "~/.gemini/antigravity-cli/conversations",
      "~/.gemini/antigravity-cli/brain",
      "~/.gemini/antigravity-cli/history.jsonl",
      "~/.gemini/antigravity-cli/implicit",
      "~/.gemini/antigravity-cli/scratch",
      "~/.gemini/antigravity-cli/cache",
      "~/.gemini/antigravity-ide/jetbox_summaries_proto.pb",
      "~/.gemini/antigravity-ide/annotations",
      "~/.gemini/antigravity-ide/brain",
      "~/.gemini/antigravity-ide/code_tracker",
      "~/.gemini/antigravity-ide/context_state",
      "~/.gemini/antigravity-ide/conversations",
      "~/.gemini/antigravity-ide/html_artifacts",
      "~/.gemini/antigravity-ide/implicit",
      "~/.gemini/antigravity-ide/scratch",
    ],
    preservedPaths: [
      "~/.antigravity",
      "~/.gemini/antigravity-cli/bin",
      "~/.gemini/antigravity-cli/builtin",
      "~/.gemini/antigravity-cli/installation_id",
      "~/.gemini/antigravity-cli/jetski_state.pbtxt",
      "~/.gemini/antigravity-cli/knowledge",
      "~/.gemini/antigravity-cli/mcp",
      "~/.gemini/antigravity-cli/settings.json",
      "~/.gemini/antigravity-cli/updater",
      "~/.gemini/antigravity-ide/bin",
      "~/.gemini/antigravity-ide/browserAllowlist.txt",
      "~/.gemini/antigravity-ide/builtin",
      "~/.gemini/antigravity-ide/installation_id",
      "~/.gemini/antigravity-ide/knowledge",
      "~/.gemini/antigravity-ide/mcp",
      "~/.gemini/antigravity-ide/mcp_config.json",
      "~/.gemini/antigravity-ide/plugins",
      "~/.gemini/antigravity-ide/user_settings.pb",
      "~/Library/Application Support/Antigravity",
      "~/Library/HTTPStorages/com.google.antigravity",
      "~/Library/Preferences/com.google.antigravity.plist"
    ]
  },
  {
    id: "opencode",
    name: "OpenCode",
    deletePatterns: [
      "~/.local/share/opencode/project",
      "~/.local/share/opencode/repos",
      "~/.local/share/opencode/snapshot",
      "~/.local/share/opencode/storage/session",
      "~/.local/share/opencode/storage/message",
      "~/.local/share/opencode/storage/part",
      "~/.local/share/opencode/storage/todo",
      "~/.local/share/opencode/storage/session_share",
      "~/.local/share/opencode/storage/session_diff",
      "~/.local/share/opencode/opencode.db*",
      "~/.local/state/opencode/prompt-history.jsonl",
      "~/.local/state/opencode/locks"
    ],
    preservedPaths: [
      "~/.config/opencode",
      "~/.local/share/opencode/auth.json",
      "~/.local/share/opencode/account.json",
      "~/.local/share/opencode/bin",
      "~/.local/share/opencode/opencode.jsonc",
      "~/.local/share/opencode/storage/permission",
      "~/.local/share/opencode/storage/project",
      "~/.local/state/opencode/kv.json",
      "~/.local/state/opencode/model.json"
    ]
  },
  {
    id: "grok",
    name: "Grok Build CLI",
    deletePatterns: [
      "~/.grok/sessions",
      "~/.grok/active_sessions.json",
      "~/.grok/active_sessions.json.tmp",
      "~/.grok/active_sessions.lock"
    ],
    memoryDeletePatterns: ["~/.grok/memory"],
    preservedPaths: [
      "~/.grok/auth.json",
      "~/.grok/config.toml",
      "~/.grok/managed_config.toml",
      "~/.grok/requirements.toml",
      "~/.grok/bin",
      "~/.grok/completions",
      "~/.grok/docs",
      "~/.grok/downloads",
      "~/.grok/installed-plugins",
      "~/.grok/plugins",
      "~/.grok/hooks",
      "~/.grok/skills",
      "~/.grok/workflows",
      "~/.grok/worktrees",
      "~/.grok/agent_id",
      "~/.grok/version.json"
    ]
  },
  {
    id: "claude",
    name: "Claude Code",
    deletePatterns: [
      "~/.claude/history.jsonl",
      "~/.claude/file-history",
      "~/.claude/plans",
      "~/.claude/debug",
      "~/.claude/paste-cache",
      "~/.claude/image-cache",
      "~/.claude/uploads",
      "~/.claude/dev-mods",
      "~/.claude/session-env",
      "~/.claude/sessions",
      "~/.claude/tasks",
      "~/.claude/todos",
      "~/.claude/shell-snapshots",
      "~/.claude/feedback-bundles",
      "~/.claude/feedback/drafts",
      "~/.claude/usage-data",
      "~/.claude/stats-cache.json",
      "~/.claude/statsig",
      "~/.claude/logs"
    ],
    memoryDeletePatterns: ["~/.claude/agent-memory"],
    protectedChildRoots: [{ root: "~/.claude/projects", childNames: ["memory"] }],
    preservedPaths: [
      "~/.claude.json",
      "~/.claude/.credentials.json",
      "~/.claude/CLAUDE.md",
      "~/.claude/AGENTS.md",
      "~/.claude/settings.json",
      "~/.claude/settings.local.json",
      "~/.claude/keybindings.json",
      "~/.claude/agents",
      "~/.claude/backups",
      "~/.claude/commands",
      "~/.claude/daemon",
      "~/.claude/hooks",
      "~/.claude/jobs",
      "~/.claude/output-styles",
      "~/.claude/plugins",
      "~/.claude/rules",
      "~/.claude/skills",
      "~/.claude/themes",
      "~/.claude/workflows"
    ]
  }
];

export function getManifests(targets?: ProviderId[], options: { includeMemories?: boolean } = {}): CleanerManifest[] {
  const requested = targets === undefined ? undefined : new Set(targets);
  const selected = manifests.filter((manifest) => requested === undefined || requested.has(manifest.id));
  if (!options.includeMemories) return selected;
  return selected.map(({ memoryDeletePatterns, protectedChildRoots, ...manifest }) => ({
    ...manifest,
    deletePatterns: [...manifest.deletePatterns, ...(memoryDeletePatterns ?? []),
      ...(protectedChildRoots ?? []).map(({ root }) => root)]
  }));
}

export function getProviderName(id: ProviderId): string {
  return manifests.find((manifest) => manifest.id === id)?.name ?? id;
}

export function parseTargets(value?: string): ProviderId[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const allowed = new Set<ProviderId>(manifests.map((manifest) => manifest.id));
  const targets = value
    .split(",")
    .map((target) => target.trim().toLowerCase())
    .filter(Boolean);

  if (targets.length === 0) {
    throw new Error("Target list cannot be empty.");
  }

  for (const target of targets) {
    if (!allowed.has(target as ProviderId)) {
      throw new Error(`Unknown target "${target}". Expected one of: ${[...allowed].join(", ")}`);
    }
  }

  return [...new Set(targets)] as ProviderId[];
}

export function assertDefaultDataRoots(
  targets: ProviderId[],
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir()
): void {
  const roots: Partial<Record<ProviderId, Record<string, string>>> = {
    codex: { CODEX_HOME: path.join(home, ".codex") },
    copilot: { COPILOT_HOME: path.join(home, ".copilot") },
    claude: { CLAUDE_CONFIG_DIR: path.join(home, ".claude") },
    opencode: {
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      XDG_CACHE_HOME: path.join(home, ".cache")
    }
  };
  for (const target of new Set(targets)) {
    for (const [name, expected] of Object.entries(roots[target] ?? {})) {
      const value = environment[name];
      if (value && (!path.isAbsolute(value) || path.resolve(value) !== expected)) {
        throw new Error(
          `Only the default ${target} data directory is supported. A custom ${name} was detected; cleanup stopped to avoid deleting the wrong location.`
        );
      }
    }
  }
}
