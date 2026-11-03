# Releasing

Release artifacts contain the compiled CLI, bundled runtime dependencies, documentation, native helpers, and licenses. Source installation remains available independently of npm or GitHub release publication. Use a supported macOS/Node.js/npm environment from the [installation guide](installation.md).

## Version and channels

Keep `package.json` and the lockfile's root metadata at the same version. Tags use `v` followed by the exact SemVer, including any prerelease or build identifier. Packaging and the updater share validation in `lib/version.cjs`.

A SemVer prerelease produces a prerelease GitHub Draft; a stable version produces a stable Draft. npm dist-tags are separate: `publishConfig` selects the public npm registry, public access, and the `latest` tag, so every npm publication, prereleases included, becomes the default `npm install` version. The `beta` dist-tag is no longer updated.

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

## Release workflow

Pushing a `v*` tag runs the [release workflow](../.github/workflows/release.yml); same-tag runs are serialized. Push the tag only after the complete [CI matrix](../.github/workflows/ci.yml) passes for that commit, and after reviewing [compatibility](compatibility.md), [recovery](recovery.md), and the [security policy](../SECURITY.md).

1. `draft-release` runs `npm ci` and `release:pack`, then `scripts/draft-release.mjs` attaches the archive and `SHA256SUMS` to an unpublished Draft whose version, channel, and target commit match the tag. Published, ambiguous, or mismatched existing releases stop the workflow.
2. `publish` is the only job with an npm OIDC token. It installs no project dependencies; `scripts/publish-release.mjs` checks the archive against `SHA256SUMS`, publishes those exact bytes to npm under `latest` with provenance, and then publishes the Draft. The remote tag is re-verified before each write. A rerun skips npm when the registry already has identical bytes and stops if they differ.

`ai-cleaner update` reports the npm `latest` version and the npm command that installs it. The built-in updater of 0.1.0-beta.6 and earlier still reads published GitHub releases, so every release is also published there.

## npm trusted publishing

npm accepts the workflow's OIDC token only after the package's trusted publisher is configured on npmjs.com (package settings → Trusted publishing): GitHub Actions, owner `Huang-KJ`, repository `ai-cli-cleaner`, workflow `release.yml`, no environment. Trusted publishing needs npm 11.5.1 or later, which the pinned npm satisfies. After it works, set the package's publishing access to require two-factor authentication and disallow tokens.

If the publish job fails, the Draft stays unpublished. Fix the cause and rerun the failed job. For a manual fallback, authenticate interactively, keep credentials and one-time codes out of files, commands, and reports, and publish the verified archive downloaded from the Draft:

```bash
npm publish ./release/ai-cli-cleaner-0.1.0-beta.1.tgz --tag latest --access public
```

A published name/version cannot be reused with different bytes. Verify the registry's version, dist-tag, integrity, and a real installation before announcing availability.

## Publication review

Review source and package contents for private data, credentials, conversations, raw databases, unredacted logs, personal paths, and local reports. Review any Git history, source archives, Actions logs/artifacts, discussions, and release assets that will become public; `.gitignore` and the package allowlist do not remove previously tracked content. Preserve valid attribution and native provenance.

Confirm that [private vulnerability reporting](https://github.com/Huang-KJ/ai-cli-cleaner/security/advisories/new) works and the maintainer receives reports. Keep sensitive security findings out of public issues. Repository visibility changes and publication follow the maintainer's authorization; do not announce an unavailable package, release, or update route.
