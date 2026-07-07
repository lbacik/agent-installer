import pc from "picocolors";
import { ArtifactState, RemovedArtifactState } from "./types.js";

function colorizeStatus(status: ArtifactState["status"] | RemovedArtifactState["status"]): string {
  switch (status) {
    case "new":
      return pc.cyan(status);
    case "installed-same":
      return pc.green(status);
    case "installed-different":
      return pc.yellow(status);
    case "source-missing":
      return pc.magenta(status);
    case "conflict":
      return pc.red(status);
  }
}

export function formatArtifactLine(state: ArtifactState): string {
  const detail =
    state.status === "conflict"
      ? ` (${state.conflictReason ?? "conflict"})`
      : state.status === "installed-different"
        ? " (update available)"
        : "";

  return `${colorizeStatus(state.status)} ${state.id} <- ${state.artifact.relativeSourcePath}${detail}`;
}

export function formatRemovedLine(state: RemovedArtifactState): string {
  return `${colorizeStatus(state.status)} ${state.id} <- missing from source`;
}
