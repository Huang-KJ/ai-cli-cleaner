# Installation and updates

For the usual npm installation, start with [README](../README.md#install). This guide covers prerequisites, source and archive installations, update channels, and removal. The executable is named `ai-cleaner`.

## Requirements

| Component | Requirement |
|---|---|
| Operating system | macOS 26 or later |
| Processor | Intel x64 or Apple Silicon arm64 |
| Node.js | `^22.22.2`, `^24.15.0`, or `^26.0.0` |
| npm | 10, 11, or 12 for installation (the npm bundled with supported Node.js works); development and CI pin 12.2.1 |
| System tools | Executable `/bin/ps` and `/usr/sbin/lsof` |

Install compatible Node.js and npm versions separately, then check them before installing the CLI:

```bash
node --version
npm --version
```

Cleanup and conversation selection, including dry-run, refuse older systems before reading conversations or stopping agents. Help, diagnostics, and read-only recovery queries remain available. See [compatibility](compatibility.md) for storage formats and validation scope.

<a id="install-from-npm"></a>
<a id="update-an-npm-installation"></a>

## npm installation and updates

The package includes compiled code, bundled runtime dependencies, and native helpers; no compiler or source build is required. The `latest` tag always selects the newest published version, including betas; replace it with an exact version such as `0.1.0-beta.1` to pin a release. Add `--engine-strict` to reject unsupported Node.js/npm versions during installation:

```bash
npm install --global --engine-strict ai-cli-cleaner@latest
```

Rerun the install command to update, then run `ai-cleaner --version` and `ai-cleaner doctor --all`. If npm reports a global-prefix permission error, use a Node installation or user-owned prefix with appropriate permissions. Do not run cleanup as an administrator. Continue with the [quick start](../README.md#quick-start) and [recovery guidance](recovery.md).

## Install from source

A source checkout includes the development tools. First obtain it:

```bash
git clone https://github.com/Huang-KJ/ai-cli-cleaner.git
cd ai-cli-cleaner
```

If your supported Node.js installation has an older npm, optionally bootstrap pinned npm 12.2.1 **before** installing dependencies. This downloads and verifies the archive's SHA-512. Choose a new absolute destination that does not exist:

```bash
npm_runtime="$PWD/../ai-cleaner-npm-12.2.1"
node scripts/bootstrap-npm.cjs "$npm_runtime"
export PATH="$npm_runtime/node_modules/.bin:$PATH"
npm --version
```

The PATH change applies to the current shell; this optional tooling directory is separate from the CLI runtime. With npm 12 available, install locked dependencies, build, and install the command:

```bash
npm ci
npm run build
npm install --global .
ai-cleaner --version
ai-cleaner doctor --all
```

Network access is needed unless dependencies are cached. A global local-directory installation may link to the checkout, so retain its directory and built files. To avoid a global installation, replace `ai-cleaner` with `node dist/index.js` after building. `npm run check` runs full validation; a build or local installation alone does not replace it. npm also runs that check through `prepack` when packing the project.

Update a source installation by updating the checkout, reinstalling locked dependencies, and rebuilding:

```bash
git pull --ff-only
npm ci
npm run build
npm install --global .
ai-cleaner --version
```

Review upstream changes before updating a checkout with your own modifications. The built-in updater refuses source checkouts and linked installations; use the source workflow for them.

## Install a release archive

When a maintainer publishes a GitHub release, download its versioned `.tgz` archive and `SHA256SUMS` from [GitHub Releases](https://github.com/Huang-KJ/ai-cli-cleaner/releases) into an empty directory. Verify the checksum, then install the downloaded archive; replace the filename below with the release you selected:

```bash
shasum -a 256 -c SHA256SUMS
npm install --global --engine-strict --ignore-scripts --no-audit --no-fund ./ai-cli-cleaner-0.1.0-beta.1.tgz
ai-cleaner --version
ai-cleaner doctor --all
```

Continue only if verification succeeds. A checksum from the same release detects byte mismatches; it is not an independent signature or proof of authorship. The archive bundles runtime dependencies, native helpers, and documentation, so it does not need a compiler or install scripts. It excludes the development source and tests. With Node.js and npm already installed, the same installation can run offline by adding `--offline`.

For a direct HTTPS archive URL, npm 12 requires the additional `--allow-remote=all` option for that invocation. Downloading and checking the archive first makes the verification step explicit.

## Update checks

`ai-cleaner update` asks the npm registry for the `latest` version and, when it is newer, prints the command that installs it:

```bash
ai-cleaner update
npm install --global --engine-strict ai-cli-cleaner@latest
```

The check sends no credentials, never runs during cleanup, and installs nothing itself. Source checkouts update through the source workflow above.

## Uninstall

```bash
npm uninstall --global ai-cli-cleaner
```

Uninstalling the command retains agent data, Trash items, operation journals, and recovery backups. Keep those copies while recovery is needed. If you dispose of a source checkout or optional npm tooling directory, move it to macOS Trash after confirming that no linked command still depends on it.
