import { promises as fs } from "node:fs";
import path from "node:path";
import { formatConflictLine } from "./format.js";
import { hashArtifact } from "./hash.js";
import { artifactId, getBasePath, getExposurePath, getMarkerPath, resolveTargetPaths, TargetPaths } from "./paths.js";
import { materializeOverlay, resolveInvocationPolicyOverlay } from "./skill-invocation-policy.js";
import { loadState, saveState } from "./state.js";
import type { ScanSourceOptions } from "./source.js";
import { resolveSourceInput, type ResolveSourceOptions } from "./source-resolver.js";
import { ArtifactState, DiscoveredArtifact, ManagedEntry, OverlayFile, RemovedArtifactState } from "./types.js";

// Thrown by installAllFromSource when unmanaged conflicts block the install and --allow-conflicts was not passed.
export class InstallConflictError extends Error {
  constructor(public readonly conflicts: ArtifactState[]) {
    super(
      [
        `Refusing to install: ${conflicts.length} artifact(s) conflict with unmanaged targets.`,
        ...conflicts.map((state) => `  ${formatConflictLine(state)}`),
        "Use --allow-conflicts to install the remaining eligible artifacts and skip these."
      ].join("\n")
    );
    this.name = "InstallConflictError";
  }
}

function partitionInstallAllStates(states: ArtifactState[]): { installable: ArtifactState[]; conflicts: ArtifactState[] } {
  return {
    installable: states.filter((state) => state.status === "new" || state.status === "installed-different"),
    conflicts: states.filter((state) => state.status === "conflict")
  };
}

// Thrown by installAllFromSource when an --only selector matches no discovered artifact.
export class UnmatchedSelectorsError extends Error {
  constructor(public readonly selectors: string[]) {
    super(`No discovered artifact matches: ${selectors.join(", ")}`);
    this.name = "UnmatchedSelectorsError";
  }
}

