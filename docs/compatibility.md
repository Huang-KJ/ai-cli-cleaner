# Compatibility and validation scope

AI CLI Cleaner supports macOS 26 or later on Intel and Apple Silicon. Older macOS versions are outside the support policy. `clean` and `conversations`, including dry-run, refuse to run there before reading conversations or stopping agents. Diagnostics, help, and read-only recovery queries remain available.

The Node.js range is `^22.22.2 || ^24.15.0 || ^26.0.0`, with npm 12.x. The [CI workflow](../.github/workflows/ci.yml) checks the runtime matrix. Consult its results for the revision you use; a configured job is not evidence of a successful run.

## Runtime and architecture

The product minimum is macOS 26 regardless of a dependency's lower deployment target. Official Node.js platform information for the referenced versions:

| Node.js line | Product minimum macOS | Official processor support |
|---|---|---|
| 22.x | 26 | x64 and arm64. |
| 24.x | 26 | x64 and arm64 are Tier 1. |
| 26.x | 26 | arm64 is Tier 1; x64 is Tier 2. |

Sources: [Node.js 22](https://github.com/nodejs/node/blob/v22.23.3/BUILDING.md#platform-list), [Node.js 24](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list), [Node.js 26](https://github.com/nodejs/node/blob/v26.11.1/BUILDING.md#platform-list). Binary compatibility does not imply continued OS security maintenance. Prefer maintained macOS and Node.js LTS versions.

The native Trash binary contains x86_64 and arm64 code. Its build target does not change this product's macOS 26 minimum; see [provenance](../vendor/provenance.json) and [native validation](../CONTRIBUTING.md#dependencies-and-native-artifacts).

The CI matrix selects macOS 26 runners for Apple Silicon and Intel. Each configuration records Node.js, npm, OS, and architecture, then installs dependencies, audits, type-checks, builds, and tests.

## Agent validation cases

The following cases define the CLI versions and scenarios to validate. They are not a report of completed runs or a guarantee for other versions.

| Agent | Validation case | Limits |
|---|---|---|
| Codex | CLI 0.162.1 with a local Responses mock; use app-server to check deletion, retention, backup restoration, and bulk cleanup. Synthetic tests cover known SQLite/index formats. | Cloud models and desktop GUI are outside this case. |
| OpenCode | CLI 1.19.0 using HTTP `noReply` to create conversations/messages; restart upstream to verify selected deletion, retention, backup restoration, and bulk cleanup. Source-derived synthetic cases cover 1.2.27 and 1.19.0. | `noReply` creates no model response. Synthetic tests supply fully populated projection/event tables; do not use real user database dumps. |
| Copilot CLI | CLI 1.0.88 in offline/BYOK mode with a local mock; use resume to check deletion, restoration, and bulk cleanup. Shared lock directories are excluded from conversation lists. | GitHub account sign-in and cloud models are outside this case. |
| Antigravity CLI | CLI 1.3.5 with a local Gemini mock; check selected-deletion refusal, bulk cleanup, and restored IDs/content after manual whole-file restoration. Synthetic tests cover format and concurrent-change guards. | Nonempty shared protobuf summaries block selected deletion. IDE GUI, account sign-in, and cloud models are outside this case. |
| Grok Build CLI | CLI 1.0.52 (`0920c8169e27`) with a local mock; use native session list/export to check deletion, retention, backup restoration, and bulk cleanup. | Cloud models are outside this case. |

Run these CLI cases in isolated synthetic data roots with actual open-file checks. Keep selected data and backups within those roots, then move the roots to macOS Trash. Manual restoration for Codex, Copilot, Grok, and OpenCode requires recovery inspection, manifest ownership, and SHA-256 checks. Antigravity bulk cleanup has no index-rewrite backup; verify whole-file restoration against the operation journal and each moved file's hash. These cases do not provide automatic restoration in the product.

Synthetic fixtures establish behavior for known structures and guards. They do not guarantee every upstream version, processor, or GUI. Use synthetic fixtures rather than real conversation or account data when reproducing these cases.

## Default data roots

Paths are derived from the current user's home directory, without a fixed account name or disk-wide search.

| Agent | Supported roots |
|---|---|
| Codex | `~/.codex`; valid `YYYY-MM-DD` workspace folders directly inside `~/Documents/Codex` for full cleanup |
| Copilot CLI | `~/.copilot` |
| Antigravity | `~/.gemini/antigravity-cli`, `~/.gemini/antigravity-ide` |
| OpenCode | `~/.local/share/opencode`, `~/.local/state/opencode` |
| Grok | `~/.grok` |

Custom roots selected through `CODEX_HOME`, `COPILOT_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, and related variables are restricted to the supported defaults. A mismatch refuses the relevant operation rather than searching elsewhere. OpenCode legacy JSON supports full cleanup of known conversation subdirectories; selected deletion is unsupported.

Codex full cleanup moves direct workspace folders with valid calendar dates in `YYYY-MM-DD` format to Trash, including all contained generated and project files. It preserves the `~/Documents/Codex` root, ordinary named project folders, invalid dates, and date-named files. Selected-conversation deletion does not include these folders. The dated root and its ancestors must be physical directories: relocated or symbolic-link document roots are refused until supported. This scope does not discover other workspace locations on the computer.

## Format-specific refusals

**Antigravity:** CLI 1.3.5 stores titles and other data in shared `jetbox_summaries_proto.pb`. A reliable public schema for per-conversation rewriting is not available. When that file is nonempty in either the CLI or IDE root, or its path cannot be verified, recognizable conversations remain listed but selected deletion is disabled. Checks repeat during execution and before completion to detect rebuilt indexes. For individual deletion, use Antigravity's `/resume` interface, select a conversation, and follow its delete action. The [upstream CLI reference](https://github.com/google-antigravity/antigravity-cli/tree/89081f72e10a98c3689f34b1af7261f43136ab5d) documents F4 and customizable `item.delete` bindings; follow the current interface's displayed key. Full `clean --target antigravity` includes both known protobuf paths, summaries, and CLI `annotations/` while preserving settings and the installation ID. This does not establish support for arbitrary future formats.

**OpenCode:** version 1.19.0 stores credentials and some settings in its database. Full cleanup preserves a mixed database and clears supported conversation tables and session events through a backed-up metadata update. Credentials, accounts, permissions, projects, workspaces, migrations, and verified shared events remain intact. A database containing only conversation data and migration records can still be moved to Trash as a whole. Unknown tables, triggers or views, ambiguous events, unsafe foreign keys, and sidecars without a main database block cleanup. Database changes after preview also block execution. Legacy JSON full cleanup covers `storage/session`, `message`, `part`, `todo`, `session_share`, and `session_diff`; permission, project, and unrecognized storage data are retained. Legacy JSON selected deletion remains unsupported.

**Codex:** unknown databases in the root or `sqlite/`, unknown subdirectories within `sqlite/`, missing required metadata tables/columns, or unsafe ownership block operations. Additional tables inside known databases are not rejected universally; data outside the selected strategy is retained. Structural checks cannot identify every new conversation copy or future index meaning, so successful preflight does not imply compatibility with every version.

Symbolic links, changes since discovery, open files, failed process inspection, and incomplete indexes can also prevent cleanup. Close the selected agents before deletion; open SQLite databases and their WAL, SHM, or journal files are refused. `--allow-running` is retained only for read-only dry runs and is rejected for deletion. A refusal calls for format review, not manual removal of unfamiliar data. Agents may create data again after cleanup.

For unsupported versions, preserve original data, use diagnostics and dry-run to gather minimal information, and report redacted structures or synthetic fixtures. Never upload real conversations or raw databases. See [recovery](recovery.md) for retention and restoration guidance.
