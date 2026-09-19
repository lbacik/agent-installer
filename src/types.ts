export type ArtifactKind = "skill" | "prompt";

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
 * A file the installer materializes into the base-store copy of an artifact,
 * either adding one the source repository does not have or replacing one it
 * does. `relativePath` is POSIX-style and relative to the artifact root.
 */
export interface OverlayFile {
  relativePath: string;
  content: string;
}
