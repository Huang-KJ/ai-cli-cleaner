# Recovery and data handling

AI CLI Cleaner acts on local data only. It cannot delete provider-side cloud copies. Selected files are moved to macOS Trash, and supported index updates create separate backups. Trash items and index backups serve different purposes. Recovery is manual; the tool does not promise complete restoration for every agent version or data format.

## Review the scope first

Full `clean` covers more than conversation text. For Codex, it can include conversations and indexes, attachments, voice records, goals, queues, generated images, visualizations, logs, and execution snapshots. Other agents may have temporary work data, HTML output, caches, or snapshots. Supported memory stores are retained by default, including with `--all`; `--include-memories` explicitly includes them. Retained memories may still contain information from deleted conversations. See [memory preservation](compatibility.md#memory-preservation) for bulk and selected-deletion boundaries.

Codex full cleanup also moves valid `YYYY-MM-DD` directories directly inside `~/Documents/Codex` to Trash, including project source files and all other contents, and removes that root's `.DS_Store` Finder metadata. Selected-conversation deletion excludes these workspace directories. Read the actual preview and confirmation scope.

`doctor` does not read conversation content or change data. A dry run does not delete original data or stop agents. Provider SQLite data is read through private temporary copies without opening SQLite connections to the original files; SQLite may create WAL/SHM files within those copies. Temporary copies may contain private information and are moved to Trash after use. Trash retains data; it is not secure erasure.

Codex bulk preflight permits read-coordination changes confined to an existing, same-sized SHM file with the same filesystem identity. Main databases, WAL contents, and rollback journals still require an unchanged snapshot, and open files still block cleanup. Private read snapshots rebuild their SHM from the copied database and WAL instead of copying the mutable source SHM. File replacement, changed links or permissions, and added or missing sidecars remain reasons to stop.

Close the selected agents before deletion. `--allow-running` cannot bypass process or open-file checks and is rejected for deletion; read-only dry runs remain available while agents run. If a database or sidecar reopens during cleanup, preserve any recovery records and inspect the reported result before retrying.

## Inspect an operation

```bash
ai-cleaner recovery list
ai-cleaner recovery list --json
ai-cleaner recovery list --timezone Asia/Taipei
ai-cleaner recovery inspect <id>
ai-cleaner recovery inspect <id> --json
```

`list` shows the operation ID, start time, targets, kind, and status. Use a UUID from that list with `inspect` to check the record, backup integrity, and manual recovery instructions. Inspection does not rerun deletion. JSON timestamps remain in ISO format; human-readable lists default to the system time zone. Inspection can display full data paths, so redact its output before sharing it.

Journals are stored in `~/.ai-cli-cleaner/operations/`, with directory permissions `0700` and file permissions `0600`. They contain paths and operation IDs and are not uploaded automatically. Use the backup locations shown by inspection; a filename alone does not establish ownership.

| Status | Meaning and next step |
|---|---|
| `succeeded` | The operation completed. Keep Trash items and backups as long as recovery is needed. |
| `failed` | A known failure occurred. Check the record and current source state. |
| `partial` | Some changes occurred. Preserve the current state and inspect each affected item. |
| `incomplete` | The process was interrupted or the journal was not completed. Do not treat this as success. |

Fields such as `uncertainPaths` and `possibly-partial` indicate unresolved results. A missing source path does not prove that its destination in Trash was confirmed. Inspect macOS Trash manually rather than assuming that path disappearance establishes recoverability.

Inspection also lists linked private claims under `~/.ai-cli-cleaner/recovery/`. Each `claim.json` records the original `source`, its `slot` inside the claim's `original/` directory, and the claim state. The operation journal links this directory before the first source is moved. A `held`, `partial`, or interrupted `claiming` or `publishing` state requires manual inspection; preserve the whole directory and every current source. A source may have left its original location while its original bytes are still held locally and have not reached Trash.

## Restore manually

Close the relevant agents and CLIs first. Preserve current source data, operation records, and backups before deciding what to restore. Do not overwrite a current index with an older backup: new conversations or indexes may have been created since cleanup. Archive the current state, compare times and ownership, then merge or restore the intended items manually.

Files reach Trash through a private holding directory. Finder's **Put Back** may restore an item to that holding directory with its numbered slot name, rather than to the provider's original path. Use the operation's linked `claim.json` source-to-slot mapping to identify the original, verify its identity and available backup hashes, then restore it manually to the recorded `source` only after preserving any newer object there. For SQLite, inspect and restore the complete approved database and sidecar group together. A successful Trash move does not promise automatic restoration to the original provider path.

Before restoring SQLite data, preserve the current database together with its `-wal`, `-shm`, and `-journal` files and close all connections. Do not mix a main database and sidecars from different times. If an integrity or ownership check fails, preserve the evidence; changing the journal or deleting sidecars to bypass the check can make recovery harder.

Sensitive content may remain in Trash, backups, and preflight copies. Once you have checked the outcome and no longer need recovery, handle those retained copies according to your own retention policy. AI CLI Cleaner never automatically empties Trash or erases backups.
