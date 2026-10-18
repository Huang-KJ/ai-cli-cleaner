# Releasing

Release artifacts contain the compiled CLI, bundled runtime dependencies, documentation, native helpers, and licenses. Source installation remains available independently of npm or GitHub release publication. Use a supported macOS/Node.js/npm environment from the [installation guide](installation.md).

## Version and channels

Keep `package.json` and the lockfile's root metadata at the same version. Tags use `v` followed by the exact SemVer, including any prerelease or build identifier. Packaging and the updater share validation in `lib/version.cjs`.

A SemVer prerelease produces a prerelease GitHub Draft; a stable version produces a stable Draft. npm dist-tags are separate: `publishConfig` currently selects the public npm registry, public access, and the `beta` tag. For a stable publication, review and update that channel explicitly before using `latest`.

## Verify and package

```bash
npm ci
npm run release:pack
```

`release:pack` validates release metadata, verifies native artifacts, audits dependencies, and runs the full type/build/test check before packing. A failed audit, invalid report, or high/critical advisory stops packaging. The command writes a versioned `.tgz` and `release/SHA256SUMS`; previous artifacts are moved to macOS Trash before replacement.

Inspect the package boundary and verify checksums from `release/`, where the named archive resides. Substitute the current version in archive commands:

```bash
cd release
shasum -a 256 -c SHA256SUMS
tar -tzf ai-cli-cleaner-0.1.0-beta.1.tgz
```

The package allowlist and package-contract tests cover compiled files, bundled dependency versions, native artifacts, licenses, and documentation. They also install the actual archive globally with an empty npm cache in offline mode and run non-destructive commands. The archive excludes tests, maintenance scripts, and development dependencies. The project-owned native claim helper's source is included for inspection.

`npm ci` follows the lockfile; bundled runtime dependencies preserve the verified versions in the release archive. Publish the verified archive rather than repacking a working directory. Any shipped-file change requires rebuilding and checking the archive again. Checksums establish byte integrity, not independent author authentication.

## GitHub release workflow

The [release workflow](../.github/workflows/release.yml) responds to `v*` tags and calls `release:pack`, then `scripts/draft-release.mjs`. It attaches the archive and `SHA256SUMS` to an unpublished Draft whose version, channel, and target commit match the tag. Same-tag jobs are serialized. Published, ambiguous, or mismatched existing releases stop the workflow.

Before publishing a Draft, verify its tag, target commit, channel, downloaded assets, and checksums. Require the complete [CI matrix](../.github/workflows/ci.yml) for that commit; packaging on one runner does not replace it. Review [compatibility](compatibility.md), [recovery](recovery.md), and the [security policy](../SECURITY.md). The workflow neither publishes the Draft nor runs `npm publish`.

The updater uses public, published GitHub releases. Stable is the default channel; prereleases require `--prerelease`, and Drafts are excluded. Validate a real archive installation and an explicit update against published assets before announcing that route as available.

## npm publication

Confirm package ownership, registry, version, access, and dist-tag. Authenticate interactively; keep credentials and one-time codes out of files, commands, and reports. From the project root, preview the exact archive:

```bash
npm publish ./release/ai-cli-cleaner-0.1.0-beta.1.tgz --tag beta --access public --dry-run
```

Review its file list and metadata, then publish the same verified archive:

```bash
npm publish ./release/ai-cli-cleaner-0.1.0-beta.1.tgz --tag beta --access public
```

A dry run does not prove registry ownership or publication success. A published name/version cannot be reused with different bytes. Verify the registry's version, dist-tag, integrity, and a real installation before announcing availability. npm publication does not create GitHub release assets or make the built-in updater available. No automated npm publishing workflow is configured.

## Publication review

Review source and package contents for private data, credentials, conversations, raw databases, unredacted logs, personal paths, and local reports. Review any Git history, source archives, Actions logs/artifacts, discussions, and release assets that will become public; `.gitignore` and the package allowlist do not remove previously tracked content. Preserve valid attribution and native provenance.

Confirm that [private vulnerability reporting](https://github.com/Huang-KJ/ai-cli-cleaner/security/advisories/new) works and the maintainer receives reports. Keep sensitive security findings out of public issues. Repository visibility changes and publication follow the maintainer's authorization; do not announce an unavailable package, release, or update route.
