import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentInstallerConfig, expandHome, loadConfig } from "./config.js";
import { formatConflictLine, formatExposureConflictLine } from "./format.js";
import { hashArtifact } from "./hash.js";
import { artifactId, getBasePath, getMarkerPath, resolveExposurePath, resolveHome, resolveTargetPaths, TargetPaths } from "./paths.js";
import { materializeOverlay, resolveInvocationPolicyOverlay } from "./skill-invocation-policy.js";
import { loadState, saveState } from "./state.js";
import type { ScanSourceOptions } from "./source.js";
import { resolveSourceInput, type ResolveSourceOptions } from "./source-resolver.js";
import {
  ArtifactState,
  DiscoveredArtifact,
  ExposureConflictSummary,
  ExposureKind,
  ExposurePlanEntry,
  ExposureRecord,
  ManagedEntry,
  OverlayFile,
  RemovedArtifactState,
  SkippedExposureRemoval
} from "./types.js";

export type { ExposureConflictSummary } from "./types.js";

export function collectExposureConflicts(states: ArtifactState[]): ExposureConflictSummary[] {
  return states.flatMap((state) =>
    state.exposurePlan
      .filter((entry) => entry.status === "conflict")
      .map((entry) => ({
        id: state.id,
        targetName: entry.targetName,
        kind: entry.kind,
        path: entry.path,
        reason: entry.reason ?? "conflict"
      }))
  );
}

