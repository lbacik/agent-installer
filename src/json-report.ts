import { readSymlinkTarget } from "./install.js";
import type { ArtifactState, ArtifactStatus, ManagedEntry, RemovedArtifactState } from "./types.js";

export const JSON_SCHEMA_VERSION = 1 as const;

export interface JsonArtifactRecord {
  id: string;
  kind: ArtifactState["artifact"]["kind"];
  name: string;
  status: ArtifactStatus;
  sourceIdentity: string;
  relativeSourcePath: string;
  basePath: string;
  exposurePath: string;
  sourceHash: string;
  installedHash: string | null;
  requestedRef?: string;
  resolvedCommit?: string;
  conflictReason?: string;
  conflictPath?: string;
}

export interface ScanJsonOutput {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  artifacts: JsonArtifactRecord[];
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

export function artifactStateToJson(state: ArtifactState): JsonArtifactRecord {
  return {
    id: state.id,
    kind: state.artifact.kind,
    name: state.artifact.name,
    status: state.status,
    sourceIdentity: state.artifact.sourceRoot,
    relativeSourcePath: state.artifact.relativeSourcePath,
    basePath: state.basePath,
    exposurePath: state.exposurePath,
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
    exposurePath: state.exposurePath,
    sourceHash: entry.sourceHash,
    installedHash: entry.installedHash,
    ...provenanceFields(entry)
  };
}

// `list` never re-scans the original source, so content drift can only be judged
// against the installer's own recorded hashes, not against the source repository's
// current content. The exposure symlink, however, is local state `list` can check
// directly, so a broken or missing exposure still reconciles as installed-different
// here rather than being reported as installed-same.
export async function managedEntryToJson(entry: ManagedEntry): Promise<JsonArtifactRecord> {
  const contentMatches = entry.sourceHash === entry.installedHash;
  const exposureTarget = await readSymlinkTarget(entry.exposurePath);
  const exposureMatches = exposureTarget === entry.basePath;

  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    status: contentMatches && exposureMatches ? "installed-same" : "installed-different",
    sourceIdentity: entry.sourceRoot,
    relativeSourcePath: entry.relativeSourcePath,
    basePath: entry.basePath,
    exposurePath: entry.exposurePath,
    sourceHash: entry.sourceHash,
    installedHash: entry.installedHash,
    ...provenanceFields(entry)
  };
}

export function buildScanJson(states: ArtifactState[], removed: RemovedArtifactState[]): ScanJsonOutput {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    artifacts: [...states.map(artifactStateToJson), ...removed.map(removedArtifactStateToJson)]
  };
}

export async function buildListJson(entries: ManagedEntry[]): Promise<ListJsonOutput> {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    artifacts: await Promise.all(entries.map(managedEntryToJson))
  };
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

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    installed: installedRecords,
    updated: updatedRecords,
    skipped: conflicts.map(artifactStateToJson),
    refused: [],
    pruned: pruned.map(removedArtifactStateToJson)
  };
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
