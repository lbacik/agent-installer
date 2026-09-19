import { buildExposurePlan, planEntryToExposureState, readSymlinkTarget } from "./install.js";
import { buildLegacyExposureNotice } from "./format.js";
import { resolveHome } from "./paths.js";
import type { AgentInstallerConfig } from "./config.js";
import type { SyncAction, SyncResult } from "./sync.js";
import type {
  ArtifactState,
  ArtifactStatus,
  ExposureKind,
  ExposureRecord,
  ExposureState,
  ManagedEntry,
  RemovedArtifactState
} from "./types.js";

export const JSON_SCHEMA_VERSION = 2 as const;

export interface JsonArtifactRecord {
  id: string;
  kind: ArtifactState["artifact"]["kind"];
  name: string;
  status: ArtifactStatus;
  sourceIdentity: string;
  relativeSourcePath: string;
  basePath: string;
  /** One entry per desired (target, kind) pair, plus one per owned legacy exposure. Replaces v1's singular `exposurePath`. */
  exposures: ExposureState[];
  sourceHash: string;
  installedHash: string | null;
  requestedRef?: string;
  resolvedCommit?: string;
  /** Reserved for basePath conflicts only; per-exposure conflicts live in `exposures[]`. */
  conflictReason?: string;
  conflictPath?: string;
}

export interface ScanJsonOutput {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  artifacts: JsonArtifactRecord[];
  notices?: string[];
  error?: string;
}

export type ListJsonOutput = ScanJsonOutput;

export interface InstallJsonOutput {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  installed: JsonArtifactRecord[];
  updated: JsonArtifactRecord[];
  skipped: JsonArtifactRecord[];
  refused: JsonArtifactRecord[];
  pruned: JsonArtifactRecord[];
  notices?: string[];
  error?: string;
}

export interface JsonSyncAction {
  id: string;
  targetName: string;
  kind: ExposureKind;
  path: string;
  action: "create" | "remove" | "move";
  fromPath?: string;
}

export interface JsonSyncSkipped {
  id: string;
  targetName: string;
  path: string;
  conflictReason: string;
}

export interface SyncJsonOutput {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  planned: JsonSyncAction[];
  applied: JsonSyncAction[];
  skipped: JsonSyncSkipped[];
  notices?: string[];
  error?: string;
}

function provenanceFields(source: { requestedRef?: string | undefined; resolvedCommit?: string | undefined }): Pick<
  JsonArtifactRecord,
  "requestedRef" | "resolvedCommit"
> {
  return {
    ...(source.requestedRef === undefined ? {} : { requestedRef: source.requestedRef }),
    ...(source.resolvedCommit === undefined ? {} : { resolvedCommit: source.resolvedCommit })
  };
}

function withNotices<T extends object>(output: T, notices: string[]): T & { notices?: string[] } {
  return notices.length === 0 ? output : { ...output, notices };
}

function legacyNoticesForExposures(id: string, exposures: ExposureState[]): string[] {
  return exposures
    .filter((exposure) => exposure.targetName === null)
    .map((exposure) => buildLegacyExposureNotice(id, exposure.path));
}

function legacyNoticesForRecords(id: string, exposures: ExposureRecord[]): string[] {
  return exposures
    .filter((exposure) => exposure.targetName === null)
    .map((exposure) => buildLegacyExposureNotice(id, exposure.path));
}

export function artifactStateToJson(state: ArtifactState): JsonArtifactRecord {
  return {
    id: state.id,
    kind: state.artifact.kind,
    name: state.artifact.name,
    status: state.status,
    sourceIdentity: state.artifact.sourceRoot,
    relativeSourcePath: state.artifact.relativeSourcePath,
    basePath: state.basePath,
    exposures: state.exposures,
    sourceHash: state.sourceHash,
    installedHash: state.installedHash,
    ...provenanceFields(state.artifact),
    ...(state.conflictReason === undefined ? {} : { conflictReason: state.conflictReason }),
    ...(state.conflictPath === undefined ? {} : { conflictPath: state.conflictPath })
  };
}

