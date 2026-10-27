# Contributing

Read the [compatibility guide](docs/compatibility.md) and [security policy](SECURITY.md) before changing data operations.

## Report an issue

Use [GitHub Issues](https://github.com/Huang-KJ/ai-cli-cleaner/issues) and the relevant template for reproducible bugs or feature requests. Include the CLI and agent versions, a minimal command sequence, expected and actual behavior, and redacted output.

Use synthetic examples. Do not attach real conversations, raw databases, complete logs, full personal paths, account identifiers, or secrets. Report vulnerabilities according to [SECURITY.md](SECURITY.md), rather than disclosing exploitable details in a general issue.

## Develop a change

Work from a repository checkout or source archive. The release tarball contains compiled code, documentation, bundled runtime dependencies, and native provenance rather than the development tree. Use a Node.js version supported by `package.json` and npm 12.x; the [installation guide](docs/installation.md#requirements) includes the pinned npm bootstrap.

```bash
npm ci
npm run check
node scripts/audit-dependencies.cjs
node lib/native-helper.cjs
node lib/claim-helper.cjs
```

`npm run check` runs type checking and the complete test suite, including a build. Start with relevant behavior tests while editing, then complete the full check before delivery or packaging. Use synthetic fixtures for ownership, concurrent changes, unknown schemas, partial moves, and recovery records. Never use real conversations, accounts, or user databases as fixtures.

CLI tests share output collectors and dependency defaults in [tests/helpers/cli.ts](tests/helpers/cli.ts). Unexpected scans, conversation discovery/deletion, and agent shutdown throw by default. Override only the dependencies a case needs, and retain explicit assertions for confirmation, process guards, and output channels.

Run the built CLI from the checkout with `node dist/index.js --help`. Use `npm run build` when you only need to rebuild. Development setup does not install a global command. `npm install --global .` can link a command to the checkout; retain the checkout and rebuild after source changes. The built-in updater requires a regular global archive installation and refuses source checkouts or links.

When contributing through GitHub, create a focused branch from `main` in a checkout or fork you can access. Open a pull request with the problem, resulting behavior, compatibility implications, and actual validation results. Run `npm run check` and the dependency audit before requesting review; use the upstream acceptance tests when a changed format or data flow needs them.

Keep changes focused on a concrete problem and preserve ownership, path, index, process, and recovery checks. Destructive tests must use synthetic fixtures and the isolated fixture sink. Never derive fixtures from private conversations or personal databases. Keep private test reports and unredacted logs out of Git.

## Test data and Trash

Ordinary tests use isolated fixtures. Vitest creates a private fixture sink under the OS temporary directory and, after all test files finish, verifies its path and filesystem identity before moving only that sink to macOS Trash with the verified native helper. If validation or Trash cleanup fails, the test run fails and reports the path to inspect. Never use a real data root as a fixture sink.

To manage a sink yourself, set `AI_CLEANER_FIXTURE_TRASH` to an existing physical directory directly inside the OS temporary directory whose name starts with `ai-cleaner-fixture-trash-`. Vitest validates and uses that directory but leaves it untouched; the caller owns its cleanup. A forced `SIGKILL` can prevent global teardown and leave an automatically created `ai-cleaner-fixture-trash-*` directory in the temporary directory.

```bash
npm run verify:trash -- --run
```

This opt-in test creates synthetic files and exercises the native helper against real macOS Trash. `--run` explicitly enables those actions; it is not a read-only check.

## Runtime matrix

The [CI configuration](.github/workflows/ci.yml) defines seven checks on macOS 26, covering the engines minimums and Node.js 22, 24, and 26 lines, including Intel with Node.js 24. It runs on pushes to `main` and `v*` tags, pull requests, and manual `workflow_dispatch` requests. Feature and Dependabot branches use the pull-request run without a duplicate push run.

To run one configuration locally, select a supported Node.js version and npm 12.2.0, then run `npm ci` and `npm run check`. A local pass does not replace the full matrix. Verify the exact code, OS, runtime, architecture, and result for each run; a workflow definition alone is not execution evidence.

## Real upstream CLI validation

```bash
npm run build
node scripts/verify-upstream.mjs
node scripts/verify-upstream.mjs --run --provider=codex,copilot,grok
```

Without `--run`, the script displays usage. With it, the script validates installed Codex, Copilot, and Grok CLIs by default. Select providers with `--provider=codex,copilot,grok,opencode,antigravity`; OpenCode also requires `--opencode-bin=/absolute/path/to/opencode`. The script does not install or upgrade agents.

Each case creates conversations in new isolated data roots using a local mock model or OpenCode's `noReply` API. It checks discovery, selected deletion, upstream rereading, and manual restoration after backup inspection. These tests do not use existing accounts or real conversations and do not validate cloud models or desktop GUIs. Test-only restoration does not add automatic recovery to the product.

The Antigravity case requires the verified 1.3.5 binary SHA-256. It uses the official Gemini provider configuration, a fabricated API key, and a loopback model endpoint. Its proxy rejects external CONNECT requests; this is not an OS-level network isolation guarantee. The case checks selected-deletion refusal, bulk movement, and manual Trash restoration after per-file hash verification. It does not rewrite protobuf summaries or create index-rewrite backups. Upstream may return `SUCCESS` for a nonexistent ID while creating another conversation, so verification must also check IDs, warnings, and whether the original synthetic content reached model context.

## Controlled benchmarks

```bash
npm run build
node scripts/benchmark.mjs --sizes 1000,10000 --selected 100
```

The benchmark generates deterministic synthetic Codex data and measures inventory, preflight, directory snapshots, and selected deletion. It checks all retained data, recovery copies, and operation records. Timing covers core operations: open-file checks use controlled responses, and selected files and backups move within isolated storage. It does not measure complete CLI costs including `ps`, `lsof`, and macOS Trash. Results go to the terminal by default; use `--output` only when a retained benchmark is useful. A synthetic scale test is not a real-use performance guarantee.

## Data-operation boundaries

Confirmation prompts, process guards, and ownership/index checks have distinct responsibilities. A new deletion entry point must use the runtime guards, operation journal, and Trash wrapper. A confirmation prompt alone is insufficient. Deletion requires stopped agents; `--allow-running` is rejected for mutation and retained only for read-only previews. Open databases and SQLite sidecars must never bypass file or index checks.

Memory preservation is the default in both public commands and core APIs. Only explicit `includeMemories: true` may include supported memory stores or selected memory records. Keep discovery, preview, confirmation, movement, metadata changes, and completion checks aligned with that policy; `--all`, `--yes`, and `--force-stop` must not opt in. For mixed directory trees such as Claude projects, preserve memory children without moving their parent, and revalidate preserved boundaries before every move. Use synthetic fixtures to verify byte-for-byte retention and opt-in deletion.

Codex's dated workspace scope is limited to valid calendar-date directories named `YYYY-MM-DD` directly inside the current user's `~/Documents/Codex`. Preserve the root, ordinary named projects, and date-named files; refuse symbolic-link or redirected roots. Keep this scope out of selected deletion, and retain plan snapshots, open-file checks, revalidation before movement, the journal, and Trash handling. Use synthetic homes for date validity, retained siblings, and concurrent-change fixtures.

Keep journal directory/file permissions at `0700`/`0600` and stop operations when journal writes fail. Read-only diagnostics must not read conversations or execute agent binaries; doctor JSON must omit raw HOME values and process command lines. Refuse unknown formats until source evidence and synthetic fixtures establish support.

English is the default for user-facing output and repository documentation. Keep JSON keys, command names, operation kinds, IDs, data formats, and on-disk metadata stable when changing presentation. Code comments remain concise Traditional Chinese under the project contribution instructions.

### Shared implementation rules

[conversations/opencode.ts](src/conversations/opencode.ts) owns both selected-deletion metadata rules and the bulk-cleanup guard. Keep the guard checks before preview, execution, and movement, including preservation of supported account/configuration data and refusal of unknown tables or orphaned sidecars.

[codex-inventory.ts](src/conversations/codex-inventory.ts) defines supported Codex SQLite tables, ID columns, required columns, and host rules for discovery, validation, deletion, and recovery guards. Keep these consumers aligned. Preserve explicit handling for spawn edges with two thread IDs and migration records linked through a selected thread's rollout path. Local and remote rows must remain isolated, including App tables where the host column is optional.

[metadata-jsonl.ts](src/conversations/metadata-jsonl.ts) provides strict validation and filtered rewrites for Codex and Antigravity mutation paths. Parse every nonempty row before writing; preserve retained row text and leave the file untouched when no row is removed. Use the existing atomic rewrite and change notification hooks. Discovery may tolerate damaged data to display a disabled conversation; mutation must still reject it.

[fs/paths.ts](src/fs/paths.ts) shares SQLite base/sidecar matching and filesystem traversal. Keep sidecar matching limited to supported suffixes and cleanup groups scoped by provider and database. Size estimates may treat disappearing paths as zero, but snapshots must reject disappearing children and retain deterministic fingerprints. Neither mode follows symbolic links. Sharing traversal or schema rules must preserve the separate ownership, preflight, backup, transaction, and completion checks around mutations.

## Dependencies and native artifacts

Follow [SECURITY.md](SECURITY.md) for audit policy and reporting.

The project-owned claim helper is built from `native/claims.m`. After changing its source, run `npm run native:build` on macOS to rebuild the bundled Intel/Apple Silicon universal executable and update its pinned source and binary hashes. `node lib/claim-helper.cjs` verifies both hashes without executing the helper. Keep the source, executable, provenance, and verifier in the release; users do not need a compiler. Validate descriptor-relative claims, refusal and rollback, private-copy publication, the Trash boundary, and offline package installation after any native change.

Keep `@types/node` on the oldest supported Node.js major, currently 22, so type checking does not encourage APIs unavailable to supported users. Dependabot skips major updates for this package while continuing to propose minor and patch updates. Revisit the rule when raising the runtime minimum; passing CI alone is not a reason to widen the type surface.

The native Trash helper is `vendor/macos-trash` version 3.0.0. Its pinned upstream commit and SHA-256 are in [vendor/provenance.json](vendor/provenance.json); its complete MIT license is [vendor/license](vendor/license). Review [upstream releases](https://github.com/sindresorhus/macos-trash/releases), source, compatibility, and security implications before replacing the pinned binary.

`node lib/native-helper.cjs` checks the local binary's hash, size, executable permission, and license without downloading or executing it. Add `--upstream` to verify the pinned official tag/commit, release asset/archive, and license hashes in memory and report the latest version. It does not execute unknown binaries or change files. Ordinary `npm audit` does not cover vendored binaries. Source/hash verification is not a current advisory audit: maintainers must also review upstream security notices, release notes, and source changes. Native updates require updated provenance, license and hashes, synthetic Trash tests, platform CI, and offline package validation.

The Dependabot configuration schedules weekly npm and GitHub Actions update proposals. The dependency-audit workflow is configured for Mondays at 09:17 UTC+8 and manual dispatch. It audits the lockfile and verifies the native source using Linux, Node.js, and source files, without installing macOS runtime packages or running cleanup. Its GitHub token is restricted to the native-source API check; the product's public updater does not need credentials. Consult workflow results for the relevant revision; configuration alone is not a successful run. Updates require compatibility and package validation and are not merged or published automatically.

## Prepare a release

```bash
npm run release:pack
```

Packaging verifies the native artifact and dependency audit first, then runs the complete check and writes the versioned archive and `release/SHA256SUMS`. Package contract tests inspect bundled dependency versions and native files, install the actual archive globally with an empty npm cache in offline mode, and run non-destructive commands. See [releasing](docs/releasing.md) for version, tag, publication review, and Draft channel checks.

The tag workflow only creates or updates an unpublished Draft. Stable versions remain stable-channel drafts; versions with a SemVer prerelease identifier are marked as prereleases. Publishing a release or changing repository visibility requires the maintainer's explicit authorization.
