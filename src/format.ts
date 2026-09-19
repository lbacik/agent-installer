import pc from "picocolors";
import path from "node:path";
import {
  ArtifactState,
  ArtifactStatus,
  ExposureConflictSummary,
  ExposureState,
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

  return `${colorizeStatus(state.status)} ${state.id} <- ${state.artifact.relativeSourcePath}${detail}${exposureBreakdownSuffix(state.status, state.exposures)}`;
}

// Points a legacy (`targetName: null`) exposure at `config init`, which can adopt
// it into a named target. Shared by human-readable lines and JSON `notices[]`.
export function buildLegacyExposureNotice(id: string, exposurePath: string): string {
  return `notice ${id} has a legacy exposure at ${exposurePath} (run \`agent-installer config init\` to adopt it into a named target)`;
}

// Collects one notice per owned legacy exposure across scanned states and managed
// entries (pass `removed.map((entry) => entry.managedEntry)` for the latter).
export function collectLegacyNotices(
  entries: Array<{ id: string; exposures: Array<{ targetName: string | null; path: string }> }>
): string[] {
  return entries.flatMap((entry) =>
    entry.exposures
      .filter((exposure) => exposure.targetName === null)
      .map((exposure) => buildLegacyExposureNotice(entry.id, exposure.path))
  );
}

function shortExposureStatus(status: ArtifactStatus): string {
  switch (status) {
    case "new":
      return "new";
    case "installed-same":
      return "same";
    case "installed-different":
      return "different";
    case "conflict":
      return "conflict";
    case "source-missing":
      return "missing";
  }
}

export function formatExposureBreakdown(exposures: ExposureState[]): string {
  const parts = exposures.map((exposure) => `${exposure.targetName ?? "legacy"}: ${shortExposureStatus(exposure.status)}`);
  return `[${parts.join(", ")}]`;
}

// Bracketed per-target breakdown, appended to the one-line artifact format. Empty
// (line unchanged) when zero or one exposure agrees with the aggregate status;
// otherwise every exposure is listed, e.g. `[claude: same, vscode: new]`.
export function exposureBreakdownSuffix(aggregate: ArtifactStatus, exposures: ExposureState[]): string {
  if (exposures.length === 0) {
    return "";
  }

  if (exposures.length === 1 && exposures[0]?.status === aggregate) {
    return "";
  }

  return ` ${formatExposureBreakdown(exposures)}`;
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

export function formatManagedEntryLines(entries: ManagedEntry[], breakdowns?: Map<string, ExposureState[]>): string[] {
  const idWidth = Math.max(...entries.map((entry) => entry.id.length));

  return entries.map((entry) => {
    const line = `${entry.id.padEnd(idWidth)}  ${formatSourcePath(entry.sourceRoot, entry.relativeSourcePath)}`;
    const provenance = formatProvenance(entry);
    const withProvenance = provenance === undefined ? line : `${line}  ${provenance}`;
    const exposures = breakdowns?.get(entry.id) ?? [];
    return exposures.length > 1 ? `${withProvenance}  ${formatExposureBreakdown(exposures)}` : withProvenance;
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
