import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  confirmConversationDeletion,
  selectConversationAgent,
  selectConversations
} from "../src/ui/conversation-prompts.js";

describe("conversation prompts", () => {
  it.each([
    { keys: ["\u001b[A", "y"], expected: "copilot" },
    { keys: ["\u001b[B", "\u001b[B", "\r"], expected: "codex" },
    { keys: ["2"], expected: "copilot" },
    { keys: ["\u001b"], expected: undefined }
  ])("selects or exits the Agent menu with $keys", async ({ keys, expected }) => {
    await expect(runPrompt(selectConversationAgent, {
      message: "Select an agent",
      choices: [
        { name: "Codex", value: "codex" },
        { name: "Copilot", value: "copilot" }
      ]
    }, keys)).resolves.toBe(expected);
  });

  it("does not select an Agent with Alt+y", async () => {
    await expect(runPrompt(selectConversationAgent, {
      message: "Select an agent",
      choices: [
        { name: "Codex", value: "codex" },
        { name: "Copilot", value: "copilot" }
      ]
    }, ["\u001by", "2"], true)).resolves.toBe("copilot");
  });

  it("loops through conversations and submits the selection with y", async () => {
    const answer = runPrompt(selectConversations, {
      message: "Select conversations",
      choices: [
        { name: "First conversation", value: "first" },
        { name: "Last conversation", value: "last" }
      ],
      pageSize: 2
    }, ["\u001b[A", " ", "y"]);

    await expect(answer).resolves.toEqual(["last"]);
  });

  it("returns from the conversation prompt with Esc", async () => {
    const answer = runPrompt(selectConversations, {
      message: "Select conversations",
      choices: [{ name: "Conversation", value: "thread" }],
      pageSize: 1
    }, ["\u001b"]);

    await expect(answer).resolves.toBeUndefined();
  });

  it.each([
    { keys: ["\r"], expected: [] },
    { keys: [" ", "1", "\r"], expected: [] },
    { keys: ["a", "\r"], expected: ["second", "third"] },
    { keys: ["a", "a", "\r"], expected: [] },
    { keys: ["2", "i", "\r"], expected: ["third"] }
  ])("preserves optional selection and disabled conversations with $keys", async ({ keys, expected }) => {
    await expect(runPrompt(selectConversations, {
      message: "Select conversations",
      choices: [
        { name: "Unavailable", value: "blocked", disabled: "Data cannot be verified" },
        { name: "Second conversation", value: "second" },
        { name: "Third conversation", value: "third" }
      ],
      pageSize: 3
    }, keys)).resolves.toEqual(expected);
  });

  it.each([
    { key: "y", expected: true },
    { key: "n", expected: false },
    { key: "\u001b", expected: false },
    { key: "\r", expected: false }
  ])("confirms only with an explicit y ($key)", async ({ key, expected }) => {
    await expect(runPrompt(confirmConversationDeletion, {
      message: "Delete this conversation?"
    }, [key])).resolves.toBe(expected);
  });

  it.each([
    { keys: ["n", "y"], expected: false },
    { keys: ["y", "n"], expected: true },
    { keys: ["\r", "y"], expected: false }
  ])("ignores keys after the confirmation settles with $keys in one turn", async ({ keys, expected }) => {
    await expect(runPrompt(confirmConversationDeletion, {
      message: "Delete this conversation?"
    }, keys, true)).resolves.toBe(expected);
  });

  it.each([
    { keys: ["\u001by", "n"], expected: false },
    { keys: ["\u001by", "\r"], expected: false }
  ])("does not treat Alt+y as confirmation with $keys", async ({ keys, expected }) => {
    await expect(runPrompt(confirmConversationDeletion, {
      message: "Delete this conversation?"
    }, keys, true)).resolves.toBe(expected);
  });
});

async function runPrompt<Config, Value>(
  prompt: (config: Config, context?: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  }) => Promise<Value>,
  config: Config,
  keys: string[],
  batch = false
): Promise<Value> {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const answer = prompt(config, { input, output });
  await nextTurn();
  for (const key of keys) {
    input.write(key);
    if (!batch) await nextTurn();
  }
  if (batch) await nextTurn();
  return answer;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
