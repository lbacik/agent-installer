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
