import { Command, CommanderError } from "commander";
import prettyBytes from "pretty-bytes";
import { getProviderName as providerName, manifests, parseTargets } from "./cleaners/manifests.js";
import type { CleanPlan } from "./cleaners/plan.js";
import type { ProviderId } from "./cleaners/types.js";
import type {
  ConversationDeleteResult,
  ConversationDiscovery,
  ConversationRecord
} from "./conversations/types.js";
import type { OperationInspection, OperationSummary } from "./recovery/operations.js";
import { displayJson, displayText } from "./ui/display.js";
import type {
  ConversationAgentPromptOptions,
  ConversationCheckboxPromptOptions,
  ConversationConfirmPromptOptions
} from "./ui/conversation-prompts.js";
import { assertSupportedPlatform } from "./platform.js";
import type { UpdateResult } from "./update.js";

export interface CliDependencies {
  isInteractive?: () => boolean;
  confirm: (options: ConversationConfirmPromptOptions) => Promise<boolean>;
  selectAgent: (options: ConversationAgentPromptOptions) => Promise<ProviderId | undefined>;
  checkbox: (options: ConversationCheckboxPromptOptions) => Promise<string[] | undefined>;
  assertSupportedPlatform?: () => void | Promise<void>;
  assertAgentsStopped?: (targets: ProviderId[]) => Promise<void>;
  doctor?: (targets: ProviderId[]) => Promise<{ ok: boolean; checks: { id: string; ok: boolean; message: string }[]; agents: unknown[] }>;
  listRecovery?: () => Promise<OperationSummary[]>;
  inspectRecovery?: (id: string) => Promise<OperationInspection>;
  stopAgents?: (targets: ProviderId[]) => Promise<void>;
  checkForUpdate?: (options: { currentVersion: string; prerelease: boolean }) => Promise<UpdateResult>;
  installUpdate?: (release: UpdateResult) => Promise<void>;
  prepareClean: (targets: ProviderId[], options: { includeMemories: boolean }) => Promise<CleanPlan>;
  discoverConversations: (targets: ProviderId[], options: { includeMemories: boolean }) => Promise<ConversationDiscovery>;
  deleteConversations: (
    conversations: ConversationRecord[],
    options: { dryRun: boolean; includeMemories: boolean }
  ) => Promise<ConversationDeleteResult>;
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export async function runCli(
  argv: string[],
  version: string,
  dependencies: CliDependencies
): Promise<number> {
  let exitCode = 0;
  let commanderErrorOutput = "";
  const fail = (error: unknown): void => {
    if (error instanceof Error && error.name === "ExitPromptError") {
      dependencies.error("Operation interrupted.");
      exitCode = 130;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const recoveryPath = error && typeof error === "object" && "recoveryPath" in error
      && typeof error.recoveryPath === "string" ? error.recoveryPath : undefined;
    dependencies.error(`${displayText(message)}${recoveryPath ? `\nRecovery data: ${displayText(recoveryPath)}` : ""}`);
    exitCode = 1;
  };
  const program = new Command();
  const assertPlatform = dependencies.assertSupportedPlatform ?? assertSupportedPlatform;
  const requireTerminal = (message: string): void => {
    if (!(dependencies.isInteractive?.() ?? Boolean(process.stdin.isTTY && process.stderr.isTTY))) {
      throw new Error(message);
    }
  };
  program.exitOverride();
  program.configureOutput({
    writeOut: (message) => dependencies.log(message.trimEnd()),
    writeErr: (message) => { commanderErrorOutput += message; }
  });
  program.name("ai-cleaner")
    .description("Clean up local AI agent conversations and related data.")
    .version(version);

  program.command("clean")
    .description("Move conversations and related data to Trash; keep memories by default.")
    .option("--all", "Clean up every supported agent; keep memories unless explicitly included.")
    .option("-t, --target <targets>", targetHelp())
    .option("--dry-run", "Preview the cleanup plan without deleting original data.", false)
    .option("--include-memories", "Also move supported memory stores to Trash.", false)
    .option("-v, --verbose", "Show the full cleanup scope, paths, and index updates.", false)
    .option("--force-stop", "Stop selected agents first; may close their desktop apps.", false)
    .option("-y, --yes", "Skip stop-agent and cleanup confirmation prompts.", false)
    .action(async (options: { all?: boolean; target?: string; dryRun: boolean; includeMemories: boolean; verbose: boolean; forceStop: boolean; yes: boolean }) => {
      await assertPlatform();
      if (options.all && options.target !== undefined) throw new Error("Use either --all or --target, not both.");
      if (!options.all && options.target === undefined) throw new Error("Specify --all or --target to choose what to clean up.");
      const targets = options.all ? manifests.map((manifest) => manifest.id) : parseTargets(options.target)!;
      if (!options.dryRun && !options.yes) {
        requireTerminal("Cleanup confirmation requires an interactive terminal. Use --dry-run to preview, or --yes to explicitly authorize non-interactive cleanup.");
      }
      dependencies.log(`Agents: ${targets.join(", ")}`);
      dependencies.log(memoryNotice(options.includeMemories));
      if (!options.verbose) dependencies.log("Details: add --verbose; use --dry-run to preview.");
      if (options.forceStop && !options.dryRun) {
        if (!dependencies.stopAgents) throw new Error("Stopping agents is not available in this environment.");
        if (!options.yes && !await dependencies.confirm({
          message: `Stop selected agents?${stopImpact(targets)}`
        })) {
          dependencies.log("Agent shutdown cancelled; cleanup has not started.");
          return;
        }
        dependencies.log("Stopping agents…");
        await dependencies.stopAgents(targets);
      } else if (options.forceStop) {
        dependencies.log("Dry-run does not stop running agents.");
      }
      if (!options.dryRun) await dependencies.assertAgentsStopped?.(targets);
      if (options.verbose) dependencies.log(`Cleanup scope: ${cleanScope(targets, options.includeMemories)}`);
      dependencies.log("Checking cleanup data…");
      const plan = await dependencies.prepareClean(targets, { includeMemories: options.includeMemories });
      const entries = plan.entries.filter((entry) => entry.exists);
      if (!entries.length && plan.operations.length === 0) {
        dependencies.log("No conversation data to clean up.");
        return;
      }
      const bytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
      dependencies.log(`Cleanup: ${entries.length} items (${prettyBytes(bytes)}), ${plan.operations.length} index updates.`);
      if (entries.some((entry) => entry.providerId === "codex" && entry.pattern === "~/Documents/Codex")) {
        dependencies.warn("Includes ~/Documents/Codex/YYYY-MM-DD folders and all files inside, including project files.");
      }
      if (options.verbose) {
        for (const entry of entries) {
          dependencies.log(`[${displayText(entry.providerName)}] ${displayText(entry.path)} (${prettyBytes(entry.sizeBytes)})`);
        }
        for (const operation of plan.operations) dependencies.log(`Index updates: ${displayText(operation)}`);
      }
      if (options.dryRun) {
        dependencies.log("Preview complete. No original data was deleted.");
        return;
      }
      if (!options.yes && !await dependencies.confirm({
        message: options.includeMemories
          ? "Move selected history, related data, and memories to Trash?"
          : "Move selected history and related data to Trash? Memories will be kept."
      })) {
        dependencies.log("Deletion cancelled.");
        return;
      }
      await dependencies.assertAgentsStopped?.(targets);
      dependencies.log("Cleaning…");
      const result = await plan.execute();
      dependencies.log(`Moved to Trash: ${result.deleted.length} items; failed: ${result.failures.length}.`);
      for (const failure of result.failures) {
        dependencies.error(`[${providerName(failure.providerId)}] ${displayText(failure.message)}`);
        if (failure.recoveryPath) dependencies.error(`Recovery data: ${displayText(failure.recoveryPath)}`);
      }
      if (result.failures.length > 0) exitCode = 1;
    });

  program.command("conversations")
    .description("Choose an agent and select conversations to delete.")
    .option("-t, --target <target>", `One agent: ${manifests.map((manifest) => manifest.id).join(", ")}`)
    .option("--dry-run", "Preview selected conversations without deleting original data.", false)
    .option("--include-memories", "Also delete supported memory records belonging to selected conversations.", false)
    .option("--allow-running", "Deprecated: deletion requires stopped agents; accepted only with --dry-run.", false)
    .option("--timezone <zone>", "IANA time zone for timestamps, such as UTC; defaults to the system time zone.")
    .option("--force-stop", "Stop selected agents before deletion; may close their desktop apps.", false)
    .action(async (options: { target?: string; dryRun: boolean; includeMemories: boolean; forceStop: boolean; allowRunning: boolean; timezone?: string }) => {
      await assertPlatform();
      if (options.allowRunning && !options.dryRun) {
        throw new Error("--allow-running no longer permits deletion. Close the selected agents, then retry without --allow-running; use --force-stop to request confirmed shutdown.");
      }
      const timezone = validateTimezone(options.timezone);
      const targets = parseTargets(options.target);
      if (targets && targets.length !== 1) throw new Error("Conversation selection requires exactly one agent in --target.");
      const fixedTarget = targets?.[0];
      requireTerminal("Conversation selection requires an interactive terminal. Run this command in a terminal; use clean --dry-run to preview bulk cleanup without prompts.");
      do {
        const target = fixedTarget ?? await dependencies.selectAgent({
          message: "Choose an AI agent",
          choices: manifests.map((manifest) => ({ name: manifest.name, value: manifest.id }))
        });
        if (!target) return;
        dependencies.log(memoryNotice(options.includeMemories, true));
        if (!options.dryRun && !options.forceStop) await dependencies.assertAgentsStopped?.([target]);
        const discovery = await dependencies.discoverConversations([target], { includeMemories: options.includeMemories });
        for (const warning of discovery.warnings) dependencies.warn(`Warning: ${displayText(warning)}`);
        if (discovery.conversations.some((conversation) => conversation.providerId !== target)) {
          throw new Error("Discovery returned data from another agent. Operation stopped.");
        }
        if (discovery.conversations.length === 0) {
          dependencies.log(`No local conversations found for ${providerName(target)}.`);
          continue;
        }
        const selectedKeys = await dependencies.checkbox({
          message: `Select ${providerName(target)} conversations to delete`,
          choices: discovery.conversations.map((conversation) => ({
            name: formatConversationChoice(conversation, timezone),
            value: conversation.key,
            description: `ID: ${displayText(conversation.id)}${conversation.workspace ? ` | Workspace: ${displayText(conversation.workspace)}` : ""}`,
            disabled: conversation.disabledReason ? displayText(conversation.disabledReason) : undefined
          })),
          pageSize: 18
        });
        if (selectedKeys === undefined) continue;
        const selected = discovery.conversations.filter((conversation) =>
          !conversation.disabledReason && selectedKeys.includes(conversation.key)
        );
        if (selected.length === 0) {
          dependencies.log("No conversations selected.");
          continue;
        }
        for (const warning of new Set(selected.flatMap((conversation) => conversation.warnings))) {
          dependencies.warn(`Warning: ${displayText(warning)}`);
        }
        for (const conversation of selected) {
          dependencies.log(`Selected: ${displayText(conversation.id)}  ${displayText(conversation.title)}`);
        }
        if (!options.dryRun && !await dependencies.confirm({
          message: (options.forceStop
            ? `Stop all running ${providerName(target)} agents and delete ${selected.length} conversations and their indexes?${stopImpact([target])}`
            : `Delete ${selected.length} ${providerName(target)} conversations and their indexes?`)
            + (options.includeMemories ? " Include supported memory records." : " Keep memories.")
            + selected.map((conversation) => `\nID: ${displayText(conversation.id)} | Key: ${displayText(conversation.key)}`).join("")
        })) {
          dependencies.log("Deletion cancelled.");
          continue;
        }
        if (options.forceStop && !options.dryRun) {
          if (!dependencies.stopAgents) throw new Error("Stopping agents is not available in this environment.");
          dependencies.log(`Stopping running agents for ${providerName(target)}…`);
          await dependencies.stopAgents([target]);
        } else if (options.forceStop) {
          dependencies.log("Dry-run does not stop running agents.");
        }
        if (!options.dryRun) await dependencies.assertAgentsStopped?.([target]);
        dependencies.log(options.dryRun ? "Checking selected conversations…" : "Deleting selected conversations…");
        const result = await dependencies.deleteConversations(selected, {
          dryRun: options.dryRun, includeMemories: options.includeMemories
        });
        writeConversationResult(result, options.dryRun, dependencies.log, dependencies.error);
        if (result.failures.length > 0) exitCode = 1;
      } while (!fixedTarget);
    });

  program.command("doctor")
    .description("Check the system, required tools, data roots, and running agents.")
    .option("--all", "Check every supported agent.")
    .option("-t, --target <targets>", targetHelp())
    .option("--json", "Print JSON with ~ for data roots and no process command lines.", false)
    .action(async (options: { all?: boolean; target?: string; json: boolean }) => {
      if (options.all && options.target !== undefined) throw new Error("Use either --all or --target, not both.");
      const targets = parseTargets(options.target) ?? manifests.map((manifest) => manifest.id);
      if (!dependencies.doctor) throw new Error("Diagnostics are not available in this environment.");
      const report = await dependencies.doctor(targets);
      if (options.json) dependencies.log(displayJson(report));
      else {
        for (const check of report.checks) dependencies.log(`[${check.ok ? "OK" : "ATTENTION"}] ${displayText(check.message)}`);
        dependencies.log(report.ok ? "Checks complete." : "Some checks need attention. No data was changed.");
      }
      if (!report.ok) exitCode = 1;
    });

  program.command("update")
    .description("Check GitHub for a published release; install only with --install.")
    .option("--install", "Verify and install a newer release in this npm global installation.", false)
    .option("--prerelease", "Include published prereleases, such as beta versions.", false)
    .action(async (options: { install: boolean; prerelease: boolean }) => {
      if (options.install) await assertPlatform();
      if (!dependencies.checkForUpdate) throw new Error("Update checks are not available in this environment.");
      dependencies.log("Checking published GitHub releases…");
      const release = await dependencies.checkForUpdate({ currentVersion: version, prerelease: options.prerelease });
      dependencies.log(`Installed: ${displayText(release.currentVersion)}; latest ${options.prerelease ? "release" : "stable release"}: ${displayText(release.latestVersion)}.`);
      if (!release.available) {
        dependencies.log("No newer release is available. Nothing was installed.");
        return;
      }
      dependencies.log(`Release: ${displayText(release.releaseUrl)}`);
      if (!options.install) {
        dependencies.log(`To install, run: ai-cleaner update --install${options.prerelease ? " --prerelease" : ""}`);
        return;
      }
      if (!dependencies.installUpdate) throw new Error("Installing updates is not available in this environment.");
      dependencies.log("Verifying the release archive and updating this installation…");
      await dependencies.installUpdate(release);
      dependencies.log(`Updated to ${displayText(release.latestVersion)}. Run ai-cleaner --version to confirm.`);
    });

  const recovery = program.command("recovery")
    .description("Inspect cleanup records, backup integrity, and manual recovery instructions.");
  recovery.command("list")
    .description("List operation summaries without reading conversation content.")
    .option("--json", "Print JSON.", false)
    .option("--timezone <zone>", "IANA time zone for timestamps; defaults to the system time zone.")
    .action(async (options: { json: boolean; timezone?: string }) => {
      const timezone = validateTimezone(options.timezone);
      if (!dependencies.listRecovery) throw new Error("Recovery records are not available in this environment.");
      const records = await dependencies.listRecovery();
      if (options.json) dependencies.log(displayJson(records));
      else if (!records.length) dependencies.log("No cleanup operations recorded.");
      else for (const record of records) {
        dependencies.log(`${formatDate(record.startedAt, timezone)}  ${displayText(record.id)}  ${displayText(record.kind)}  ${record.target.map(displayText).join(", ")}  ${displayText(record.status)}`);
      }
    });
  recovery.command("inspect <id>")
    .description("Inspect an operation and its backups; does not restore data.")
    .option("--json", "Print JSON, including recovery paths.", false)
    .action(async (id: string, options: { json: boolean }) => {
      if (!dependencies.inspectRecovery) throw new Error("Recovery inspection is not available in this environment.");
      const report = await dependencies.inspectRecovery(id);
      dependencies.log(displayJson(options.json ? report : { operation: report.operation, backups: report.backups, claims: report.claims }));
      if (!options.json) for (const instruction of report.instructions) dependencies.log(displayText(instruction));
    });

  if (argv.length <= 2) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return exitCode;
      dependencies.error(displayText(commanderErrorOutput.trim() || error.message));
      return 1;
    }
    fail(error);
  }
  return exitCode;
}

