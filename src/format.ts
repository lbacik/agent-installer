import pc from "picocolors";
import path from "node:path";
import {
  ArtifactState,
  ExposureConflictSummary,
  ManagedEntry,
  RemovedArtifactState,
  SkippedExposureRemoval,
  SyncAction,
  SyncLegacyNotice
} from "./types.js";

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

export function formatInteractiveStartupArtifactLines(states: ArtifactState[]): string[] {
  return [];
}

export function formatRemovedLine(state: RemovedArtifactState): string {
  return `${colorizeStatus(state.status)} ${state.id} <- missing from source`;
}

function formatSourcePath(sourceRoot: string, relativeSourcePath: string): string {
  if (sourceRoot.startsWith("git+https://")) {
    return `${sourceRoot}/${relativeSourcePath}`;
  }

  return path.join(sourceRoot, relativeSourcePath);
}

function formatProvenance(entry: ManagedEntry): string | undefined {
  const parts: string[] = [];
  if (entry.requestedRef !== undefined) {
    parts.push(`ref=${entry.requestedRef}`);
  }

  if (entry.resolvedCommit !== undefined) {
    parts.push(`commit=${entry.resolvedCommit.slice(0, 7)}`);
  }

  return parts.length === 0 ? undefined : `(${parts.join(" ")})`;
}

export function formatManagedEntryLines(entries: ManagedEntry[]): string[] {
  const idWidth = Math.max(...entries.map((entry) => entry.id.length));

  return entries.map((entry) => {
    const line = `${entry.id.padEnd(idWidth)}  ${formatSourcePath(entry.sourceRoot, entry.relativeSourcePath)}`;
    const provenance = formatProvenance(entry);
    return provenance === undefined ? line : `${line}  ${provenance}`;
  });
}

export function formatOperationLine(action: "created" | "updated" | "removed", id: string): string {
  return `${action} ${id}`;
}

export function formatConflictLine(state: ArtifactState): string {
  return `${state.id} -> ${state.conflictPath ?? state.basePath}`;
}

export function formatExposureConflictLine(conflict: ExposureConflictSummary): string {
  return `${conflict.id} -> ${conflict.targetName}:${conflict.path} (${conflict.reason})`;
}

export function formatSkippedExposureLine(skipped: SkippedExposureRemoval): string {
  const target = skipped.targetName ?? "legacy";
  return `skipped removing ${skipped.id} exposure for target "${target}" at ${skipped.path} (no longer an owned symlink)`;
}

export function formatSyncActionLine(action: SyncAction): string {
  switch (action.action) {
    case "create":
      return `create ${action.id} -> ${action.targetName}:${action.path}`;
    case "move":
      return `move ${action.id} -> ${action.targetName}:${action.previousPath} => ${action.path}`;
    case "remove-orphan":
      return `remove ${action.id} -> ${action.targetName}:${action.path} (orphaned)`;
    case "match":
      return `match ${action.id} -> ${action.targetName}:${action.path}`;
    case "conflict":
      return `conflict ${action.id} -> ${action.targetName}:${action.path} (${action.reason ?? "conflict"})`;
  }
}

export function formatSyncLegacyNoticeLine(notice: SyncLegacyNotice): string {
  return `notice ${notice.id} has a legacy exposure at ${notice.path} (never touched by sync)`;
}
