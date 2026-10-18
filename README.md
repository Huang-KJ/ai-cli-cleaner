# AI CLI Cleaner

[![CI](https://github.com/Huang-KJ/ai-cli-cleaner/actions/workflows/ci.yml/badge.svg)](https://github.com/Huang-KJ/ai-cli-cleaner/actions/workflows/ci.yml)
[![npm beta](https://img.shields.io/npm/v/ai-cli-cleaner/beta?label=npm%20beta)](https://www.npmjs.com/package/ai-cli-cleaner)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS 26+](https://img.shields.io/badge/platform-macOS%2026%2B-lightgrey.svg)](docs/compatibility.md)
[![Node.js: 22 / 24 / 26](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-339933.svg)](docs/installation.md#requirements)

**Review and remove local AI agent conversations from one macOS command.**

AI CLI Cleaner helps you select individual conversations or clean an agent's full local history, including supported indexes and related data. It supports Codex, GitHub Copilot CLI, Google Antigravity, OpenCode, and Grok Build CLI.

- **Preview the scope.** Inspect a full cleanup or choose conversations interactively before confirming.
- **Preserve supported configuration.** Keep sign-in data, settings, MCP configuration, skills, and plugins at known paths.
- **Check before changing data.** Process, open-file, path, ownership, and format checks can stop an unsafe or unsupported operation.
- **Inspect recovery records.** Files move to macOS Trash; supported index changes have backups and an operation journal.

This is beta software. Keep an independent backup of important data, review the preview, and read the [format limits](docs/compatibility.md). Recovery is manual, and Trash is not secure erasure.

## Install

Requires macOS 26 or later, Node.js `^22.22.2`, `^24.15.0`, or `^26.0.0`, and npm 12.x. Node.js and npm must already be installed.

```bash
npm install --global ai-cli-cleaner@beta
ai-cleaner --version
ai-cleaner doctor --all
```

The npm package includes the compiled CLI, native helpers, and bundled runtime dependencies; no source build is required. See [installation](docs/installation.md) for runtime setup, a [source installation](docs/installation.md#install-from-source), installation checks, and removal.

To update to the version selected by the npm `beta` tag, rerun:

```bash
npm install --global ai-cli-cleaner@beta
```

The built-in `ai-cleaner update` command checks public, published GitHub releases. It does not read npm dist-tags; use the npm command above for npm beta updates. GitHub archive installation and self-update require separately published release assets.

## Quick start

Check your environment and preview one agent's full cleanup:

```bash
ai-cleaner doctor --target codex
ai-cleaner clean --target codex --dry-run
```

To review individual conversations in an interactive terminal:

```bash
ai-cleaner conversations --target codex --dry-run
```

Close the selected agent, then run the picker again and confirm the conversations to delete:

```bash
ai-cleaner conversations --target codex
```

For the agent's **entire local conversation history and related data**, review the full preview, keep the agent closed, and run:

```bash
ai-cleaner clean --target codex
```

**Codex full cleanup also removes valid `YYYY-MM-DD` directories directly inside `~/Documents/Codex`, with everything inside them—including project source files.** It preserves the `Codex` root, ordinary named project directories, invalid dates, and date-named files. Selected-conversation deletion does not remove these workspaces. Full cleanup can also include attachments, voice records, memories, goals, queues, generated images, visualizations, logs, and caches. Review the actual paths before confirming.

## Supported agents

| Agent | `--target` | Selected conversations | Full cleanup |
|---|---|---|---|
| Codex CLI / App | `codex` | Supported local records and indexes | Includes dated workspaces described above |
| GitHub Copilot CLI | `copilot` | Supported session records and indexes | Supported local history and related data |
| Google Antigravity CLI / IDE | `antigravity` | Blocked when either shared protobuf summary is nonempty | Includes both known CLI and IDE roots |
| OpenCode | `opencode` | Supported SQLite formats | Preserves supported account/configuration data in mixed databases |
| Grok Build CLI | `grok` | Supported sessions and indexes | Supported local history and memories |

Support depends on storage format and ownership checks, not just the agent name. See [compatibility](docs/compatibility.md) for validation cases, default roots, legacy storage, and refusals. Desktop GUI behavior and cloud models are outside the documented CLI validation cases.

## Commands

| Command | Purpose |
|---|---|
| `ai-cleaner conversations` | Choose an agent, then select conversations interactively. |
| `ai-cleaner clean --target codex,copilot` | Clean supported local conversation data for selected agents. |
| `ai-cleaner clean --all --dry-run` | Preview full cleanup across all five agents. |
| `ai-cleaner doctor --all` | Check platform, tools, data roots, and running agents. |
| `ai-cleaner recovery list` | List local operation records. |
| `ai-cleaner recovery inspect <id>` | Inspect backups, integrity, and manual recovery guidance. |
| `ai-cleaner update` | Check public GitHub releases for a newer stable version. |
| `ai-cleaner update --install` | Verify and install a published update in a supported global installation. |

Run `ai-cleaner <command> --help` for options. Conversation and recovery lists use the system time zone; `--timezone Asia/Taipei` or another IANA time zone overrides it. Structured output is available through `doctor --json`, `recovery list --json`, and `recovery inspect <id> --json`.

## Data handling and limits

Cleanup acts on known local paths. It does not call provider cloud-history APIs, discover arbitrary workspaces, or search the disk. An external service syncing affected files may propagate their local deletion. Custom roots such as a different `CODEX_HOME` are refused; symbolic-link or relocated document roots are unsupported for Codex full cleanup.

Close selected agents before deletion. `--force-stop` requests shutdown and may close the ChatGPT/Codex desktop app. `--yes` skips full-cleanup confirmation but preserves process and data checks. Open SQLite databases and their WAL, SHM, or journal files block deletion. Unknown formats, ambiguous ownership, and changes since discovery can also block an operation; preserve the data and investigate the refusal.

A dry run does not delete original data or stop agents. SQLite inspection uses private temporary copies, which may contain sensitive data and SQLite sidecars; those copies move to Trash afterward. Trash, recovery backups, and journals retain data. The tool does not automatically empty Trash or erase backups, and it cannot guarantee complete recovery. Read [recovery and data handling](docs/recovery.md) before cleaning important data.

Selected deletion follows supported IDs, owned paths, and database relationships. It does not infer ownership from text mentions. Antigravity's shared protobuf summaries currently prevent per-conversation rewriting; use its built-in `/resume` interface for individual deletion when this guard applies. OpenCode legacy JSON supports full cleanup of known conversation subdirectories; selected deletion of that format is unsupported.

## Terminal and scripting

Conversation selection and confirmation require an interactive terminal on standard input and standard error. Prompts and errors go to standard error; results go to standard output. For scripts, preview with `clean --dry-run`, then use `clean --yes` only when skipping confirmation is intentional. Piping `y` into an interactive command is refused before discovery or mutation.

Exit codes are `0` for success or deliberate No/Escape cancellation, `1` for errors or incomplete operations, and `130` for Ctrl-C during an interactive prompt. The deprecated `conversations --allow-running` option is accepted only with `--dry-run`; it cannot authorize deletion.

## Documentation and community

[Installation](docs/installation.md) · [Compatibility](docs/compatibility.md) · [Recovery](docs/recovery.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Report reproducible bugs and feature requests through [GitHub Issues](https://github.com/Huang-KJ/ai-cli-cleaner/issues), using synthetic examples and redacted output. Keep conversations, raw databases, account identifiers, full personal paths, secrets, and complete logs out of reports. Follow the [security policy](SECURITY.md) for vulnerability disclosure.

Licensed under [MIT](LICENSE). The bundled native Trash helper includes its own [MIT license](vendor/license) and [provenance](vendor/provenance.json). The project-owned claim helper has separate [source and binary provenance](vendor/claims-provenance.json).