function targetHelp(): string {
  return `Comma-separated agents: ${manifests.map((manifest) => manifest.id).join(", ")}`;
}

function stopImpact(targets: ProviderId[]): string {
  const apps = [targets.includes("codex") ? "ChatGPT/Codex" : "", targets.includes("claude") ? "Claude" : ""].filter(Boolean);
  const desktopApp = apps.length ? `; may close the ${apps.join(" and ")} desktop app${apps.length > 1 ? "s" : ""}` : "";
  return ` Interrupts current work${desktopApp}.`;
}

function formatConversationChoice(conversation: ConversationRecord, timezone: string): string {
  const date = formatDate(conversation.updatedAt, timezone);
  const size = conversation.sizeKnown === false ? "size unknown" : prettyBytes(conversation.sizeBytes);
  return `${date}  ${displayText(conversation.title)}  (${size})`;
}

function writeConversationResult(
  result: ConversationDeleteResult,
  dryRun: boolean,
  log: (message: string) => void,
  error: (message: string) => void
): void {
  log(dryRun
    ? `Preview complete: ${result.previewed.length} conversations selected. No original data was deleted.`
    : `Deleted: ${result.deleted.length}; failed: ${result.failures.length}.`);
  for (const failure of result.failures) {
    error(`- [${displayText(failure.conversation.providerName)}] ${displayText(failure.conversation.title)}: ${displayText(failure.error.message)}`);
    if (failure.deletedPaths?.length) error(`  Moved to Trash: ${failure.deletedPaths.map(displayText).join(", ")}`);
    if (failure.metadataChanged) error("  Some indexes may have changed. Check the recovery record.");
    if (failure.recoveryPath) error(`  Recovery data: ${displayText(failure.recoveryPath)}`);
  }
}

