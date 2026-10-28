# AI CLI Cleaner

[![CI](https://github.com/Huang-KJ/ai-cli-cleaner/actions/workflows/ci.yml/badge.svg)](https://github.com/Huang-KJ/ai-cli-cleaner/actions/workflows/ci.yml)
[![npm beta](https://img.shields.io/npm/v/ai-cli-cleaner/beta?label=npm%20beta)](https://www.npmjs.com/package/ai-cli-cleaner)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS 26+](https://img.shields.io/badge/platform-macOS%2026%2B-lightgrey.svg)](docs/compatibility.md)
[![Node.js: 22 / 24 / 26](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-339933.svg)](docs/installation.md#requirements)

Review and remove local AI agent conversations on macOS. Select individual conversations or clean an agent's local history, including supported indexes and related data. Memories are kept by default. Known sign-in, settings, MCP, skill, and plugin paths are preserved; process, open-file, path, ownership, and format checks can refuse an operation.

This is beta software. Keep an independent backup, review the preview and [format limits](docs/compatibility.md), and close the selected agent before deletion. Files move to macOS Trash; supported index changes have backups and an operation journal. Recovery is manual, and Trash is not secure erasure.

## Install

Requires macOS 26 or later, Node.js `^22.22.2`, `^24.15.0`, or `^26.0.0`, and npm 12.x. Node.js and npm must already be installed.

```bash
npm install --global ai-cli-cleaner@beta
ai-cleaner --version
ai-cleaner doctor --all
```

The package includes the compiled CLI, native helpers, and bundled runtime dependencies; no source build is required. Rerun the same npm install command for beta updates. The built-in updater uses separately published GitHub releases, so it does not follow npm dist-tags. See [installation and updates](docs/installation.md) for runtime setup, source/archive installation, and removal.

## Quick start

Check your environment, preview the full scope, and review individual conversations in an interactive terminal:

```bash
ai-cleaner doctor --target codex
ai-cleaner clean --target codex --dry-run
ai-cleaner clean --all --dry-run --verbose
ai-cleaner conversations --target codex --dry-run
```

Close the selected agent, then run the picker again and confirm the conversations to delete:

```bash
ai-cleaner conversations --target codex
```

For the agent's **local conversation history and related data**, review the preview, keep the agent closed, and run:

```bash
ai-cleaner clean --target codex
```

**Memories stay intact by default, including with `--all`, `--yes`, or `--force-stop`.** Add `--include-memories` only when you also want to remove supported memory stores. Preview that larger scope before running it:

```bash
ai-cleaner clean --all --include-memories --dry-run --verbose
ai-cleaner clean --all --include-memories --force-stop
```

The default retains Codex's memory databases and `memories/`, Grok's `memory/`, and Claude's project and subagent memory directories. Retained memories can still contain information from deleted conversations. `conversations` also keeps memories by default; its `--include-memories` option removes only supported records attributable to the selected conversations, currently Codex database records. Shared memory files and other agents' memory stores remain intact during selected deletion. See [memory scope](docs/compatibility.md#memory-preservation) for exact paths.

**Codex full cleanup also removes valid `YYYY-MM-DD` directories directly inside `~/Documents/Codex`, with everything inside them—including project source files.** It also removes that root's `.DS_Store` Finder metadata. It preserves the `Codex` root, ordinary named project directories, invalid dates, and date-named files. Selected-conversation deletion does not remove these workspaces. Full cleanup can also include attachments, voice records, goals, queues, generated images, visualizations, logs, and caches. Review the actual paths before confirming.

## Supported agents

| Agent | `--target` | Selected conversations | Full cleanup |
|---|---|---|---|
| Codex CLI / App | `codex` | Supported local records and indexes | Includes dated workspaces described above |
| GitHub Copilot CLI | `copilot` | Supported session records and indexes | Supported local history and related data |
| Google Antigravity CLI / IDE | `antigravity` | Blocked when either shared protobuf summary is nonempty | Includes both known CLI and IDE roots |
| OpenCode | `opencode` | Supported SQLite formats | Preserves supported account/configuration data in mixed databases |
| Grok Build CLI | `grok` | Supported sessions and indexes | Local history; memories only with `--include-memories` |
| Claude Code | `claude` | Preview only; use full cleanup to delete | Local history, artifacts, and supported Desktop Code sidebar records; memories only with `--include-memories` |

Support depends on storage format and ownership checks. [Compatibility](docs/compatibility.md) defines validation cases, roots, legacy storage, and refusals; desktop GUI behavior and cloud models are outside those CLI cases. When Antigravity's shared summaries block individual deletion, use its built-in `/resume` interface. OpenCode legacy JSON supports full cleanup of known conversation subdirectories, but not selected deletion.

## Commands

| Command | Purpose |
|---|---|
| `ai-cleaner conversations` | Choose an agent, then select conversations interactively; `--target` selects one agent directly. |
| `ai-cleaner clean --target codex,copilot` | Clean full local histories for selected agents. |
| `ai-cleaner clean --all --dry-run` | Preview a cleanup summary across all six agents. |
| `ai-cleaner clean --all --include-memories --dry-run` | Preview all agents with supported memory stores included. |
| `ai-cleaner clean --target claude` | Clean Claude Code's supported local history and related data. |
| `ai-cleaner doctor --all` | Check platform, tools, data roots, and running agents. |
| `ai-cleaner recovery list` | List local operation records. |
| `ai-cleaner recovery inspect <id>` | Inspect backups, integrity, and manual recovery guidance. |
| `ai-cleaner update` | Check public GitHub releases for a newer stable version. |
| `ai-cleaner update --install` | Verify and install a published update in a supported global installation. |

Run `ai-cleaner <command> --help` for options. Conversation and recovery lists use the system time zone; `--timezone Asia/Taipei` or another IANA zone overrides it. `doctor`, `recovery list`, and `recovery inspect <id>` support `--json`; see [recovery](docs/recovery.md) for operation states, retained copies, and manual restoration.

`clean` shows a short summary by default, including whether memories are kept or included. Add `--verbose` (or `-v`) for the full scope, paths, and index updates; `clean --all --dry-run --verbose` previews those details without stopping agents or deleting originals. Shutdown impacts, dated Codex workspace contents, errors, and recovery paths remain visible without verbose output.

## Data handling and limits

Cleanup acts on known local paths. It does not call provider cloud-history APIs, discover arbitrary workspaces, or search the disk. An external service syncing affected files may propagate their local deletion. Custom roots such as a different `CODEX_HOME` are refused; symbolic-link or relocated document roots are unsupported for Codex full cleanup.

`--force-stop` requests shutdown and may close the ChatGPT/Codex or Claude desktop app when selected. `--yes` skips full-cleanup confirmation but preserves process and data checks. Open SQLite databases or sidecars, unknown formats, ambiguous ownership, and changes since discovery can block deletion; preserve the data and investigate the refusal.

A dry run does not delete original data or stop agents. SQLite inspection uses private temporary copies, which may contain sensitive data and sidecars; those copies move to Trash afterward. Trash, backups, and journals retain data until you handle them; the tool never empties Trash or erases backups. Selected deletion follows supported IDs, owned paths, and database relationships, without inferring ownership from text mentions.

## Terminal and scripting

Conversation selection and confirmation require an interactive terminal on standard input and standard error. Prompts and errors go to standard error; results go to standard output. For scripts, preview with `clean --dry-run`, then use `clean --yes` only when skipping confirmation is intentional. Piping `y` into an interactive command is refused before discovery or mutation.

Exit codes are `0` for success or deliberate No/Escape cancellation, `1` for errors or incomplete operations, and `130` for Ctrl-C during an interactive prompt. The deprecated `conversations --allow-running` option is accepted only with `--dry-run`; it cannot authorize deletion.

## Documentation and community

[Installation](docs/installation.md) · [Compatibility](docs/compatibility.md) · [Recovery](docs/recovery.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Report reproducible bugs and feature requests through [GitHub Issues](https://github.com/Huang-KJ/ai-cli-cleaner/issues), using synthetic examples and redacted output. Keep conversations, raw databases, account identifiers, full personal paths, secrets, and complete logs out of reports. Follow the [security policy](SECURITY.md) for vulnerability disclosure.

Licensed under [MIT](LICENSE). The bundled native Trash helper includes its own [MIT license](vendor/license) and [provenance](vendor/provenance.json). The project-owned claim helper has separate [source and binary provenance](vendor/claims-provenance.json).
