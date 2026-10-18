import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isNumberKey,
  isSpaceKey,
  isUpKey,
  useKeypress,
  usePagination,
  usePrefix,
  useState
} from "@inquirer/core";
import type { ProviderId } from "../cleaners/types.js";

interface ConversationPromptChoice<Value> {
  name: string;
  value: Value;
  description?: string;
  disabled?: boolean | string;
}

export interface ConversationCheckboxPromptOptions {
  message: string;
  choices: ConversationPromptChoice<string>[];
  pageSize: number;
}

export interface ConversationConfirmPromptOptions {
  message: string;
}

export interface ConversationAgentPromptOptions {
  message: string;
  choices: Pick<ConversationPromptChoice<ProviderId>, "name" | "value">[];
}

interface CheckboxItem extends ConversationPromptChoice<string> {
  checked: boolean;
}

export const selectConversationAgent = createPrompt<
  ProviderId | undefined,
  ConversationAgentPromptOptions
>((config, done) => {
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [active, setActive] = useState(0);
  const [answer, setAnswer] = useState<string | undefined>();

  useKeypress((key) => {
    const select = (index: number): void => {
      const selected = config.choices[index];
      if (!selected) return;
      setActive(index);
      setAnswer(selected.name);
      setStatus("done");
      done(selected.value);
    };
    if (key.name === "escape") {
      setStatus("done");
      done(undefined);
    } else if (isEnterKey(key) || isYesKey(key)) {
      select(active);
    } else if (isUpKey(key) || isDownKey(key)) {
      const offset = isUpKey(key) ? -1 : 1;
      setActive(nextIndex(active, offset, config.choices.length));
    } else if (isNumberKey(key)) {
      select(Number(key.name) - 1);
    }
  });

  const prefix = usePrefix({ status });
  if (status === "done") return `${prefix} ${config.message} ${answer ?? "Exit"}`;
  const page = usePagination({
    items: config.choices,
    active,
    pageSize: Math.max(1, config.choices.length),
    loop: true,
    renderItem: ({ item, isActive, index }) => `${isActive ? "❯" : " "} ${index + 1}. ${item.name}`
  });
  return renderPrompt(
    prefix,
    config.message,
    page,
    undefined,
    "↑↓ Navigate • Enter/y Select • Number Jump • Esc Exit"
  );
});

export const selectConversations = createPrompt<
  string[] | undefined,
  ConversationCheckboxPromptOptions
>((config, done) => {
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [items, setItems] = useState<CheckboxItem[]>(
    config.choices.map((choice) => ({ ...choice, checked: false }))
  );
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  const selected = items.filter((item) => item.checked && !item.disabled);

  const toggle = (index: number): void => {
    const item = items[index];
    if (!item) return;
    if (item.disabled) {
      setError(typeof item.disabled === "string" ? item.disabled : "This conversation cannot be selected.");
      return;
    }
    setError(undefined);
    setActive(index);
    setItems(items.map((candidate, candidateIndex) =>
      candidateIndex === index ? { ...candidate, checked: !candidate.checked } : candidate
    ));
  };

  useKeypress((key) => {
    if (key.name === "escape") {
      setCancelled(true);
      setStatus("done");
      done(undefined);
    } else if (isEnterKey(key) || isYesKey(key)) {
      setStatus("done");
      done(selected.map((item) => item.value));
    } else if (isUpKey(key) || isDownKey(key)) {
      setError(undefined);
      const offset = isUpKey(key) ? -1 : 1;
      const next = nextIndex(active, offset, items.length);
      setActive(next);
    } else if (isSpaceKey(key)) {
      toggle(active);
    } else if (key.name === "a") {
      const shouldSelect = items.some((item) => !item.disabled && !item.checked);
      setItems(items.map((item) => item.disabled ? item : { ...item, checked: shouldSelect }));
    } else if (key.name === "i") {
      setItems(items.map((item) => item.disabled ? item : { ...item, checked: !item.checked }));
    } else if (isNumberKey(key)) {
      toggle(Number(key.name) - 1);
    }
  });

  const prefix = usePrefix({ status });
  if (status === "done") {
    const answer = cancelled ? "Selection cancelled" : selected.map((item) => item.name).join(", ");
    return `${prefix} ${config.message} ${answer}`.trimEnd();
  }
  const page = usePagination({
    items,
    active,
    pageSize: config.pageSize,
    loop: true,
    renderItem: ({ item, isActive }) => {
      const cursor = isActive ? "❯" : " ";
      const checkbox = item.disabled ? "-" : item.checked ? "◉" : "◯";
      const disabled = item.disabled
        ? ` (${typeof item.disabled === "string" ? item.disabled : "Unavailable"})`
        : "";
      return `${cursor}${checkbox} ${item.name}${disabled}`;
    }
  });
  return renderPrompt(prefix, config.message, page, items[active]?.description,
    "↑↓ Navigate • Space Toggle • a All • i Invert • Enter/y Submit • Esc Back",
    error);
});

export const confirmConversationDeletion = createPrompt<
  boolean,
  ConversationConfirmPromptOptions
>((config, done) => {
  const [answer, setAnswer] = useState<boolean | undefined>();
  useKeypress((key) => {
    const finish = (value: boolean): void => {
      setAnswer(value);
      done(value);
    };
    if (key.name === "escape" || key.name === "n") {
      finish(false);
    } else if (isYesKey(key)) {
      finish(true);
    } else if (isEnterKey(key)) {
      finish(false);
    }
  });

  const prefix = usePrefix({ status: answer === undefined ? "idle" : "done" });
  if (answer !== undefined) {
    return `${prefix} ${config.message} ${answer ? "Yes" : "No"}`;
  }
  return `${prefix} ${config.message} (y/N)  y Confirm • n/Esc Cancel`;
});

function isYesKey(key: { name: string; ctrl: boolean; meta?: boolean }): boolean {
  return key.name === "y" && !key.ctrl && !key.meta;
}

function nextIndex(current: number, offset: number, length: number): number {
  return length === 0 ? 0 : (current + offset + length) % length;
}

function renderPrompt(
  prefix: string,
  message: string,
  page: string,
  description: string | undefined,
  help: string,
  error?: string
): string {
  return [
    `${prefix} ${message}`,
    page,
    description,
    error,
    help
  ].filter(Boolean).join("\n");
}
