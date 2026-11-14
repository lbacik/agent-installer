import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentInstallerConfig, expandHome, loadConfig } from "./config.js";
import { InstallFailedError, SourceConfigurationError } from "./errors.js";
import { formatConflictLine, formatExposureConflictLine } from "./format.js";
import { hashArtifactContent } from "./hash.js";
import { artifactId, getBasePath, getMarkerPath, resolveExposurePath, resolveHome, resolveTargetPaths, TargetPaths } from "./paths.js";
import { materializeOverlay, resolveInvocationPolicyOverlay } from "./skill-invocation-policy.js";
import { loadState, saveState } from "./state.js";
import type { ScanSourceOptions } from "./source.js";
import { resolveSourceInput, type ResolveSourceOptions } from "./source-resolver.js";
import {
  ArtifactKind,
  ArtifactState,
  ArtifactStatus,
  ContentIdentity,
  DiscoveredArtifact,
  ExposureConflictSummary,
  ExposureInstallRecord,
  ExposureKind,
  ExposurePlanEntry,
  ExposureRecord,
  ExposureState,
  InstallArtifactOutcome,
  InstallDisposition,
  InstallErrorCode,
  InstallExposureSummary,
  InstallOutcome,
  InstallPrunedOutcome,
  InstallRunOutcome,
  ManagedEntry,
  OverlayFile,
  OverlayRecord,
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

function conflictMessage(conflicts: ArtifactState[], exposureConflicts: ExposureConflictSummary[]): string {
  return [
    `Refusing to install: ${conflicts.length + exposureConflicts.length} artifact(s)/target(s) conflict with unmanaged targets.`,
    ...conflicts.map((state) => `  ${formatConflictLine(state)}`),
    ...exposureConflicts.map((conflict) => `  ${formatExposureConflictLine(conflict)}`),
    "Use --allow-conflicts to install the remaining eligible artifacts and skip these."
  ].join("\n");
}

// Thrown by installAllFromSource when unmanaged conflicts block the install and --allow-conflicts was not passed.
export class InstallConflictError extends Error {
  constructor(
    public readonly conflicts: ArtifactState[],
    public readonly exposureConflicts: ExposureConflictSummary[] = []
  ) {
    super(conflictMessage(conflicts, exposureConflicts));
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

function partitionSelectors(states: ArtifactState[], only: string[]): { matched: ArtifactState[]; unmatched: string[] } {
  const byId = new Map(states.map((state) => [state.id, state]));
  const unmatched = [...new Set(only.filter((id) => !byId.has(id)))];
  const matched = [...new Set(only)].filter((id) => byId.has(id)).map((id) => byId.get(id) as ArtifactState);
  return { matched, unmatched };
}

function selectStates(states: ArtifactState[], only: string[]): ArtifactState[] {
  const { matched, unmatched } = partitionSelectors(states, only);
  if (unmatched.length > 0) {
    throw new UnmatchedSelectorsError(unmatched);
  }

  return matched;
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

export function exposureKindOf(kind: ArtifactKind): ExposureKind {
  return kind === "skill" ? "skills" : "prompts";
}

/** Base-store-relative location: the skill name, or `<name>.md` for a prompt. */
export function getStoreRelativePath(
  paths: TargetPaths,
  artifact: Pick<DiscoveredArtifact, "kind" | "name">
): string {
  const dir = artifact.kind === "skill" ? paths.agentsSkillsDir : paths.agentsPromptsDir;
  const entryName = artifact.kind === "skill" ? artifact.name : `${artifact.name}.md`;
  return path.relative(dir, path.join(dir, entryName));
}

export function overlayToRecord(overlay: OverlayFile): OverlayRecord {
  return { id: overlay.id, version: overlay.version, paths: [overlay.relativePath], effect: overlay.effect };
}

// Computes, for one artifact, the desired exposure at every currently configured target
// that declares its kind. Never touches disk beyond reading whether a path exists and,
// if so, what it links to -- callers decide whether/how to act on the plan.
export async function buildExposurePlan(
  config: AgentInstallerConfig | null,
  home: string,
  artifact: Pick<DiscoveredArtifact, "kind" | "name">,
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

// Creates (or repairs) one owned exposure symlink and verifies it actually resolves to
// basePath afterward. Shared by install's applyExposurePlan and sync's
// applyEntrySyncActions so both create exposures the same way.
export async function createOwnedSymlink(basePath: string, targetPath: string): Promise<boolean> {
  return (await tryCreateOwnedSymlink(basePath, targetPath)).ok;
}

export async function tryCreateOwnedSymlink(
  basePath: string,
  targetPath: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await ensureParentDir(targetPath);
    await removePath(targetPath);
    await fs.symlink(basePath, targetPath);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if ((await readSymlinkTarget(targetPath)) === basePath) {
    return { ok: true };
  }

  return { ok: false, reason: `Exposure path ${targetPath} did not verify as a symlink to the managed copy after creation.` };
}

export type RevalidatedRemoval = "removed" | "already-gone" | "foreign";

// Immediately before deleting an exposure symlink, revalidates it is still an owned
// symlink to basePath (ownership revalidation). A path already gone is treated as
// nothing to report; a path a foreign file/dir/symlink has since replaced is left
// alone. Shared by install's removeArtifacts and sync's applyEntrySyncActions so both
// delete exposures under the same safety rule.
export async function revalidateAndRemove(targetPath: string, basePath: string): Promise<RevalidatedRemoval> {
  if (!(await pathExists(targetPath))) {
    return "already-gone";
  }

  if ((await readSymlinkTarget(targetPath)) !== basePath) {
    return "foreign";
  }

  await removePath(targetPath);
  return "removed";
}

// Applies one artifact's exposure plan, best-effort per target: a "new" entry is
// (re)created, a "match" entry is left alone, and a "conflict" entry is never touched.
// A failed creation is skipped rather than retried or rolled back, so a later target's
// success is never undone by an earlier target's failure. The returned exposures
// reflect exactly what verified as correct on disk after every attempt, merged with
// whatever the entry already owns outside the current plan (e.g. a legacy exposure, or
// one for a target no longer declared in config.yaml).
async function applyExposurePlanDetailed(
  plan: ExposurePlanEntry[],
  basePath: string,
  existingExposures: ExposureRecord[]
): Promise<{ exposures: ExposureRecord[]; results: ExposureInstallRecord[] }> {
  const byPath = new Map(existingExposures.map((exposure) => [exposure.path, exposure]));
  const results: ExposureInstallRecord[] = [];

  for (const entry of plan) {
    if (entry.status === "conflict") {
      results.push({
        targetName: entry.targetName,
        path: entry.path,
        result: "conflict",
        reason: entry.reason ?? "conflict"
      });
      continue;
    }

    if (entry.status === "match") {
      byPath.set(entry.path, { path: entry.path, targetName: entry.targetName });
      results.push({ targetName: entry.targetName, path: entry.path, result: "present" });
      continue;
    }

    const created = await tryCreateOwnedSymlink(basePath, entry.path);
    if (created.ok) {
      byPath.set(entry.path, { path: entry.path, targetName: entry.targetName });
      results.push({ targetName: entry.targetName, path: entry.path, result: "created" });
    } else {
      results.push({
        targetName: entry.targetName,
        path: entry.path,
        result: "failed",
        reason: `Could not create exposure for target "${entry.targetName}" at ${entry.path}: ${created.reason}`
      });
    }
  }

  return { exposures: [...byPath.values()], results };
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

/** Test seam: corrupts the just-written base copy so post-write verification must fail. */
async function corruptInstalledCopy(kind: ArtifactKind, basePath: string): Promise<void> {
  const target = kind === "skill" ? path.join(basePath, "SKILL.md") : basePath;
  await fs.appendFile(target, "\n# injected corruption for verification-failure testing\n", "utf8");
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
  expected: ContentIdentity,
  installedContent: ContentIdentity,
  overlay: OverlayFile | null,
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
    sourceHash: expected.digest,
    installedHash: installedContent.digest,
    hashAlgorithm: expected.algorithm,
    overlays: overlay === null ? [] : [overlayToRecord(overlay)],
    installedAt: new Date().toISOString(),
    requestedRef: artifact.requestedRef,
    resolvedCommit: artifact.resolvedCommit
  };
}

// Maps one desired exposure plan entry to its reportable ExposureState. A "match"
// entry mirrors the content check (a correct link still serves stale content after
// a source change); anything desired-but-not-"match" reports as its own drift
// ("new") or blockage ("conflict"). Shared by scan's `collectArtifactStates` and
// list's JSON reporting so both read the plan the same way.
export function planEntryToExposureState(entry: ExposurePlanEntry, contentMatches: boolean): ExposureState {
  if (entry.status === "conflict") {
    return {
      targetName: entry.targetName,
      path: entry.path,
      status: "conflict",
      conflictReason: entry.reason ?? "conflict",
      conflictPath: entry.path
    };
  }

  if (entry.status === "new") {
    return { targetName: entry.targetName, path: entry.path, status: "new" };
  }

  const status: ArtifactStatus = contentMatches ? "installed-same" : "installed-different";
  return { targetName: entry.targetName, path: entry.path, status };
}

// Scan-side wrapper: when the base copy does not exist yet the whole artifact is
// "new", so every desired exposure reports as "new" too, except conflicts,
// which still report as conflicts so install can name them.
function exposureStateForPlanEntry(
  entry: ExposurePlanEntry,
  contentMatches: boolean,
  baseIsNew: boolean
): ExposureState {
  if (baseIsNew && entry.status !== "conflict") {
    return { targetName: entry.targetName, path: entry.path, status: "new" };
  }

  return planEntryToExposureState(entry, contentMatches);
}

// Reports the legacy (`targetName: null`) exposures the installer still owns for
// one artifact. Legacy links are never repaired or re-targeted here; a correct
// link mirrors the content check, while a missing or foreign link reports as
// drift (never as a conflict). Recorded exposures for named targets are sync's
// domain and are intentionally left out: scan reports what is desired plus what
// is legacy, not orphans awaiting `sync` cleanup.
async function legacyExposureStates(
  managedEntry: ManagedEntry | null,
  plannedPaths: Set<string>,
  basePath: string,
  contentMatches: boolean,
  baseIsNew: boolean
): Promise<ExposureState[]> {
  const states: ExposureState[] = [];
  for (const record of managedEntry?.exposures ?? []) {
    if (record.targetName !== null || plannedPaths.has(record.path)) {
      continue;
    }

    let status: ArtifactStatus;
    if (baseIsNew) {
      status = "new";
    } else {
      const linkTarget = await readSymlinkTarget(record.path);
      status = linkTarget === basePath ? (contentMatches ? "installed-same" : "installed-different") : "installed-different";
    }

    states.push({ targetName: null, path: record.path, status });
  }

  return states;
}

// Builds the reportable `exposures[]` for one artifact: one entry per desired
// (target, kind) pair from the current `config.yaml`, plus one per owned legacy
// exposure. Never called for a basePath conflict.
async function buildExposureStates(
  exposurePlan: ExposurePlanEntry[],
  managedEntry: ManagedEntry | null,
  basePath: string,
  contentMatches: boolean,
  baseIsNew: boolean
): Promise<ExposureState[]> {
  const states = exposurePlan.map((entry) => exposureStateForPlanEntry(entry, contentMatches, baseIsNew));
  const plannedPaths = new Set(exposurePlan.map((entry) => entry.path));
  states.push(...(await legacyExposureStates(managedEntry, plannedPaths, basePath, contentMatches, baseIsNew)));
  return states;
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
    const sourceContent = await hashArtifactContent(artifact.kind, artifact.sourcePath, overlay);
    const managedEntry = entriesById.get(id) ?? null;
    const basePath = getBasePath(paths, artifact);

    let status: ArtifactState["status"] = "new";
    let installedContent: ContentIdentity | null = null;
    let conflictReason: string | undefined;
    let conflictPath: string | undefined;

    const baseExists = await pathExists(basePath);

    if (!baseExists) {
      status = "new";
    } else if (managedEntry && managedEntry.sourceRoot === artifact.sourceRoot) {
      installedContent = await hashArtifactContent(artifact.kind, basePath);
      status = installedContent.digest === sourceContent.digest ? "installed-same" : "installed-different";
    } else {
      status = "conflict";
      conflictReason = "A target path already exists but is not managed by this installer.";
      conflictPath = basePath;
      installedContent = await hashArtifactContent(artifact.kind, basePath);
    }

    // A basePath conflict blocks the whole artifact, so its exposures are never
    // evaluated; otherwise a desired-but-missing or conflicting exposure counts as
    // drift, bumping an otherwise-unchanged artifact to "installed-different" so
    // install picks it back up. A single-exposure conflict never sets the aggregate
    // to "conflict"; only the basePath conflict above does that.
    const exposurePlan = status === "conflict" ? [] : await buildExposurePlan(config, resolvedHome, artifact, basePath);
    const contentMatches = status === "installed-same";
    const baseIsNew = !baseExists;
    if (status === "installed-same" && exposurePlan.some((entry) => entry.status !== "match")) {
      status = "installed-different";
    }

    const exposures =
      status === "conflict" ? [] : await buildExposureStates(exposurePlan, managedEntry, basePath, contentMatches, baseIsNew);

    const nextState: ArtifactState = {
      artifact,
      id,
      basePath,
      sourceHash: sourceContent.digest,
      installedHash: installedContent?.digest ?? null,
      overlay,
      sourceContent,
      installedContent,
      exposurePlan,
      exposures,
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
  return saveState(paths, { version: 4, entries: [...entries.values()].sort((left, right) => left.id.localeCompare(right.id)) });
}

function sameExposureSet(left: ExposureRecord[], right: ExposureRecord[]): boolean {
  const key = (exposure: ExposureRecord): string => `${exposure.targetName ?? ""}\n${exposure.path}`;
  const leftKeys = new Set(left.map(key));
  const rightKeys = new Set(right.map(key));
  return leftKeys.size === rightKeys.size && [...leftKeys].every((item) => rightKeys.has(item));
}

interface SingleInstallResult {
  entry: ManagedEntry;
  disposition: Extract<InstallDisposition, "installed" | "updated" | "unchanged">;
  exposureResults: ExposureInstallRecord[];
  installedContent: ContentIdentity;
}

// Installs one reconciled artifact: writes the base copy when content drifted
// (verifying the write afterward), skips the write when the copy already
// verifies, and always converges the configured exposures best-effort. Throws
// for basePath conflicts and for write/verification failures; a failed
// exposure creation is reported, never thrown.
async function executeArtifactInstall(
  current: ArtifactState,
  paths: TargetPaths,
  entries: Map<string, ManagedEntry>
): Promise<SingleInstallResult> {
  if (current.status === "conflict") {
    throw new Error(`Cannot install ${current.id}: ${current.conflictReason}`);
  }

  const expected = current.sourceContent;
  const overlay = current.overlay;
  const existingExposures = entries.get(current.id)?.exposures ?? [];
  const needsWrite = current.installedContent === null || current.installedContent.digest !== expected.digest;

  // Test seam for the failure-partway acceptance path (see docs/content-identity.md): fail before any write.
  if (process.env.AGENT_INSTALLER_TEST_FAIL_WRITE === current.id) {
    throw new InstallFailedError(
      current.id,
      "install-failed",
      `Injected install failure for ${current.id} (AGENT_INSTALLER_TEST_FAIL_WRITE).`
    );
  }

  if (!needsWrite) {
    // Unchanged: verified, not written. Missing exposures are still repaired,
    // and the state entry advances to this run's provenance, content identity
    // and overlays whenever any of them (or the exposure set) actually changed.
    const { exposures, results } = await applyExposurePlanDetailed(current.exposurePlan, current.basePath, existingExposures);
    const previous = entries.get(current.id);
    let entry: ManagedEntry;
    if (previous !== undefined) {
      const refreshed = refreshUnchangedEntry(previous, current, exposures);
      if (refreshed !== null) {
        entries.set(refreshed.id, refreshed);
        await saveEntries(paths, entries);
      }
      entry = entries.get(current.id)!;
    } else {
      entry = buildManagedEntry(current.artifact, paths, expected, current.installedContent!, overlay, exposures);
      entries.set(entry.id, entry);
      await saveEntries(paths, entries);
    }

    return { entry, disposition: "unchanged", exposureResults: results, installedContent: current.installedContent! };
  }

  await copyArtifact(current.artifact, current.basePath);

  // Test seam for the post-write verification acceptance path: corrupt the copy so it cannot match.
  if (process.env.AGENT_INSTALLER_TEST_CORRUPT_WRITE === current.id) {
    await corruptInstalledCopy(current.artifact.kind, current.basePath);
  }

  const installedContent = await hashArtifactContent(current.artifact.kind, current.basePath);
  if (installedContent.digest !== expected.digest) {
    // Record what is actually on disk, then stop the run like any other failure.
    const entry = buildManagedEntry(current.artifact, paths, expected, installedContent, overlay, existingExposures);
    entries.set(entry.id, entry);
    await saveEntries(paths, entries);
    throw new InstallFailedError(
      current.id,
      "verification-failed",
      `Post-write verification failed for ${current.id}: the installed copy does not match the expected source content.`
    );
  }

  const { exposures, results } = await applyExposurePlanDetailed(current.exposurePlan, current.basePath, existingExposures);
  const entry = buildManagedEntry(current.artifact, paths, expected, installedContent, overlay, exposures);
  await writeMarker(entry);
  entries.set(entry.id, entry);
  await saveEntries(paths, entries);

  return {
    entry,
    disposition: current.status === "new" ? "installed" : "updated",
    exposureResults: results,
    installedContent
  };
}

// Each artifact's base copy and every one of its target exposures are installed and
// persisted before moving to the next artifact, so a mid-run crash never leaves more
// than one artifact's state out of sync with what is actually on disk (multi-target
// work within a single artifact is itself best-effort with no rollback; see
// applyExposurePlanDetailed).
export async function installArtifacts(states: ArtifactState[], home?: string): Promise<ManagedEntry[]> {
  const paths = resolveTargetPaths(home);
  const state = await loadState(paths);
  const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
  const installed: ManagedEntry[] = [];

  for (const current of states) {
    const result = await executeArtifactInstall(current, paths, entries);
    installed.push(result.entry);
  }

  return installed;
}

// Advances one verified-but-unwritten entry to this run's provenance, content
// identity and overlays without touching files, symlinks, markers, or
// `installedAt`. Reconciliation already rehashed the Base Store copy and
// compared it with this commit's expected source content, so recording this
// run's `requestedRef`/`resolvedCommit`, the v2 hash algorithm and the real
// overlays is safe. Returns the refreshed entry, or null when the stored entry
// already matches this run on every refreshed field.
function refreshUnchangedEntry(
  existing: ManagedEntry,
  current: ArtifactState,
  exposures: ExposureRecord[]
): ManagedEntry | null {
  if (current.installedContent === null) {
    return null;
  }

  const overlayRecords = current.overlay === null ? [] : [overlayToRecord(current.overlay)];
  const requestedRef = current.artifact.requestedRef;
  const resolvedCommit = current.artifact.resolvedCommit;
  if (
    sameExposureSet(existing.exposures, exposures) &&
    existing.sourceHash === current.sourceContent.digest &&
    existing.installedHash === current.installedContent.digest &&
    existing.hashAlgorithm === current.sourceContent.algorithm &&
    existing.requestedRef === requestedRef &&
    existing.resolvedCommit === resolvedCommit &&
    JSON.stringify(existing.overlays) === JSON.stringify(overlayRecords)
  ) {
    return null;
  }

  const refreshed: ManagedEntry = {
    ...existing,
    exposures,
    sourceHash: current.sourceContent.digest,
    installedHash: current.installedContent.digest,
    hashAlgorithm: current.sourceContent.algorithm,
    overlays: overlayRecords,
    requestedRef,
    resolvedCommit
  };
  if (requestedRef === undefined) {
    delete refreshed.requestedRef;
  }
  if (resolvedCommit === undefined) {
    delete refreshed.resolvedCommit;
  }

  return refreshed;
}

// Refreshes provenance for selected artifacts that reconciled as `installed-same`
// during this run. Pure installed-same artifacts never pass through
// executeArtifactInstall, so their entries advance here; each refreshed entry
// is persisted as it completes, bounding a mid-run crash to at most one unsaved
// artifact. Local sources carry no Git provenance, so callers must only invoke
// this for remote sources.
async function refreshUnchangedProvenance(selectedStates: ArtifactState[], home?: string): Promise<void> {
  const candidates = selectedStates.filter(
    (state) => state.status === "installed-same" && state.managedEntry !== null && state.installedContent !== null
  );
  if (candidates.length === 0) {
    return;
  }

  const paths = resolveTargetPaths(home);
  const state = await loadState(paths);
  const entries = new Map(state.entries.map((entry) => [entry.id, entry]));

  for (const current of candidates) {
    const existing = entries.get(current.id);
    if (!existing) {
      continue;
    }

    // Pure installed-same artifacts keep every owned exposure as-is; only the
    // recorded provenance/identity/overlays advance to this run.
    const refreshed = refreshUnchangedEntry(existing, current, existing.exposures);
    if (refreshed === null) {
      continue;
    }

    entries.set(refreshed.id, refreshed);
    await saveEntries(paths, entries);
  }
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
      if ((await revalidateAndRemove(exposure.path, entry.basePath)) === "foreign") {
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

export interface InstallRequest {
  sourcePath: string;
  home?: string | undefined;
  scanOptions?: ScanSourceOptions | undefined;
  resolveOptions?: ResolveSourceOptions | undefined;
  allowConflicts?: boolean | undefined;
  only?: string[] | undefined;
  prune?: boolean | undefined;
}

export interface InstallAllResult {
  states: ArtifactState[];
  installed: ManagedEntry[];
  conflicts: ArtifactState[];
  exposureConflicts: ExposureConflictSummary[];
  pruned: RemovedArtifactState[];
  prunedSkippedExposures: SkippedExposureRemoval[];
  outcome: InstallOutcome;
}

function nullProvenance(value: string | undefined): string | null {
  return value ?? null;
}

function baseOutcomeRecord(
  paths: TargetPaths,
  state: ArtifactState,
  disposition: InstallArtifactOutcome["disposition"]
): InstallArtifactOutcome {
  return {
    id: state.id,
    kind: state.artifact.kind,
    name: state.artifact.name,
    sourceIdentity: state.artifact.sourceRoot,
    relativeSourcePath: state.artifact.relativeSourcePath,
    status: state.status,
    disposition,
    exposures: [],
    basePath: state.basePath,
    storeRelativePath: getStoreRelativePath(paths, state.artifact),
    requestedRef: nullProvenance(state.artifact.requestedRef),
    resolvedCommit: nullProvenance(state.artifact.resolvedCommit),
    overlays: []
  };
}

function unchangedOutcomeRecord(paths: TargetPaths, state: ArtifactState): InstallArtifactOutcome {
  const installedContent = state.installedContent!;
  return {
    ...baseOutcomeRecord(paths, state, "unchanged"),
    exposures: state.exposurePlan.map((entry) => ({
      targetName: entry.targetName,
      path: entry.path,
      result: "present" as const
    })),
    content: {
      algorithm: state.sourceContent.algorithm,
      expectedHash: state.sourceContent.digest,
      installedHash: installedContent.digest
    },
    files: installedContent.files,
    overlays: state.overlay === null ? [] : [overlayToRecord(state.overlay)]
  };
}

function installedOutcomeRecord(
  paths: TargetPaths,
  state: ArtifactState,
  result: SingleInstallResult
): InstallArtifactOutcome {
  const expected = state.sourceContent;
  return {
    ...baseOutcomeRecord(paths, state, result.disposition),
    exposures: result.exposureResults,
    content: {
      algorithm: expected.algorithm,
      expectedHash: expected.digest,
      installedHash: result.installedContent.digest
    },
    // The inventory always describes what actually verified on disk.
    files: result.installedContent.files,
    overlays: state.overlay === null ? [] : [overlayToRecord(state.overlay)]
  };
}

function failedOutcomeRecord(
  paths: TargetPaths,
  state: ArtifactState,
  code: InstallErrorCode,
  message: string,
  installedContent: ContentIdentity | null
): InstallArtifactOutcome {
  const record = baseOutcomeRecord(paths, state, "failed");
  if (installedContent !== null) {
    record.content = {
      algorithm: state.sourceContent.algorithm,
      expectedHash: state.sourceContent.digest,
      installedHash: installedContent.digest
    };
    record.files = installedContent.files;
  }
  if (state.overlay !== null) {
    record.overlays = [overlayToRecord(state.overlay)];
  }
  record.failure = { code, message };
  return record;
}

function classifyInstallFailure(error: unknown, id: string): { code: InstallErrorCode; message: string } {
  if (error instanceof InstallFailedError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof SourceConfigurationError) {
    return { code: "source-configuration", message: error.message };
  }

  return { code: "install-failed", message: error instanceof Error ? error.message : String(error) };
}

function computeExposureSummary(
  config: AgentInstallerConfig | null,
  selectedStates: ArtifactState[],
  exposureResults: ExposureInstallRecord[],
  retainedPruneExposures: number
): InstallExposureSummary {
  const requestedKinds = new Set(selectedStates.map((state) => state.artifact.kind));
  if (config === null || requestedKinds.size === 0) {
    return "not-configured";
  }

  const declaredKinds = new Set<ArtifactKind>();
  for (const target of Object.values(config.targets)) {
    if (target.skills !== undefined) {
      declaredKinds.add("skill");
    }

    if (target.prompts !== undefined) {
      declaredKinds.add("prompt");
    }
  }

  if (![...requestedKinds].some((kind) => declaredKinds.has(kind))) {
    return "not-configured";
  }

  const troubled = exposureResults.some((result) => result.result === "conflict" || result.result === "failed");
  return troubled || retainedPruneExposures > 0 ? "partial" : "complete";
}

function buildErrorOutcome(
  paths: TargetPaths,
  code: InstallErrorCode,
  message: string,
  extra?: Partial<InstallOutcome>
): InstallOutcome {
  return {
    schemaVersion: 3,
    kind: "agent-installer.install-report",
    baseStore: { skills: paths.agentsSkillsDir, prompts: paths.agentsPromptsDir },
    outcome: "aborted",
    exposureOutcome: "not-configured",
    artifacts: [],
    unmatchedSelectors: [],
    pruned: [],
    error: { code, message },
    ...extra
  };
}

/**
 * Runs a full install and returns the versioned, complete Install Outcome:
 * exactly one record per requested artifact on success and on every failure
 * path. Classified failures (unmatched selectors, strict conflicts, mid-run
 * failures) are encoded in the outcome, never thrown; source, config, and
 * scan errors still throw for the caller to classify.
 */
export async function runInstall(request: InstallRequest): Promise<InstallAllResult> {
  const paths = resolveTargetPaths(request.home);
  const config = await loadConfig(paths, request.home);
  const { scanSourceRepository } = await import("./source.js");
  const source = await resolveSourceInput(request.sourcePath, request.resolveOptions);

  try {
    const artifacts = (await scanSourceRepository(source.scanRoot, request.scanOptions)).map((artifact) => ({
      ...artifact,
      sourceRoot: source.sourceIdentity,
      requestedRef: source.requestedRef,
      resolvedCommit: source.resolvedCommit
    }));
    const { states, removed } = await collectArtifactStates(artifacts, request.home, source.sourceIdentity);

    const empty: Omit<InstallAllResult, "states" | "outcome"> = {
      installed: [],
      conflicts: [],
      exposureConflicts: [],
      pruned: [],
      prunedSkippedExposures: []
    };

    // --only selection: unmatched selectors abort before anything is installed,
    // with every matched artifact recorded as not-attempted.
    let selectedStates: ArtifactState[];
    let unmatchedSelectors: string[] = [];
    if (request.only !== undefined) {
      const partitioned = partitionSelectors(states, request.only);
      unmatchedSelectors = partitioned.unmatched;
      selectedStates = partitioned.matched;
      if (unmatchedSelectors.length > 0) {
        const outcome: InstallOutcome = {
          ...buildErrorOutcome(paths, "unmatched-selector", `No discovered artifact matches: ${unmatchedSelectors.join(", ")}`, {
            exposureOutcome: computeExposureSummary(config, selectedStates, [], 0)
          }),
          artifacts: selectedStates.map((state) => baseOutcomeRecord(paths, state, "not-attempted")),
          unmatchedSelectors
        };
        return { states, ...empty, outcome };
      }
    } else {
      selectedStates = states;
    }

    const { installable, conflicts } = partitionInstallAllStates(selectedStates);
    const exposureConflicts = collectExposureConflicts(selectedStates);

    // Strict-mode refusal: nothing is installed; base conflicts record as
    // conflict with no exposures (never evaluated), exposure conflicts record
    // as conflict with their pairs structured in exposures[].
    if ((conflicts.length > 0 || exposureConflicts.length > 0) && request.allowConflicts !== true) {
      const exposureConflictIds = new Set(exposureConflicts.map((conflict) => conflict.id));
      const outcome: InstallOutcome = {
        ...buildErrorOutcome(paths, "conflict", conflictMessage(conflicts, exposureConflicts), {
          exposureOutcome: computeExposureSummary(
            config,
            selectedStates,
            exposureConflicts.map((conflict) => ({
              targetName: conflict.targetName,
              path: conflict.path,
              result: "conflict" as const,
              reason: conflict.reason
            })),
            0
          )
        }),
        artifacts: selectedStates.map((state) => {
          if (state.status === "conflict") {
            return baseOutcomeRecord(paths, state, "conflict");
          }

          if (exposureConflictIds.has(state.id)) {
            const record = baseOutcomeRecord(paths, state, "conflict");
            record.exposures = state.exposurePlan
              .filter((entry) => entry.status === "conflict")
              .map((entry) => ({
                targetName: entry.targetName,
                path: entry.path,
                result: "conflict" as const,
                reason: entry.reason ?? "conflict"
              }));
            return record;
          }

          return baseOutcomeRecord(paths, state, "not-attempted");
        })
      };
      return { states, installed: [], conflicts, exposureConflicts, pruned: [], prunedSkippedExposures: [], outcome };
    }

    // Sequential install in selected order: each artifact's base copy and
    // exposures persist before moving on, so a mid-run failure leaves at most
    // one artifact out of sync. The first failure stops the run; everything
    // already written keeps its real disposition.
    const state = await loadState(paths);
    const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
    const installed: ManagedEntry[] = [];
    const recordsById = new Map<string, InstallArtifactOutcome>();
    let failure: { state: ArtifactState; code: InstallErrorCode; message: string; installedContent: ContentIdentity | null } | null =
      null;

    for (const current of installable) {
      try {
        const result = await executeArtifactInstall(current, paths, entries);
        installed.push(result.entry);
        recordsById.set(current.id, installedOutcomeRecord(paths, current, result));
      } catch (error) {
        const classified = classifyInstallFailure(error, current.id);
        let installedContent: ContentIdentity | null = null;
        if (classified.code === "verification-failed") {
          try {
            installedContent = await hashArtifactContent(current.artifact.kind, current.basePath);
          } catch {
            installedContent = null;
          }
        }

        failure = { state: current, code: classified.code, message: classified.message, installedContent };
        break;
      }
    }

    if (failure !== null) {
      const outcome: InstallOutcome = {
        ...buildErrorOutcome(paths, failure.code, failure.message, {
          exposureOutcome: computeExposureSummary(
            config,
            selectedStates,
            [...recordsById.values()].flatMap((record) => record.exposures),
            0
          )
        }),
        artifacts: selectedStates.map((selected) => {
          const done = recordsById.get(selected.id);
          if (done !== undefined) {
            return done;
          }

          if (selected.id === failure!.state.id) {
            return failedOutcomeRecord(paths, selected, failure!.code, failure!.message, failure!.installedContent);
          }

          if (selected.status === "conflict") {
            return baseOutcomeRecord(paths, selected, "conflict");
          }

          // Installed-same artifacts need no write, so a failure elsewhere leaves
          // them verified-but-unreached: on an aborted run every non-implicated
          // record reads as not-attempted.
          return baseOutcomeRecord(paths, selected, "not-attempted");
        })
      };
      return { states, installed, conflicts, exposureConflicts, pruned: [], prunedSkippedExposures: [], outcome };
    }

    // A selected artifact that reconciled as `installed-same` verified this run's
    // content by rehashing the Base Store copy, so its entry records this run's
    // Git provenance (plus the v2 hash algorithm and real overlays) without
    // rewriting files, symlinks, markers, or `installedAt`. Local sources carry
    // no Git provenance and are left byte-for-byte unchanged. Bumped
    // installed-different artifacts with matching content already advanced
    // through executeArtifactInstall above.
    if (source.resolvedCommit !== undefined) {
      await refreshUnchangedProvenance(selectedStates, request.home);
    }

    for (const current of selectedStates) {
      if (recordsById.has(current.id)) {
        continue;
      }

      if (current.status === "conflict") {
        recordsById.set(current.id, baseOutcomeRecord(paths, current, "conflict"));
      } else if (current.status === "installed-same") {
        recordsById.set(current.id, unchangedOutcomeRecord(paths, current));
      }
    }

    let pruned: RemovedArtifactState[] = [];
    let prunedSkippedExposures: SkippedExposureRemoval[] = [];
    let prunedOutcomes: InstallPrunedOutcome[] = [];
    if (request.prune === true && removed.length > 0) {
      const pruneResult = await removeArtifacts(removed.map((entry) => entry.id), request.home);
      pruned = removed;
      prunedSkippedExposures = pruneResult.skippedExposures;
      const skippedById = new Map<string, Set<string>>();
      for (const skipped of prunedSkippedExposures) {
        const paths = skippedById.get(skipped.id) ?? new Set<string>();
        paths.add(skipped.path);
        skippedById.set(skipped.id, paths);
      }

      prunedOutcomes = removed.map((entry) => {
        const retained = skippedById.get(entry.id) ?? new Set<string>();
        return {
          id: entry.id,
          basePath: entry.basePath,
          storeRelativePath: getStoreRelativePath(paths, entry),
          requestedRef: nullProvenance(entry.managedEntry.requestedRef),
          resolvedCommit: nullProvenance(entry.managedEntry.resolvedCommit),
          removedExposures: entry.managedEntry.exposures
            .filter((exposure) => !retained.has(exposure.path))
            .map((exposure) => ({ path: exposure.path, targetName: exposure.targetName })),
          retainedExposures: entry.managedEntry.exposures
            .filter((exposure) => retained.has(exposure.path))
            .map((exposure) => ({ path: exposure.path, targetName: exposure.targetName }))
        };
      });
    }

    const records = selectedStates.map((selected) => recordsById.get(selected.id)!);
    const runOutcome: InstallRunOutcome = records.some((record) => record.disposition === "conflict")
      ? "partial"
      : "complete";
    const outcome: InstallOutcome = {
      schemaVersion: 3,
      kind: "agent-installer.install-report",
      baseStore: { skills: paths.agentsSkillsDir, prompts: paths.agentsPromptsDir },
      outcome: runOutcome,
      exposureOutcome: computeExposureSummary(
        config,
        selectedStates,
        records.flatMap((record) => record.exposures),
        prunedOutcomes.reduce((count, pruned) => count + pruned.retainedExposures.length, 0)
      ),
      artifacts: records,
      unmatchedSelectors,
      pruned: prunedOutcomes
    };

    return { states, installed, conflicts, exposureConflicts, pruned, prunedSkippedExposures, outcome };
  } finally {
    await source.cleanup();
  }
}

export async function installAllFromSource(
  sourcePath: string,
  home?: string,
  scanOptions?: ScanSourceOptions,
  resolveOptions?: ResolveSourceOptions,
  installOptions?: InstallAllOptions
): Promise<InstallAllResult> {
  const result = await runInstall({
    sourcePath,
    home,
    scanOptions,
    resolveOptions,
    allowConflicts: installOptions?.allowConflicts,
    only: installOptions?.only,
    prune: installOptions?.prune
  });

  // The legacy paths keep their throw semantics: v2 JSON and human-readable
  // output are built from the thrown error plus the returned fields, exactly
  // as before. Only v3 reads result.outcome directly.
  if (result.outcome.error?.code === "unmatched-selector") {
    throw new UnmatchedSelectorsError(result.outcome.unmatchedSelectors);
  }

  if (result.outcome.outcome === "aborted" && result.outcome.error?.code === "conflict") {
    throw new InstallConflictError(result.conflicts, result.exposureConflicts);
  }

  const failed = result.outcome.artifacts.find((record) => record.disposition === "failed");
  if (failed?.failure !== undefined) {
    throw new InstallFailedError(failed.id, failed.failure.code as InstallFailedError["code"], failed.failure.message);
  }

  return result;
}
