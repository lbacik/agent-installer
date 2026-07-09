import { promises as fs } from "node:fs";
import path from "node:path";
import { hashArtifact } from "./hash.js";
import { artifactId, getBasePath, getExposurePath, getMarkerPath, resolveTargetPaths, TargetPaths } from "./paths.js";
import { loadState, saveState } from "./state.js";
import type { ScanSourceOptions } from "./source.js";
import { resolveSourceInput, type ResolveSourceOptions } from "./source-resolver.js";
import { ArtifactState, DiscoveredArtifact, ManagedEntry, RemovedArtifactState } from "./types.js";

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

async function copyArtifact(artifact: DiscoveredArtifact, basePath: string): Promise<void> {
  await removePath(basePath);
  await ensureParentDir(basePath);

  if (artifact.kind === "skill") {
    await fs.cp(artifact.sourcePath, basePath, { recursive: true });
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
    installedAt: new Date().toISOString()
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
    const sourceHash = await hashArtifact(artifact.kind, artifact.sourcePath);
    const managedEntry = entriesById.get(id) ?? null;
    const basePath = getBasePath(paths, artifact);
    const exposurePath = getExposurePath(paths, artifact);

    let status: ArtifactState["status"] = "new";
    let installedHash: string | null = null;
    let conflictReason: string | undefined;

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
      const exposureValid = !exposureExists || symlinkTarget === expectedTarget;

      if (!exposureValid) {
        status = "conflict";
        conflictReason = `Exposure path already exists and does not point to "${expectedTarget}".`;
      } else if (installedHash === sourceHash) {
        status = "installed-same";
      } else {
        status = "installed-different";
      }
    } else {
      status = "conflict";
      conflictReason = "A target path already exists but is not managed by this installer.";
      if (baseExists) {
        installedHash = await hashArtifact(artifact.kind, basePath);
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

  await saveState(paths, { version: 1, entries: [...entries.values()].sort((left, right) => left.id.localeCompare(right.id)) });
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

  await saveState(paths, { version: 1, entries: [...entries.values()].sort((left, right) => left.id.localeCompare(right.id)) });
  return removed;
}

export async function installAllFromSource(
  sourcePath: string,
  home?: string,
  scanOptions?: ScanSourceOptions,
  resolveOptions?: ResolveSourceOptions
): Promise<ArtifactState[]> {
  const { scanSourceRepository } = await import("./source.js");
  const source = await resolveSourceInput(sourcePath, resolveOptions);

  try {
    const artifacts = (await scanSourceRepository(source.scanRoot, scanOptions)).map((artifact) => ({
      ...artifact,
      sourceRoot: source.sourceIdentity
    }));
    const { states } = await collectArtifactStates(artifacts, home, source.sourceIdentity);
    const installable = states.filter((state) => state.status === "new" || state.status === "installed-different");
    await installArtifacts(installable, home);
    return states;
  } finally {
    await source.cleanup();
  }
}