export function removedArtifactStateToJson(state: RemovedArtifactState): JsonArtifactRecord {
  const entry = state.managedEntry;
  return {
    id: state.id,
    kind: state.kind,
    name: state.name,
    status: state.status,
    sourceIdentity: entry.sourceRoot,
    relativeSourcePath: entry.relativeSourcePath,
    basePath: state.basePath,
    exposures: entry.exposures.map((exposure) => ({
      targetName: exposure.targetName,
      path: exposure.path,
      status: "source-missing" as ArtifactStatus
    })),
    sourceHash: entry.sourceHash,
    installedHash: entry.installedHash,
    ...provenanceFields(entry)
  };
}

// `list` never re-scans the original source, so content drift can only be judged
// against the installer's own recorded hashes, not against the source repository's
// current content. With a config, a desired-but-missing exposure also counts as
// drift (mirroring scan); without one, only the owned recorded links are checked.
// Legacy exposures never affect the aggregate status; they only surface notices.
export async function managedEntryToJson(
  entry: ManagedEntry,
  config?: AgentInstallerConfig | null,
  home?: string
): Promise<JsonArtifactRecord> {
  const contentMatches = entry.sourceHash === entry.installedHash;

  if (config === undefined || config === null) {
    const checks = await Promise.all(
      entry.exposures.map(async (exposure) => ({
        exposure,
        owned: (await readSymlinkTarget(exposure.path)) === entry.basePath
      }))
    );
    const exposureMatches = checks.every((check) => check.owned);

    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      status: contentMatches && exposureMatches ? "installed-same" : "installed-different",
      sourceIdentity: entry.sourceRoot,
      relativeSourcePath: entry.relativeSourcePath,
      basePath: entry.basePath,
      exposures: checks.map(({ exposure, owned }) => ({
        targetName: exposure.targetName,
        path: exposure.path,
        status: owned
          ? contentMatches
            ? ("installed-same" as ArtifactStatus)
            : ("installed-different" as ArtifactStatus)
          : ("installed-different" as ArtifactStatus)
      })),
      sourceHash: entry.sourceHash,
      installedHash: entry.installedHash,
      ...provenanceFields(entry)
    };
  }

  const desiredPlan = await buildExposurePlan(config, resolveHome(home), { kind: entry.kind, name: entry.name }, entry.basePath);
  const exposures: ExposureState[] = desiredPlan.map((plan) => planEntryToExposureState(plan, contentMatches));

  const plannedPaths = new Set(desiredPlan.map((plan) => plan.path));
  for (const record of entry.exposures) {
    if (record.targetName !== null || plannedPaths.has(record.path)) {
      continue;
    }

    const owned = (await readSymlinkTarget(record.path)) === entry.basePath;
    exposures.push({
      targetName: null,
      path: record.path,
      status: owned
        ? ((contentMatches ? "installed-same" : "installed-different") as ArtifactStatus)
        : ("installed-different" as ArtifactStatus)
    });
  }

  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    status: contentMatches && desiredPlan.every((plan) => plan.status === "match") ? "installed-same" : "installed-different",
    sourceIdentity: entry.sourceRoot,
    relativeSourcePath: entry.relativeSourcePath,
    basePath: entry.basePath,
    exposures,
    sourceHash: entry.sourceHash,
    installedHash: entry.installedHash,
    ...provenanceFields(entry)
  };
}

export function buildScanJson(states: ArtifactState[], removed: RemovedArtifactState[]): ScanJsonOutput {
  const notices = [
    ...states.flatMap((state) => legacyNoticesForExposures(state.id, state.exposures)),
    ...removed.flatMap((state) => legacyNoticesForRecords(state.id, state.managedEntry.exposures))
  ];

  return withNotices(
    {
      schemaVersion: JSON_SCHEMA_VERSION,
      artifacts: [...states.map(artifactStateToJson), ...removed.map(removedArtifactStateToJson)]
    },
    notices
  );
}

