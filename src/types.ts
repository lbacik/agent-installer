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

export interface ManagedEntry {
  id: string;
  kind: ArtifactKind;
  name: string;
  sourceRoot: string;
  relativeSourcePath: string;
  basePath: string;
  exposurePath: string;
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
  exposurePath: string;
  sourceHash: string;
  installedHash: string | null;
  status: ArtifactStatus;
  managedEntry: ManagedEntry | null;
  conflictReason?: string;
  /** The specific filesystem path (basePath or exposurePath) that a "conflict" status refers to. */
  conflictPath?: string;
}

export interface RemovedArtifactState {
  id: string;
  name: string;
  kind: ArtifactKind;
  basePath: string;
  exposurePath: string;
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
