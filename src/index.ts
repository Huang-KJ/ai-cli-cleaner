#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { moveToSystemTrash } from "./fs/trash.js";
import { listOperations, inspectOperation, withOperation, wrapOperationTrash } from "./recovery/operations.js";
import { runDoctor } from "./doctor.js";
import { assertAgentsStopped, stopAgents } from "./fs/agent-processes.js";
import { runCli } from "./cli.js";
import { findOpenPaths } from "./fs/open-files.js";
import { assertDefaultDataRoots } from "./cleaners/manifests.js";
import {
  confirmConversationDeletion,
  selectConversationAgent,
  selectConversations
} from "./ui/conversation-prompts.js";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version?: unknown; engines?: { node?: string } };
if (typeof packageMetadata.version !== "string") {
  throw new Error("package.json does not contain a valid version.");
}

process.exitCode = await runCli(process.argv, packageMetadata.version, {
  confirm: (options) => confirmConversationDeletion(options, { output: process.stderr }),
  selectAgent: (options) => selectConversationAgent(options, { output: process.stderr }),
  checkbox: (options) => selectConversations(options, { output: process.stderr }),
  checkForUpdate: async (options) => {
    const { checkForUpdate } = await import("./update.js");
    return checkForUpdate(options);
  },
  installUpdate: async (release) => {
    const { installUpdate } = await import("./update.js");
    await installUpdate(release);
  },
  listRecovery: () => listOperations(),
  inspectRecovery: (id) => inspectOperation(id),
  doctor: (targets) => runDoctor(targets, { nodeRange: packageMetadata.engines?.node }),
  assertAgentsStopped: async (targets) => {
    assertDefaultDataRoots(targets);
    await assertAgentsStopped(targets);
  },
  stopAgents: async (targets) => {
    assertDefaultDataRoots(targets);
    await stopAgents(targets);
  },
  prepareClean: async (targets) => {
    assertDefaultDataRoots(targets);
    const { prepareClean } = await import("./cleaners/plan.js");
    const plan = await prepareClean(targets, { trash: wrapOperationTrash(moveToSystemTrash), checkOpenPaths: findOpenPaths });
    return { ...plan, execute: () => withOperation({ kind: "clean", target: targets }, plan.execute) };
  },
  discoverConversations: async (targets) => {
    assertDefaultDataRoots(targets);
    const { discoverConversations } = await import("./conversations/discover.js");
    return discoverConversations(targets);
  },
  deleteConversations: async (conversations, options) => {
    assertDefaultDataRoots(conversations.map((conversation) => conversation.providerId));
    const { deleteConversations } = await import("./conversations/delete.js");
    const execute = () => deleteConversations(conversations, {
      ...options,
      checkOpenPaths: findOpenPaths,
      trash: wrapOperationTrash(moveToSystemTrash)
    });
    return options.dryRun ? execute() : withOperation({ kind: "conversations",
      target: [...new Set(conversations.map((conversation) => conversation.providerId))] }, execute);
  },
  log: console.log,
  warn: console.warn,
  error: console.error
});
