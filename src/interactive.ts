import { checkbox, confirm } from "@inquirer/prompts";
import type { Key } from "node:readline";
import { ArtifactState, RemovedArtifactState } from "./types.js";

export interface InteractiveSelection {
  cancelled: false;
  installIds: string[];
  removeIds: string[];
}

export interface InteractiveCancellation {
  cancelled: true;
}

export type InteractiveResult = InteractiveSelection | InteractiveCancellation;

interface PromptContext {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  clearPromptOnDone?: boolean;
}

function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && ["AbortPromptError", "CancelPromptError", "ExitPromptError"].includes(error.name);
}

async function withEscapeCancellation<T>(
  runPrompt: (context: PromptContext & { signal: AbortSignal }) => Promise<T>,
  context: PromptContext = {}
): Promise<T> {
  const controller = new AbortController();
  const input = context.input ?? process.stdin;
  const abortOnEscape = (_value: string, key: Key) => {
    if (key.name === "escape") {
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
  context: PromptContext = {}
): Promise<InteractiveResult> {
  let currentSelections: Set<string>;
  try {
    currentSelections = new Set(
      await withEscapeCancellation(
        (promptContext) =>
          checkbox(
            {
              message: "Select artifacts that should remain installed",
              choices: states.map((state) => ({
                name: `${state.id} [${state.status}]`,
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
            default: false
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
