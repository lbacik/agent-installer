export type ArtifactKind = "skill" | "prompt";

/** A `config.yaml` target's exposure kind: which directory field an artifact kind maps to. */
export type ExposureKind = "skills" | "prompts";

export type ArtifactStatus =
  | "new"
  | "installed-same"
  | "installed-different"
  | "source-missing"
  | "conflict";

export interface DiscoveredArtifact {
  kind: ArtifactKind;
  name: string;
  sourceRoot: string;
  sourcePath: string;
  relativeSourcePath: string;
  /** The `--ref` value the artifact was scanned at, when the source is a remote Git repository. */
  requestedRef?: string | undefined;
  /** The full 40-character commit SHA actually checked out, when the source is a remote Git repository. */
  resolvedCommit?: string | undefined;
}

/**
 * A single exposure symlink this tool owns for a managed artifact. `targetName` is the
 * `config.yaml` target that produced it, or `null` for exposures that predate `config.yaml`
 * (legacy, or otherwise unnamed). Ownership is keyed by `path`, never by `targetName`.
 */
export interface ExposureRecord {
  path: string;
  targetName: string | null;
}

/**
 * The reconciled state of one desired (artifact, target) exposure, derived from the
 * current `config.yaml` targets that declare the artifact's kind. `"new"` means the
 * path does not exist yet and can be created; `"match"` means an owned symlink is
 * already in place; `"conflict"` means the path exists but is not a symlink to the
 * artifact's `basePath`, so this pair alone is skipped without blocking the artifact's
 * base-store install or its other exposures.
 */
export type ExposurePlanStatus = "new" | "match" | "conflict";

export interface ExposurePlanEntry {
  targetName: string;
  kind: ExposureKind;
  path: string;
  status: ExposurePlanStatus;
  /** Set when status is "conflict". */
  reason?: string;
}

/** An exposure `removeArtifacts` could not delete because it no longer verified as an
 * owned symlink to the entry's basePath immediately before deletion (ownership
 * revalidation). The record is retained in state rather than silently dropped. */
export interface SkippedExposureRemoval {
  id: string;
  path: string;
  targetName: string | null;
}

/** One (artifact, target) pair skipped during install because its exposurePlan entry is a conflict. */
export interface ExposureConflictSummary {
  id: string;
  targetName: string;
  kind: ExposureKind;
  path: string;
  reason: string;
}

export interface ManagedEntry {
  id: string;
  kind: ArtifactKind;
  name: string;
  sourceRoot: string;
  relativeSourcePath: string;
  basePath: string;
  exposures: ExposureRecord[];
  sourceHash: string;
  installedHash: string;
  installedAt: string;
  /** The `--ref` value requested at install time, when the source was a remote Git repository. */
  requestedRef?: string | undefined;
  /** The full 40-character commit SHA actually installed, when the source was a remote Git repository. */
  resolvedCommit?: string | undefined;
}

export interface ArtifactState {
  artifact: DiscoveredArtifact;
  id: string;
  basePath: string;
  sourceHash: string;
  installedHash: string | null;
  status: ArtifactStatus;
  managedEntry: ManagedEntry | null;
  conflictReason?: string;
  /** The specific filesystem path (currently always basePath) that a "conflict" status refers to. */
  conflictPath?: string;
  /**
   * The desired exposure for every currently configured target that declares this
   * artifact's kind, one entry per (target, kind). Empty when `config.yaml` has no
   * such target, or when `status` is "conflict" (a basePath conflict blocks the whole
   * artifact, so its exposures are never evaluated).
   */
  exposurePlan: ExposurePlanEntry[];
}

export interface RemovedArtifactState {
  id: string;
  name: string;
  kind: ArtifactKind;
  basePath: string;
  status: "source-missing";
  managedEntry: ManagedEntry;
}

/**
 * `sync` reconciles one (artifact, target) exposure at a time. `"create"` and `"match"`
 * mirror install's exposure plan (path missing vs. already an owned symlink); `"move"`
 * additionally carries the exposure's stale `previousPath` (the target's directory
 * changed); `"remove-orphan"` means the recorded target no longer configures this
 * artifact's kind (or was removed entirely); `"conflict"` means the desired path exists
 * but is not a symlink to the artifact's basePath, exactly as for `install`.
 */
export type SyncActionKind = "create" | "match" | "move" | "remove-orphan" | "conflict";

export interface SyncAction {
  id: string;
  targetName: string;
  kind: ExposureKind;
  action: SyncActionKind;
  path: string;
  /** Set only for `"move"`: the stale exposure path being replaced. */
  previousPath?: string;
  /** Set only for `"conflict"`. */
  reason?: string;
}

/** A `targetName: null` (legacy) exposure encountered on a processed artifact. `sync`
 * never touches these; they are only ever surfaced as a notice. */
export interface SyncLegacyNotice {
  id: string;
  path: string;
}

/**
 * A file the installer materializes into the base-store copy of an artifact,
 * either adding one the source repository does not have or replacing one it
 * does. `relativePath` is POSIX-style and relative to the artifact root.
 */
export interface OverlayFile {
  relativePath: string;
  content: string;
}
