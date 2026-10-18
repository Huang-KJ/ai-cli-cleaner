# Security policy

AI CLI Cleaner operates on local conversation data. Never include private conversations, indexes, account data, full personal paths, credentials, or unredacted logs in a report.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Huang-KJ/ai-cli-cleaner/security/advisories/new) to submit a report to the maintainers. You can also open **Security → Advisories → Report a vulnerability** in the repository.

If that route is unavailable, ask the maintainer for a restricted channel before sharing vulnerability details. Do not post exploitable details or sensitive data in public Issues.

A useful report includes the affected release, macOS/Node.js versions, synthetic reproduction steps, expected and actual behavior, and minimal redacted output. Maintainers should establish impact and reproduction conditions before sharing remediation status under the agreed disclosure scope.

For data-operation refusals or compatibility problems, preserve original data and follow [recovery guidance](docs/recovery.md). General issues must still omit real conversation content.

## Supported scope and retained data

This is beta software. Supported formats, validation cases, and limits are documented in [compatibility](docs/compatibility.md); there is no security-support commitment for other versions.

Cleanup and recovery data remain local. Operation journals contain paths and IDs, use `0700`/`0600` permissions, and are not uploaded automatically. Trash, backups, and preflight copies may retain sensitive data. Moving data to Trash is not secure erasure. Doctor JSON omits raw HOME values and process command lines; recovery inspection can contain full paths.

Update checks are explicit network operations against public GitHub releases. The updater does not read GitHub tokens or agent conversations and does not run during cleanup. Review and install an update explicitly. Checksums from a release detect byte mismatches but do not provide independent author authentication.

## Dependency policy

Review dependency alerts alongside the lockfile audit; an empty alert list does not replace release checks.

`scripts/audit-dependencies.cjs` has no advisory exceptions. Any high/critical advisory, invalid report, or failed audit blocks the check. The [dependency workflow](.github/workflows/dependency-audit.yml) runs scheduled and manual checks. Consult its results for the revision under review. A passing audit does not establish that the project or its dependencies are vulnerability-free.

The release bundles the native Trash binary, its complete MIT license, and [provenance](vendor/provenance.json). `lib/native-helper.cjs` verifies the pinned local artifact before use. Ordinary `npm audit` does not cover that binary and cannot replace native-source or security review. The weekly dependency workflow checks pinned upstream source and hashes; maintainers must also review current upstream security notices, release notes, and version differences. Native updates require Trash and release-package validation as described in [development](CONTRIBUTING.md).

The release also includes the project-owned claim helper, its [source](native/claims.m), and [provenance](vendor/claims-provenance.json). `lib/claim-helper.cjs` verifies the pinned executable and source before use. It moves approved objects into private recovery storage with descriptor-relative operations before Trash or private-copy metadata mutation. This boundary assumes an attacker can modify provider storage but cannot modify the cleaner's private `0700` recovery storage or installed code; it does not isolate arbitrary malicious code running as the same user.