export async function buildListJson(
  entries: ManagedEntry[],
  config?: AgentInstallerConfig | null,
  home?: string
): Promise<ListJsonOutput> {
  const artifacts = await Promise.all(entries.map((entry) => managedEntryToJson(entry, config, home)));
  const notices = artifacts.flatMap((artifact) => legacyNoticesForExposures(artifact.id, artifact.exposures));

  return withNotices({ schemaVersion: JSON_SCHEMA_VERSION, artifacts }, notices);
}

export function buildArtifactsErrorJson(error: unknown): ScanJsonOutput {
  return { schemaVersion: JSON_SCHEMA_VERSION, artifacts: [], error: messageOf(error) };
}

export async function buildInstallSuccessJson(
  states: ArtifactState[],
  installed: ManagedEntry[],
  conflicts: ArtifactState[],
  pruned: RemovedArtifactState[] = []
): Promise<InstallJsonOutput> {
  const statusById = new Map(states.map((state) => [state.id, state.status]));
  const installedRecords: JsonArtifactRecord[] = [];
  const updatedRecords: JsonArtifactRecord[] = [];

  for (const entry of installed) {
    const record = await managedEntryToJson(entry);
    if (statusById.get(entry.id) === "installed-different") {
      updatedRecords.push(record);
    } else {
      installedRecords.push(record);
    }
  }

  const notices = states.flatMap((state) => legacyNoticesForExposures(state.id, state.exposures));

  return withNotices(
    {
      schemaVersion: JSON_SCHEMA_VERSION,
      installed: installedRecords,
      updated: updatedRecords,
      skipped: conflicts.map(artifactStateToJson),
      refused: [],
      pruned: pruned.map(removedArtifactStateToJson)
    },
    notices
  );
}

export function buildInstallErrorJson(error: unknown, refused: ArtifactState[] = []): InstallJsonOutput {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    installed: [],
    updated: [],
    skipped: [],
    refused: refused.map(artifactStateToJson),
    pruned: [],
    error: messageOf(error)
  };
}

export function syncConflictToSkipped(action: SyncAction): JsonSyncSkipped {
  return {
    id: action.id,
    targetName: action.targetName,
    path: action.path,
    conflictReason: action.reason ?? "conflict"
  };
}

export function buildSyncJson(result: SyncResult): SyncJsonOutput {
  const planned: JsonSyncAction[] = [];
  const skipped: JsonSyncSkipped[] = [];

  for (const action of result.actions) {
    if (action.action === "create") {
      planned.push({ id: action.id, targetName: action.targetName, kind: action.kind, path: action.path, action: "create" });
    } else if (action.action === "move" && action.previousPath !== undefined) {
      planned.push({
        id: action.id,
        targetName: action.targetName,
        kind: action.kind,
        path: action.path,
        action: "move",
        fromPath: action.previousPath
      });
    } else if (action.action === "remove-orphan") {
      planned.push({ id: action.id, targetName: action.targetName, kind: action.kind, path: action.path, action: "remove" });
    } else if (action.action === "conflict") {
      skipped.push(syncConflictToSkipped(action));
    }
  }

  for (const removal of result.skippedOrphanRemovals) {
    skipped.push({
      id: removal.id,
      targetName: removal.targetName ?? "legacy",
      path: removal.path,
      conflictReason: "Exposure path is no longer an owned symlink, so it was left alone."
    });
  }

  const notices = result.legacyNotices.map(
    (notice) => `notice ${notice.id} has a legacy exposure at ${notice.path} (never touched by sync)`
  );

  return withNotices(
    {
      schemaVersion: JSON_SCHEMA_VERSION,
      planned,
      applied: result.dryRun ? [] : planned,
      skipped
    },
    notices
  );
}

export function buildSyncErrorJson(error: unknown, skipped: JsonSyncSkipped[] = []): SyncJsonOutput {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    planned: [],
    applied: [],
    skipped,
    error: messageOf(error)
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
