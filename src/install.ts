import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentInstallerConfig, loadConfig } from "./config.js";
import { InstallFailedError, SourceConfigurationError } from "./errors.js";
import { applyExposurePlanEntries, ensureParentDir, removeManagedExposures, removePath } from "./exposure-mutations.js";
import { observeExposures, pathExists } from "./exposures.js";
import { formatConflictLine, formatExposureConflictLine } from "./format.js";
import { hashArtifactContent } from "./hash.js";
import { artifactId, getBasePath, getMarkerPath, resolveHome, resolveTargetPaths, TargetPaths } from "./paths.js";
import { conflictsShouldBlock, partitionSelectedById } from "./selection.js";
import { materializeOverlay, resolveInvocationPolicyOverlay } from "./skill-invocation-policy.js";
import { loadState, saveSortedEntries } from "./state.js";
import type { ScanSourceOptions } from "./source.js";
import type { ResolveSourceOptions } from "./source-resolver.js";
import {
  ArtifactKind,
  ArtifactState,
  ContentIdentity,
  DiscoveredArtifact,
  ExposureConflictSummary,
  ExposureInstallRecord,
  ExposureRecord,
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
// Re-exported so existing importers (`json-report.js`, `sync.js`, tests) keep
// working: the implementations live in `./exposures.js`, the single module
// that owns Tool Exposure observation.
export { buildExposurePlan, exposureKindOf, planEntryToExposureState, readSymlinkTarget } from "./exposures.js";

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


/** Base-store-relative location: the skill name, or `<name>.md` for a prompt. */
export function getStoreRelativePath(artifact: Pick<DiscoveredArtifact, "kind" | "name">): string {
  return artifact.kind === "skill" ? artifact.name : `${artifact.name}.md`;
}

export function overlayToRecord(overlay: OverlayFile): OverlayRecord {
  return { id: overlay.id, version: overlay.version, paths: [overlay.relativePath], effect: overlay.effect };
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

export async function collectArtifactStates(
  sourceArtifacts: DiscoveredArtifact[],
  home: string | undefined,
  sourceIdentity: string
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
    // to "conflict"; only the basePath conflict above does that. Legacy drift never
    // affects the aggregate anywhere (scan, install, or list): install never
    // repairs legacy exposures, so counting them would pin the artifact at
    // "installed-different" forever.
    const contentMatches = status === "installed-same";
    const baseIsNew = !baseExists;
    const observation =
      status === "conflict"
        ? { plan: [], exposures: [], desiredDrift: false }
        : await observeExposures({
            artifact,
            basePath,
            records: managedEntry?.exposures ?? [],
            config,
            home: resolvedHome,
            contentMatches,
            baseIsNew
          });
    const exposurePlan = observation.plan;
    if (status === "installed-same" && observation.desiredDrift) {
      status = "installed-different";
    }

    const exposures = observation.exposures;

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

  const removed = state.entries
    .filter((entry) => entry.sourceRoot === sourceIdentity)
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
    const { exposures, results } = await applyExposurePlanEntries(current.basePath, existingExposures, current.exposurePlan);
    const previous = entries.get(current.id);
    let entry: ManagedEntry;
    if (previous !== undefined) {
      const refreshed = refreshUnchangedEntry(previous, current, exposures);
      if (refreshed !== null) {
        entries.set(refreshed.id, refreshed);
        await saveSortedEntries(paths, entries);
      }
      entry = entries.get(current.id)!;
    } else {
      entry = buildManagedEntry(current.artifact, paths, expected, current.installedContent!, overlay, exposures);
      entries.set(entry.id, entry);
      await saveSortedEntries(paths, entries);
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
    await saveSortedEntries(paths, entries);
    throw new InstallFailedError(
      current.id,
      "verification-failed",
      `Post-write verification failed for ${current.id}: the installed copy does not match the expected source content.`
    );
  }

  const { exposures, results } = await applyExposurePlanEntries(current.basePath, existingExposures, current.exposurePlan);
  const entry = buildManagedEntry(current.artifact, paths, expected, installedContent, overlay, exposures);
  await writeMarker(entry);
  entries.set(entry.id, entry);
  await saveSortedEntries(paths, entries);

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
// applyExposurePlanEntries in ./exposure-mutations.js).
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
    await saveSortedEntries(paths, entries);
  }
}

export interface RemoveArtifactsResult {
  removed: ManagedEntry[];
  skippedExposures: SkippedExposureRemoval[];
}

// Removes managed artifacts by id. Ownership revalidation of each recorded exposure
// happens inside removeManagedExposures (the single shared mutation step): a path a
// foreign file/dir/symlink has since replaced is left alone and its record retained
// rather than silently dropped, and reported in skippedExposures. Every other
// exposure, and the basePath and marker themselves (never revalidated -- ~/.agents is
// this tool's sole managed territory), are still removed. Each id is persisted right
// after it finishes, bounding a mid-run crash to at most one in-flight artifact.
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

    const { retained, outcomes } = await removeManagedExposures(entry);
    for (const outcome of outcomes) {
      if (outcome.outcome === "kept-foreign") {
        skippedExposures.push({ id, path: outcome.path, targetName: outcome.targetName });
      }
    }

    await removePath(entry.basePath);
    await removePath(getMarkerPath(entry.basePath, entry.kind));

    if (retained.length > 0) {
      entries.set(id, { ...entry, exposures: retained });
    } else {
      entries.delete(id);
    }

    removed.push(entry);
    await saveSortedEntries(paths, entries);
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
    storeRelativePath: getStoreRelativePath(state.artifact),
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
  const { withScannedSource } = await import("./source-workflow.js");
  return withScannedSource(
    request.sourcePath,
    { home: request.home, scanOptions: request.scanOptions, resolveOptions: request.resolveOptions },
    async ({ states, removed, resolvedCommit }) => {
      const paths = resolveTargetPaths(request.home);
      const config = await loadConfig(paths, request.home);

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
      const partitioned = partitionSelectedById(states, (state) => state.id, request.only);
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
    if (conflictsShouldBlock(conflicts.length + exposureConflicts.length, request.allowConflicts)) {
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
    if (resolvedCommit !== undefined) {
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
          storeRelativePath: getStoreRelativePath(entry),
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
    }
  );
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