function validateTimezone(value?: string): string {
  const timezone = value ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    throw new Error(`Invalid time zone "${displayText(timezone)}". Use an IANA time zone, such as UTC or America/New_York.`);
  }
}

function memoryNotice(includeMemories: boolean, selected = false): string {
  return includeMemories
    ? `Memories: included${selected ? " where individually supported" : ""}.`
    : "Memories: kept (use --include-memories to include).";
}

function cleanScope(targets: ProviderId[], includeMemories: boolean): string {
  const scopes: Record<ProviderId, string> = {
    codex: `Codex: conversations, indexes, attachments, voice records, ${includeMemories ? "memories, " : ""}goals, queue, generated_images, visualizations, logs, execution snapshots, ~/Documents/Codex/.DS_Store, and valid YYYY-MM-DD workspace folders in ~/Documents/Codex with all contained files (including generated and project files)`,
    copilot: "Copilot: conversation state, indexes, and command history",
    antigravity: "Antigravity: conversations, indexes, brain, working files, generated HTML, and caches",
    opencode: "OpenCode: conversation databases, storage, project snapshots, and prompt history",
    grok: `Grok: conversations, ${includeMemories ? "memories, " : ""}and the active conversation index`,
    claude: `Claude Code: conversations, prompt history, ${includeMemories ? "project and subagent memories, " : ""}file snapshots, plans, tasks, attachments, session state, shell snapshots, logs, and usage/feedback data`
  };
  return targets.map((target) => scopes[target]).join("; ");
}

function formatDate(input: string | undefined, timezone: string): string {
  const value = input ? new Date(input) : undefined;
  return value && !Number.isNaN(value.valueOf())
    ? new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(value).replaceAll("-", "/")
    : "time unknown";
}
