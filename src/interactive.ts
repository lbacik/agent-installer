import { checkbox, confirm } from "@inquirer/prompts";
import { ArtifactState, RemovedArtifactState } from "./types.js";

export interface InteractiveSelection {
  installIds: string[];
  removeIds: string[];
}

export async function promptForSelections(
  states: ArtifactState[],
  removed: RemovedArtifactState[]
): Promise<InteractiveSelection> {
  const currentSelections = new Set(
    await checkbox({
      message: "Select artifacts that should remain installed",
      choices: states.map((state) => ({
        name: `${state.id} [${state.status}]`,
        value: state.id,
        checked: state.status === "installed-same" || state.status === "installed-different",
        disabled: state.status === "conflict" ? state.conflictReason ?? "conflict" : false
      }))
    })
  );

  const installIds = states
    .filter((state) => currentSelections.has(state.id))
    .filter((state) => state.status === "new" || state.status === "installed-different")
    .map((state) => state.id);

  const removeIds = states
    .filter((state) => !currentSelections.has(state.id))
    .filter((state) => state.status === "installed-same" || state.status === "installed-different")
    .map((state) => state.id);

  if (removed.length === 0) {
    return { installIds, removeIds };
  }

  const cleanup = await confirm({
    message: `Remove ${removed.length} managed artifact(s) that are no longer present in the source repository?`,
    default: false
  });

  if (!cleanup) {
    return { installIds, removeIds };
  }

  return {
    installIds,
    removeIds: [...removeIds, ...removed.map((entry) => entry.id)]
  };
}
