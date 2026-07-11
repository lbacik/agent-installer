import { checkbox, confirm } from "@inquirer/prompts";
import pc from "picocolors";
import type { Key } from "node:readline";
import { formatManagedEntryLines } from "./format.js";
import type { ArtifactState, ManagedEntry, RemovedArtifactState } from "./types.js";

export interface InteractiveSelection {
  cancelled: false;
  installIds: string[];
  removeIds: string[];
}

export interface InteractiveCancellation {
  cancelled: true;
}

export type InteractiveResult = InteractiveSelection | InteractiveCancellation;

export interface ManagedArtifactRemovalSelection {
  cancelled: false;
  removeIds: string[];
}

export type ManagedArtifactRemovalResult = ManagedArtifactRemovalSelection | InteractiveCancellation;

interface PromptContext {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  clearPromptOnDone?: boolean;
}

export interface PromptForSelectionsOptions extends PromptContext {
  listLength?: number;
}

interface TerminalSizeOutput {
  rows?: number;
}

const PROMPT_RESERVED_ROWS = 4;
const FALLBACK_LIST_LENGTH = 7;

function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && ["AbortPromptError", "CancelPromptError", "ExitPromptError"].includes(error.name);
}

function isEscapeKey(value: string, key: Key): boolean {
  return key.name === "escape" || key.sequence === "\x1B" || value === "\x1B";
}

function listLengthFromTerminal(output: NodeJS.WritableStream): number | undefined {
  const rows = (output as TerminalSizeOutput).rows;
  if (rows === undefined) {
    return undefined;
  }

  return Math.max(1, rows - PROMPT_RESERVED_ROWS);
}

function resolveListLength(choiceCount: number, requestedLength: number | undefined, output: NodeJS.WritableStream): number {
  if (choiceCount < 1) {
    return 1;
  }

  const availableLength = requestedLength ?? listLengthFromTerminal(output) ?? FALLBACK_LIST_LENGTH;
  return Math.min(choiceCount, Math.max(1, availableLength));
}

function formatChoiceName(state: ArtifactState): string {
  const label = `${state.id} [${state.status}]`;
  return state.status === "conflict" ? `${pc.red("●")} ${label}` : label;
}

async function withEscapeCancellation<T>(
  runPrompt: (context: PromptContext & { signal: AbortSignal }) => Promise<T>,
  context: PromptContext = {}
): Promise<T> {
  const controller = new AbortController();
  const input = context.input ?? process.stdin;
  const abortOnEscape = (value: string, key: Key) => {
    if (isEscapeKey(value, key)) {
      controller.abort("escape");
    }
  };

  input.on("keypress", abortOnEscape);
  try {
    return await runPrompt({ ...context, signal: controller.signal });
  } finally {
    input.removeListener("keypress", abortOnEscape);
  }
}

export async function promptForSelections(
  states: ArtifactState[],
  removed: RemovedArtifactState[],
  context: PromptForSelectionsOptions = {}
): Promise<InteractiveResult> {
  const output = context.output ?? process.stdout;
  const listLength = resolveListLength(states.length, context.listLength, output);
  let currentSelections: Set<string>;
  try {
    currentSelections = new Set(
      await withEscapeCancellation(
        (promptContext) =>
          checkbox(
            {
              message: "Select artifacts that should remain installed",
              pageSize: listLength,
              loop: false,
              ...(context.clearPromptOnDone === undefined ? {} : { clearPromptOnDone: context.clearPromptOnDone }),
              theme: {
                style: {
                  disabledChoice: (text: string) => pc.dim(` ${text}`)
                }
              },
              choices: states.map((state) => ({
                name: formatChoiceName(state),
                value: state.id,
                checked: state.status === "installed-same" || state.status === "installed-different",
                disabled: state.status === "conflict" ? state.conflictReason ?? "conflict" : false
              }))
            },
            promptContext
          ),
        context
      )
    );
  } catch (error) {
    if (isPromptCancellation(error)) {
      return { cancelled: true };
    }

    throw error;
  }

  const installIds = states
    .filter((state) => currentSelections.has(state.id))
    .filter((state) => state.status === "new" || state.status === "installed-different")
    .map((state) => state.id);

  const removeIds = states
    .filter((state) => !currentSelections.has(state.id))
    .filter((state) => state.status === "installed-same" || state.status === "installed-different")
    .map((state) => state.id);

  if (removed.length === 0) {
    return { cancelled: false, installIds, removeIds };
  }

  let cleanup: boolean;
  try {
    cleanup = await withEscapeCancellation(
      (promptContext) =>
        confirm(
          {
            message: `Remove ${removed.length} managed artifact(s) that are no longer present in the source repository?`,
            default: false,
            ...(context.clearPromptOnDone === undefined ? {} : { clearPromptOnDone: context.clearPromptOnDone })
          },
          promptContext
        ),
      context
    );
  } catch (error) {
    if (isPromptCancellation(error)) {
      return { cancelled: true };
    }

    throw error;
  }

  if (!cleanup) {
    return { cancelled: false, installIds, removeIds };
  }

  return {
    cancelled: false,
    installIds,
    removeIds: [...removeIds, ...removed.map((entry) => entry.id)]
  };
}

export async function promptForManagedArtifactRemovals(
  entries: ManagedEntry[],
  context: PromptForSelectionsOptions = {}
): Promise<ManagedArtifactRemovalResult> {
  const output = context.output ?? process.stdout;
  const listLength = resolveListLength(entries.length, context.listLength, output);
  const entryLines = formatManagedEntryLines(entries);
  let selectedIds: Set<string>;
  try {
    selectedIds = new Set(
      await withEscapeCancellation(
        (promptContext) =>
          checkbox(
            {
              message: "Select managed artifacts that should remain installed",
              pageSize: listLength,
              loop: false,
              ...(context.clearPromptOnDone === undefined ? {} : { clearPromptOnDone: context.clearPromptOnDone }),
              choices: entries.map((entry, index) => {
                const name = entryLines[index];
                if (name === undefined) {
                  throw new Error("Missing formatted managed artifact entry.");
                }

                return { name, value: entry.id, checked: true };
              })
            },
            promptContext
          ),
        context
      )
    );
  } catch (error) {
    if (isPromptCancellation(error)) {
      return { cancelled: true };
    }

    throw error;
  }

  return {
    cancelled: false,
    removeIds: entries.filter((entry) => !selectedIds.has(entry.id)).map((entry) => entry.id)
  };
}