// Thrown by installAllFromSource when unmanaged conflicts block the install and --allow-conflicts was not passed.
export class InstallConflictError extends Error {
  constructor(
    public readonly conflicts: ArtifactState[],
    public readonly exposureConflicts: ExposureConflictSummary[] = []
  ) {
    super(
      [
        `Refusing to install: ${conflicts.length + exposureConflicts.length} artifact(s)/target(s) conflict with unmanaged targets.`,
        ...conflicts.map((state) => `  ${formatConflictLine(state)}`),
        ...exposureConflicts.map((conflict) => `  ${formatExposureConflictLine(conflict)}`),
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

function exposureKindOf(kind: DiscoveredArtifact["kind"]): ExposureKind {
  return kind === "skill" ? "skills" : "prompts";
}

// Computes, for one artifact, the desired exposure at every currently configured target
// that declares its kind. Never touches disk beyond reading whether a path exists and,
// if so, what it links to -- callers decide whether/how to act on the plan.
async function buildExposurePlan(
  config: AgentInstallerConfig | null,
  home: string,
  artifact: DiscoveredArtifact,
  basePath: string
): Promise<ExposurePlanEntry[]> {
  if (config === null) {
    return [];
  }

  const kind = exposureKindOf(artifact.kind);
  const plan: ExposurePlanEntry[] = [];

  for (const [targetName, target] of Object.entries(config.targets)) {
    const rawDir = target[kind];
    if (rawDir === undefined) {
      continue;
    }

    const exposurePath = resolveExposurePath(expandHome(rawDir, home), artifact);

    if (!(await pathExists(exposurePath))) {
      plan.push({ targetName, kind, path: exposurePath, status: "new" });
      continue;
    }

    const symlinkTarget = await readSymlinkTarget(exposurePath);
    if (symlinkTarget === basePath) {
      plan.push({ targetName, kind, path: exposurePath, status: "match" });
    } else {
      plan.push({
        targetName,
        kind,
        path: exposurePath,
        status: "conflict",
        reason: `Exposure path for target "${targetName}" already exists but is not managed by this installer.`
      });
    }
  }

  return plan;
}

// Applies one artifact's exposure plan, best-effort per target: a "new" entry is
// (re)created, a "match" entry is left alone, and a "conflict" entry is never touched.
// A failed creation is skipped rather than retried or rolled back, so a later target's
// success is never undone by an earlier target's failure. The returned exposures
// reflect exactly what verified as correct on disk after every attempt, merged with
// whatever the entry already owned outside the current plan (e.g. a legacy exposure, or
// one for a target no longer declared in config.yaml).
async function applyExposurePlan(
  plan: ExposurePlanEntry[],
  basePath: string,
  existingExposures: ExposureRecord[]
): Promise<ExposureRecord[]> {
  const byPath = new Map(existingExposures.map((exposure) => [exposure.path, exposure]));

  for (const entry of plan) {
    if (entry.status === "conflict") {
      continue;
    }

    if (entry.status === "match") {
      byPath.set(entry.path, { path: entry.path, targetName: entry.targetName });
      continue;
    }

    try {
      await ensureParentDir(entry.path);
      await removePath(entry.path);
      await fs.symlink(basePath, entry.path);
    } catch {
      continue;
    }

    if ((await readSymlinkTarget(entry.path)) === basePath) {
      byPath.set(entry.path, { path: entry.path, targetName: entry.targetName });
    }
  }

  return [...byPath.values()];
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

export async function readSymlinkTarget(targetPath: string): Promise<string | null> {
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

// `existingExposures` carries forward whatever exposures a prior install already owns
// (e.g. a legacy Claude symlink migrated from state v2) so re-installing to update
// content never silently drops the installer's record of them.
function buildManagedEntry(
  artifact: DiscoveredArtifact,
  paths: TargetPaths,
  sourceHash: string,
  installedHash: string,
  existingExposures: ExposureRecord[]
): ManagedEntry {
  return {
    id: artifactId(artifact.kind, artifact.name),
    kind: artifact.kind,
    name: artifact.name,
    sourceRoot: artifact.sourceRoot,
    relativeSourcePath: artifact.relativeSourcePath,
    basePath: getBasePath(paths, artifact),
    exposures: existingExposures,
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
  const config = await loadConfig(paths, home);
  const resolvedHome = resolveHome(home);
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

    let status: ArtifactState["status"] = "new";
    let installedHash: string | null = null;
    let conflictReason: string | undefined;
    let conflictPath: string | undefined;

    const baseExists = await pathExists(basePath);

    if (!baseExists) {
      status = "new";
    } else if (managedEntry && managedEntry.sourceRoot === artifact.sourceRoot) {
      installedHash = await hashArtifact(artifact.kind, basePath);
      status = installedHash === sourceHash ? "installed-same" : "installed-different";
    } else {
      status = "conflict";
      conflictReason = "A target path already exists but is not managed by this installer.";
      conflictPath = basePath;
      installedHash = await hashArtifact(artifact.kind, basePath);
    }

    // A basePath conflict blocks the whole artifact, so its exposures are never
    // evaluated; otherwise a desired-but-missing exposure counts as drift, bumping an
    // otherwise-unchanged artifact to "installed-different" so install picks it back up.
    const exposurePlan = status === "conflict" ? [] : await buildExposurePlan(config, resolvedHome, artifact, basePath);
    if (status === "installed-same" && exposurePlan.some((entry) => entry.status === "new")) {
      status = "installed-different";
    }

    const nextState: ArtifactState = {
      artifact,
      id,
      basePath,
      sourceHash,
      installedHash,
      exposurePlan,
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
      status: "source-missing" as const,
      managedEntry: entry
    }));

  return { states, removed };
}

function saveEntries(paths: TargetPaths, entries: Map<string, ManagedEntry>): Promise<void> {
  return saveState(paths, { version: 3, entries: [...entries.values()].sort((left, right) => left.id.localeCompare(right.id)) });
}

// Each artifact's base copy and every one of its target exposures are installed and
// persisted before moving to the next artifact, so a mid-run crash never leaves more
// than one artifact's state out of sync with what is actually on disk (multi-target
// work within a single artifact is itself best-effort with no rollback; see
// applyExposurePlan).
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

    const installedHash = await hashArtifact(current.artifact.kind, current.basePath);
    const existingExposures = entries.get(current.id)?.exposures ?? [];
    const exposures = await applyExposurePlan(current.exposurePlan, current.basePath, existingExposures);
    const entry = buildManagedEntry(current.artifact, paths, current.sourceHash, installedHash, exposures);
    await writeMarker(entry);
    entries.set(entry.id, entry);
    installed.push(entry);

    await saveEntries(paths, entries);
  }

  return installed;
}

export interface RemoveArtifactsResult {
  removed: ManagedEntry[];
  skippedExposures: SkippedExposureRemoval[];
}

// Immediately before deleting each recorded exposure, re-verifies it is still a symlink
// pointing at the entry's basePath (ownership revalidation). A path a foreign
// file/dir/symlink has since replaced is left alone and its record retained rather than
// silently dropped; every other exposure, and the basePath and marker themselves
// (never revalidated -- ~/.agents is this tool's sole managed territory), are still
// removed. Each id is persisted right after it finishes, bounding a mid-run crash to at
// most one in-flight artifact.
export async function removeArtifacts(ids: string[], home?: string): Promise<RemoveArtifactsResult> {
  const paths = resolveTargetPaths(home);
  await loadConfig(paths, home);
  const state = await loadState(paths);
  const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
  const removed: ManagedEntry[] = [];
  const skippedExposures: SkippedExposureRemoval[] = [];

  for (const id of ids) {
    const entry = entries.get(id);
    if (!entry) {
      continue;
    }

    const retainedExposures: ExposureRecord[] = [];
    for (const exposure of entry.exposures) {
      if (!(await pathExists(exposure.path))) {
        continue;
      }

      if ((await readSymlinkTarget(exposure.path)) === entry.basePath) {
        await removePath(exposure.path);
      } else {
        retainedExposures.push(exposure);
        skippedExposures.push({ id, path: exposure.path, targetName: exposure.targetName });
      }
    }

    await removePath(entry.basePath);
    await removePath(getMarkerPath(entry.basePath, entry.kind));

    if (retainedExposures.length > 0) {
      entries.set(id, { ...entry, exposures: retainedExposures });
    } else {
      entries.delete(id);
    }

    removed.push(entry);
    await saveEntries(paths, entries);
  }

  return { removed, skippedExposures };
}

export interface InstallAllOptions {
  allowConflicts?: boolean;
  only?: string[];
  prune?: boolean;
}

export interface InstallAllResult {
  states: ArtifactState[];
  installed: ManagedEntry[];
  conflicts: ArtifactState[];
  exposureConflicts: ExposureConflictSummary[];
  pruned: RemovedArtifactState[];
  prunedSkippedExposures: SkippedExposureRemoval[];
}

export async function installAllFromSource(
  sourcePath: string,
  home?: string,
  scanOptions?: ScanSourceOptions,
  resolveOptions?: ResolveSourceOptions,
  installOptions?: InstallAllOptions
): Promise<InstallAllResult> {
  const { scanSourceRepository } = await import("./source.js");
  // Validated before touching the source, so a malformed config.yaml aborts before a
  // remote source is cloned rather than after paying for the clone.
  await loadConfig(resolveTargetPaths(home), home);
  const source = await resolveSourceInput(sourcePath, resolveOptions);

  try {
    const artifacts = (await scanSourceRepository(source.scanRoot, scanOptions)).map((artifact) => ({
      ...artifact,
      sourceRoot: source.sourceIdentity,
      requestedRef: source.requestedRef,
      resolvedCommit: source.resolvedCommit
    }));
    const { states, removed } = await collectArtifactStates(artifacts, home, source.sourceIdentity);
    const selectedStates = installOptions?.only === undefined ? states : selectStates(states, installOptions.only);
    const { installable, conflicts } = partitionInstallAllStates(selectedStates);
    const exposureConflicts = collectExposureConflicts(selectedStates);

    if ((conflicts.length > 0 || exposureConflicts.length > 0) && installOptions?.allowConflicts !== true) {
      throw new InstallConflictError(conflicts, exposureConflicts);
    }

    const installed = await installArtifacts(installable, home);

    let pruned: RemovedArtifactState[] = [];
    let prunedSkippedExposures: SkippedExposureRemoval[] = [];
    if (installOptions?.prune === true && removed.length > 0) {
      const pruneResult = await removeArtifacts(removed.map((entry) => entry.id), home);
      pruned = removed;
      prunedSkippedExposures = pruneResult.skippedExposures;
    }

    return { states, installed, conflicts, exposureConflicts, pruned, prunedSkippedExposures };
  } finally {
    await source.cleanup();
  }
}
