# Installation and updates

Install the beta from npm. The package includes the compiled CLI, bundled runtime dependencies, native helpers, and documentation; no source build or compiler is required. The executable is named `ai-cleaner`.

## Requirements

| Component | Requirement |
|---|---|
| Operating system | macOS 26 or later |
| Processor | Intel x64 or Apple Silicon arm64 |
| Node.js | `^22.22.2`, `^24.15.0`, or `^26.0.0` |
| npm | 12.x; development and CI pin 12.2.0 |
| System tools | Executable `/bin/ps` and `/usr/sbin/lsof` |

Install compatible Node.js and npm versions separately, then check them before installing the CLI:

```bash
node --version
npm --version
```

Cleanup and conversation selection, including dry-run, refuse older systems before reading conversations or stopping agents. Help, diagnostics, and read-only recovery queries remain available. See [compatibility](compatibility.md) for storage formats and validation scope.

## Install from npm

```bash
npm install --global ai-cli-cleaner@beta
ai-cleaner --version
ai-cleaner doctor --all
```

The `beta` tag selects the published beta version. To install this version explicitly, use `npm install --global ai-cli-cleaner@0.1.0-beta.1`. The package declares its supported Node.js/npm versions; add `--engine-strict` if you want npm to reject unsupported versions during installation:

```bash
npm install --global --engine-strict ai-cli-cleaner@beta
```

If npm reports a global-prefix permission error, use a Node installation or user-owned prefix with appropriate permissions. Do not run cleanup as an administrator. Continue with the [quick start](../README.md#quick-start), and read [recovery](recovery.md) before deleting important data.

## Update an npm installation

Rerun the installation command to get the version selected by the npm `beta` tag:

```bash
npm install --global ai-cli-cleaner@beta
ai-cleaner --version
```

The built-in `ai-cleaner update` command checks GitHub releases, not the npm registry or npm dist-tags. npm publication does not create GitHub release assets. Use the npm command above for npm beta updates.

## Install from source

A source checkout provides an alternative installation and the development tools:

```bash
git clone https://github.com/Huang-KJ/ai-cli-cleaner.git
cd ai-cli-cleaner
npm ci
npm run build
npm install --global .
ai-cleaner --version
ai-cleaner doctor --all
```

`npm ci` installs the lockfile's development and runtime dependencies. `npm run build` compiles the CLI. Installing a local directory globally can link the command to the checkout, so retain that checkout and its built files. This installation requires network access to fetch dependencies unless they are already cached.

If your supported Node.js installation has an older npm, the checkout includes an optional bootstrap that downloads the pinned npm 12.2.0 archive and verifies its SHA-512 before extracting it. Choose a new absolute destination that does not already exist:

```bash
npm_runtime="$PWD/../ai-cleaner-npm-12.2.0"
node scripts/bootstrap-npm.cjs "$npm_runtime"
export PATH="$npm_runtime/node_modules/.bin:$PATH"
npm --version
```

Run this from the cloned repository before `npm ci`. The PATH change applies to the current shell. The example keeps this tooling directory beside the checkout; it is not part of the CLI runtime. You can instead use an existing npm 12 installation.

To use the CLI without a global installation after building:

```bash
node dist/index.js --help
node dist/index.js doctor --all
```

Replace `ai-cleaner` with `node dist/index.js` in command examples when running from the checkout. The package's `prepack` script runs `npm run check` when npm packs the project. A successful build or local-directory installation does not replace that full validation. For development checks, run `npm run check`.

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

## Built-in release updates

For npm beta updates, use [the npm installation command](#update-an-npm-installation). The commands below require public, published GitHub releases. They do not use npm dist-tags or private repository credentials. Check without installing:

```bash
ai-cleaner update
```

Install a newer GitHub release explicitly:

```bash
ai-cleaner update --install
```

The default channel is stable. Add `--prerelease` to either command to include published GitHub betas. Draft releases are excluded. Cleanup never performs background update checks.

The updater verifies the selected archive against its release checksum before invoking npm. Self-update requires a regular global installation, a writable owning prefix, and npm 12 installed in that prefix or alongside the running Node.js. It uses the running Node.js and a fixed npm location instead of trusting `PATH` or inherited npm configuration. Toolchain ownership and write-permission checks apply. It refuses source checkouts, linked installations, administrator execution, reinstalls, and downgrades. Temporary downloads move to macOS Trash afterward.

A missing release, network failure, invalid toolchain, or failed verification stops this update route. You can always download and verify an available release archive manually.

## Uninstall

```bash
npm uninstall --global ai-cli-cleaner
```

Uninstalling the command retains agent data, Trash items, operation journals, and recovery backups. Keep those copies while recovery is needed. If you dispose of a source checkout or optional npm tooling directory, move it to macOS Trash after confirming that no linked command still depends on it.