function selectStates(states: ArtifactState[], only: string[]): ArtifactState[] {
  const byId = new Map(states.map((state) => [state.id, state]));
  const unmatched = only.filter((id) => !byId.has(id));
  if (unmatched.length > 0) {
    throw new UnmatchedSelectorsError([...new Set(unmatched)]);
  }

  return [...new Set(only)].map((id) => byId.get(id) as ArtifactState);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureParentDir(targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

async function removePath(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function resolveOverlay(artifact: DiscoveredArtifact): Promise<OverlayFile | null> {
  return artifact.kind === "skill" ? resolveInvocationPolicyOverlay(artifact.sourcePath) : null;
}

async function copyArtifact(artifact: DiscoveredArtifact, basePath: string): Promise<void> {
  // Resolved before any managed path is touched, so a source-configuration error
  // in the artifact's authored Codex metadata leaves the managed copy untouched.
  const overlay = await resolveOverlay(artifact);

  await removePath(basePath);
  await ensureParentDir(basePath);

  if (artifact.kind === "skill") {
    await fs.cp(artifact.sourcePath, basePath, { recursive: true });
    await materializeOverlay(basePath, overlay);
    return;
  }

  await fs.copyFile(artifact.sourcePath, basePath);
}

async function readSymlinkTarget(targetPath: string): Promise<string | null> {
  try {
    return await fs.readlink(targetPath);
  } catch {
    return null;
  }
}

async function resolveSourceIdentity(sourceRoot: string): Promise<string> {
  try {
    return await fs.realpath(sourceRoot);
  } catch {
    return sourceRoot;
  }
}

async function writeMarker(entry: ManagedEntry): Promise<void> {
  const markerPath = getMarkerPath(entry.basePath, entry.kind);
  await fs.writeFile(markerPath, `${JSON.stringify({ id: entry.id, installedAt: entry.installedAt }, null, 2)}\n`, "utf8");
}

function buildManagedEntry(
  artifact: DiscoveredArtifact,
  paths: TargetPaths,
  sourceHash: string,
  installedHash: string
): ManagedEntry {
  return {
    id: artifactId(artifact.kind, artifact.name),
    kind: artifact.kind,
    name: artifact.name,
    sourceRoot: artifact.sourceRoot,
    relativeSourcePath: artifact.relativeSourcePath,
    basePath: getBasePath(paths, artifact),
    exposurePath: getExposurePath(paths, artifact),
    sourceHash,
    installedHash,
    installedAt: new Date().toISOString(),
    requestedRef: artifact.requestedRef,
    resolvedCommit: artifact.resolvedCommit
  };
}

export async function collectArtifactStates(
  sourceArtifacts: DiscoveredArtifact[],
  home?: string,
  sourceRoot?: string
): Promise<{
  states: ArtifactState[];
  removed: RemovedArtifactState[];
}> {
  const paths = resolveTargetPaths(home);
  const state = await loadState(paths);
  const sourceIds = new Set(sourceArtifacts.map((artifact) => artifactId(artifact.kind, artifact.name)));
  const entriesById = new Map(state.entries.map((entry) => [entry.id, entry]));
  const states: ArtifactState[] = [];

  for (const artifact of sourceArtifacts) {
    const id = artifactId(artifact.kind, artifact.name);
    const overlay = await resolveOverlay(artifact);
    const sourceHash = await hashArtifact(artifact.kind, artifact.sourcePath, overlay);
    const managedEntry = entriesById.get(id) ?? null;
    const basePath = getBasePath(paths, artifact);
    const exposurePath = getExposurePath(paths, artifact);

    let status: ArtifactState["status"] = "new";
    let installedHash: string | null = null;
    let conflictReason: string | undefined;
    let conflictPath: string | undefined;

    const baseExists = await pathExists(basePath);
    const exposureExists = await pathExists(exposurePath);

    if (!baseExists && !exposureExists) {
      status = "new";
    } else if (managedEntry && managedEntry.sourceRoot === artifact.sourceRoot) {
      if (baseExists) {
        installedHash = await hashArtifact(artifact.kind, basePath);
      }

      const symlinkTarget = exposureExists ? await readSymlinkTarget(exposurePath) : null;
      const expectedTarget = basePath;
      const exposureMatches = exposureExists && symlinkTarget === expectedTarget;
      const exposureConflict = exposureExists && !exposureMatches;

      if (exposureConflict) {
        status = "conflict";
        conflictReason = `Exposure path already exists and does not point to "${expectedTarget}".`;
        conflictPath = exposurePath;
      } else if (installedHash === sourceHash && exposureMatches) {
        status = "installed-same";
      } else {
        status = "installed-different";
      }
    } else {
      status = "conflict";
      if (baseExists) {
        conflictReason = "A target path already exists but is not managed by this installer.";
        conflictPath = basePath;
        installedHash = await hashArtifact(artifact.kind, basePath);
      } else {
        conflictReason = "The Claude exposure path already exists but is not managed by this installer.";
        conflictPath = exposurePath;
      }
    }

    const nextState: ArtifactState = {
      artifact,
      id,
      basePath,
      exposurePath,
      sourceHash,
      installedHash,
      status,
      managedEntry
    };

    if (conflictReason !== undefined) {
      nextState.conflictReason = conflictReason;
    }

    if (conflictPath !== undefined) {
      nextState.conflictPath = conflictPath;
    }

    states.push(nextState);
  }

  const scopedSourceRoot = sourceRoot === undefined ? sourceArtifacts[0]?.sourceRoot : await resolveSourceIdentity(sourceRoot);
  const removed = state.entries
    .filter((entry) => scopedSourceRoot !== undefined && entry.sourceRoot === scopedSourceRoot)
    .filter((entry) => !sourceIds.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      basePath: entry.basePath,
      exposurePath: entry.exposurePath,
      status: "source-missing" as const,
      managedEntry: entry
    }));

  return { states, removed };
}

export async function installArtifacts(states: ArtifactState[], home?: string): Promise<ManagedEntry[]> {
  const paths = resolveTargetPaths(home);
  const state = await loadState(paths);
  const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
  const installed: ManagedEntry[] = [];

  for (const current of states) {
    if (current.status === "conflict") {
      throw new Error(`Cannot install ${current.id}: ${current.conflictReason}`);
    }

    await copyArtifact(current.artifact, current.basePath);
    await ensureParentDir(current.exposurePath);
    await removePath(current.exposurePath);
    await fs.symlink(current.basePath, current.exposurePath);

    const installedHash = await hashArtifact(current.artifact.kind, current.basePath);
    const entry = buildManagedEntry(current.artifact, paths, current.sourceHash, installedHash);
    await writeMarker(entry);
    entries.set(entry.id, entry);
    installed.push(entry);
  }

  await saveState(paths, { version: 2, entries: [...entries.values()].sort((left, right) => left.id.localeCompare(right.id)) });
  return installed;
}

export async function removeArtifacts(ids: string[], home?: string): Promise<ManagedEntry[]> {
  const paths = resolveTargetPaths(home);
  const state = await loadState(paths);
  const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
  const removed: ManagedEntry[] = [];

  for (const id of ids) {
    const entry = entries.get(id);
    if (!entry) {
      continue;
    }

    await removePath(entry.exposurePath);
    await removePath(entry.basePath);
    await removePath(getMarkerPath(entry.basePath, entry.kind));
    entries.delete(id);
    removed.push(entry);
  }

  await saveState(paths, { version: 2, entries: [...entries.values()].sort((left, right) => left.id.localeCompare(right.id)) });
  return removed;
}

export interface InstallAllOptions {
  allowConflicts?: boolean;
  only?: string[];
}

export interface InstallAllResult {
  states: ArtifactState[];
  installed: ManagedEntry[];
  conflicts: ArtifactState[];
}

export async function installAllFromSource(
  sourcePath: string,
  home?: string,
  scanOptions?: ScanSourceOptions,
  resolveOptions?: ResolveSourceOptions,
  installOptions?: InstallAllOptions
): Promise<InstallAllResult> {
  const { scanSourceRepository } = await import("./source.js");
  const source = await resolveSourceInput(sourcePath, resolveOptions);

  try {
    const artifacts = (await scanSourceRepository(source.scanRoot, scanOptions)).map((artifact) => ({
      ...artifact,
      sourceRoot: source.sourceIdentity,
      requestedRef: source.requestedRef,
      resolvedCommit: source.resolvedCommit
    }));
    const { states } = await collectArtifactStates(artifacts, home, source.sourceIdentity);
    const selectedStates = installOptions?.only === undefined ? states : selectStates(states, installOptions.only);
    const { installable, conflicts } = partitionInstallAllStates(selectedStates);

    if (conflicts.length > 0 && installOptions?.allowConflicts !== true) {
      throw new InstallConflictError(conflicts);
    }

    const installed = await installArtifacts(installable, home);
    return { states, installed, conflicts };
  } finally {
    await source.cleanup();
  }
}
