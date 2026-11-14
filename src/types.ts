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
 * The reportable state of one (target, kind) exposure for an artifact. One entry
 * exists per desired (target, kind) pair from the current `config.yaml`, plus one
 * per legacy (`targetName: null`) exposure the installer still owns. `status` is
 * per-exposure: `"new"` means the path does not exist yet and can be created,
 * `"installed-same"`/`"installed-different"` mirror the link-plus-content check,
 * and `"conflict"` means the path exists but is not a symlink to the artifact's
 * `basePath`. A single-exposure conflict never sets the artifact-level aggregate
 * `status` to `"conflict"`; only a `basePath` conflict does that.
 */
export interface ExposureState {
  targetName: string | null;
  path: string;
  status: ArtifactStatus;
  conflictReason?: string;
  /** Equals `path` when status is `"conflict"`. */
  conflictPath?: string;
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
  /** The content-identity algorithm that produced `sourceHash`/`installedHash`
   * (`agent-installer-tree-v1` or `agent-installer-tree-v2` for skills,
   * `sha256` for prompts). Both hashes of one entry always share it, so they
   * stay comparable with each other but never with another algorithm's. */
  hashAlgorithm: string;
  /**
   * The installer Overlays recorded when this entry was last written, exactly
   * as reported in the v3 install record, or `[]` when none applied. `null`
   * means unknown: a skill entry migrated from state v3, healed the next time
   * an install writes it. Prompts always record `[]`.
   */
  overlays: OverlayRecord[] | null;
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
  /** The installer Overlay resolved for this artifact in this run, if any. */
  overlay: OverlayFile | null;
  /** Expected content identity: source files plus any Overlay. `digest` always equals `sourceHash`. */
  sourceContent: ContentIdentity;
  /** Freshly verified content identity of the base-store copy, when one exists (managed or not). */
  installedContent: ContentIdentity | null;
  status: ArtifactStatus;
  managedEntry: ManagedEntry | null;
  /**
   * One entry per desired (target, kind) pair from the current `config.yaml`,
   * plus one per legacy (`targetName: null`) exposure the installer still owns.
   * Empty when `config.yaml` declares no target for this artifact's kind (and no
   * legacy exposure is owned), or when `status` is `"conflict"` (a basePath
   * conflict blocks the whole artifact, so its exposures are never evaluated).
   * Artifact-level `status` is the aggregate: `"conflict"` only for a basePath
   * conflict, `"installed-same"` only when content matches and every desired
   * exposure matches, `"installed-different"` otherwise, `"new"` when nothing
   * exists yet. `conflictReason`/`conflictPath` stay reserved for basePath
   * conflicts; per-exposure conflicts live in this array only.
   */
  exposures: ExposureState[];
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
 * What one install run did to a single Requested Artifact's Base Store copy
 * only (never its Tool Exposures): `installed` (it was `new`), `updated`
 * (content rewritten), `unchanged` (verified, not written), `conflict` (a
 * basePath conflict, skipped or refused), `failed`, or `not-attempted` (the
 * run stopped before reaching it).
 */
export type InstallDisposition = "installed" | "updated" | "unchanged" | "conflict" | "failed" | "not-attempted";

/**
 * What one install run did to a single configured (target, kind) exposure:
 * `created` (linked this run), `repaired` (reserved for exposure-only repair
 * flows), `present` (already correct), `conflict` (unmanaged path, skipped),
 * or `failed` (creation failed, skipped).
 */
export type ExposureInstallResult = "created" | "repaired" | "present" | "conflict" | "failed";

/** One configured exposure's install result, with `reason` for `conflict`/`failed`. */
export interface ExposureInstallRecord {
  targetName: string;
  path: string;
  result: ExposureInstallResult;
  reason?: string;
}

/** The closed error-code vocabulary for v3 install reports (`error.code`) and per-artifact `failure.code`. */
export type InstallErrorCode =
  | "source-unavailable"
  | "source-configuration"
  | "config-invalid"
  | "conflict"
  | "unmatched-selector"
  | "install-failed"
  | "verification-failed";

/** The run-level Install Outcome, computed from Base Store dispositions only. */
export type InstallRunOutcome = "complete" | "partial" | "aborted";

/** The run-level exposure summary, independent of the Base Store outcome. */
export type InstallExposureSummary = "not-configured" | "complete" | "partial";

/** Exactly one verified outcome per Requested Artifact, the unit of the v3 install report. */
export interface InstallArtifactOutcome {
  id: string;
  kind: ArtifactKind;
  name: string;
  sourceIdentity: string;
  relativeSourcePath: string;
  status: ArtifactStatus;
  disposition: InstallDisposition;
  exposures: ExposureInstallRecord[];
  basePath: string;
  /** Base-store-relative location: the skill name, or `<name>.md` for a prompt. */
  storeRelativePath: string;
  /** Always present; `null` when not applicable (for example a local source). */
  requestedRef: string | null;
  /** Always present; `null` when not applicable (for example a local source). */
  resolvedCommit: string | null;
  /**
   * Freshly verified Content Identity; present whenever the Base Store copy
   * exists after the run. `expectedHash` is the source files plus any
   * Overlays (never a pristine upstream-tree hash); `installedHash` is freshly
   * computed in this run from the Base Store copy.
   */
  content?: { algorithm: string; expectedHash: string; installedHash: string };
  /** Complete inventory of the Base Store copy's regular content files, from the same fresh walk as `installedHash`. */
  files?: ContentFileRecord[];
  /** Every installer Overlay applied, or empty. */
  overlays: OverlayRecord[];
  /** Only when `disposition` is `failed`. */
  failure?: { code: InstallErrorCode; message: string };
}

/** One artifact removed by `--prune`: no content identity, exposures split by what actually happened. */
export interface InstallPrunedOutcome {
  id: string;
  basePath: string;
  storeRelativePath: string;
  requestedRef: string | null;
  resolvedCommit: string | null;
  removedExposures: ExposureRecord[];
  retainedExposures: ExposureRecord[];
}

/**
 * The versioned, complete, machine-readable outcome of one install run: one
 * record per Requested Artifact plus run-level summaries. Rendered to JSON
 * from this value alone, with no further filesystem reads.
 */
export interface InstallOutcome {
  schemaVersion: 3;
  kind: "agent-installer.install-report";
  baseStore: { skills: string; prompts: string };
  outcome: InstallRunOutcome;
  exposureOutcome: InstallExposureSummary;
  artifacts: InstallArtifactOutcome[];
  unmatchedSelectors: string[];
  pruned: InstallPrunedOutcome[];
  error?: { code: InstallErrorCode; message: string };
}

/**
 * A file the installer materializes into the base-store copy of an artifact,
 * either adding one the source repository does not have or replacing one it
 * does. `relativePath` is POSIX-style and relative to the artifact root.
 * `id`/`version` identify the installer Overlay in the Overlay registry (see
 * docs/content-identity.md); `effect` records whether the source already
 * shipped the file (`"modified"`, merged) or not (`"added"`, generated).
 */
export interface OverlayFile {
  relativePath: string;
  content: string;
  id: string;
  version: number;
  effect: "added" | "modified";
}

/** How an applied Overlay related to the source tree: the file was generated
 * (`"added"`) or an authored file was merged (`"modified"`). */
export type OverlayEffect = "added" | "modified";

/**
 * The reportable/persisted form of an applied installer Overlay: stable
 * `id`/`version` from the Overlay registry, every affected `paths` entry
 * (POSIX-style, relative to the artifact root), and the per-run `effect`.
 */
export interface OverlayRecord {
  id: string;
  version: number;
  paths: string[];
  effect: OverlayEffect;
}

/** One regular content file in a content inventory: POSIX-style path relative
 * to the artifact root (`/`-separated), SHA-256 over the raw file bytes, and
 * whether the executable bit is set. Sorted by UTF-8 byte order of `path`. */
export interface ContentFileRecord {
  path: string;
  sha256: string;
  executable: boolean;
}

/**
 * Freshly verified content identity for one artifact copy: the hash
 * `algorithm` that produced `digest` (for example `agent-installer-tree-v2`
 * for skills or `sha256` for prompts), the digest itself, and the complete
 * per-file inventory it was computed from.
 */
export interface ContentIdentity {
  algorithm: string;
  digest: string;
  files: ContentFileRecord[];
}
