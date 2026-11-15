import { AgentInstallerConfig, loadConfig } from "./config.js";
import { planEntrySync, type EntrySyncPlan } from "./exposures.js";
import { createOwnedSymlink, revalidateAndRemove } from "./install.js";
import { resolveHome, resolveTargetPaths } from "./paths.js";
import { loadState, saveState } from "./state.js";
import { ExposureRecord, ManagedEntry, SkippedExposureRemoval, SyncAction, SyncActionKind, SyncLegacyNotice } from "./types.js";

export type { SkippedExposureRemoval, SyncAction, SyncActionKind, SyncLegacyNotice } from "./types.js";

export interface SyncOptions {
  only?: string[] | undefined;
  targets?: string[] | undefined;
  allowConflicts?: boolean | undefined;
  dryRun?: boolean | undefined;
}

export interface SyncResult {
  actions: SyncAction[];
  legacyNotices: SyncLegacyNotice[];
  skippedOrphanRemovals: SkippedExposureRemoval[];
  dryRun: boolean;
}

// Thrown by syncExposures when a touched (artifact, target) pair conflicts with an
// unmanaged path and --allow-conflicts was not passed. Mirrors InstallConflictError.
export class SyncConflictError extends Error {
  constructor(public readonly conflicts: SyncAction[]) {
    super(
      [
        `Refusing to sync: ${conflicts.length} (artifact, target) pair(s) conflict with unmanaged targets.`,
        ...conflicts.map((conflict) => `  ${conflict.id} -> ${conflict.targetName}:${conflict.path} (${conflict.reason ?? "conflict"})`),
        "Use --allow-conflicts to sync the remaining eligible pairs and skip these."
      ].join("\n")
    );
    this.name = "SyncConflictError";
  }
}

export class UnmatchedSyncSelectorsError extends Error {
  constructor(public readonly selectors: string[]) {
    super(`No managed artifact matches: ${selectors.join(", ")}`);
    this.name = "UnmatchedSyncSelectorsError";
  }
}

export class UnmatchedSyncTargetsError extends Error {
  constructor(public readonly targets: string[]) {
    super(`Unknown sync target(s): ${targets.join(", ")}`);
    this.name = "UnmatchedSyncTargetsError";
  }
}

function selectManagedEntries(entries: ManagedEntry[], only: string[]): ManagedEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const unmatched = only.filter((id) => !byId.has(id));
  if (unmatched.length > 0) {
    throw new UnmatchedSyncSelectorsError([...new Set(unmatched)]);
  }

  return [...new Set(only)].map((id) => byId.get(id) as ManagedEntry);
}

// A --target name is valid when it names a currently configured target, or once did
// (it still appears on a recorded exposure) -- the latter is exactly the shape of the
// orphan a caller would want to clean up by name.
function knownTargetNames(config: AgentInstallerConfig | null, entries: ManagedEntry[]): Set<string> {
  const names = new Set<string>(config === null ? [] : Object.keys(config.targets));
  for (const entry of entries) {
    for (const exposure of entry.exposures) {
      if (exposure.targetName !== null) {
        names.add(exposure.targetName);
      }
    }
  }

  return names;
}

function resolveScopeTargetNames(
  requested: string[] | undefined,
  config: AgentInstallerConfig | null,
  entries: ManagedEntry[]
): Set<string> | null {
  if (requested === undefined || requested.length === 0) {
    return null;
  }

  const known = knownTargetNames(config, entries);
  const unmatched = requested.filter((name) => !known.has(name));
  if (unmatched.length > 0) {
    throw new UnmatchedSyncTargetsError([...new Set(unmatched)]);
  }

  return new Set(requested);
}

// Read-only: computes what sync would do for one managed artifact. Delegates to
// the shared Tool Exposure reconciliation in `./exposures.js`; this module only
// applies the resulting plan.
function buildEntrySyncPlan(
  config: AgentInstallerConfig | null,
  home: string,
  entry: ManagedEntry,
  scopeTargetNames: Set<string> | null
): Promise<EntrySyncPlan> {
  return planEntrySync(entry, config, home, scopeTargetNames);
}

function removeRecordAtPath(records: ExposureRecord[], targetPath: string): ExposureRecord[] {
  return records.filter((record) => record.path !== targetPath);
}

// Applies one artifact's sync actions, best-effort per action: "conflict" and "match"
// are no-ops, "remove-orphan" and the stale side of "move" revalidate ownership
// immediately before deleting via the same revalidateAndRemove install's removeArtifacts
// uses. A foreign replacement at the stale path is left alone, its record retained and
// reported; for "move" this also skips creating the new exposure this round, so a
// pair never ends up with two exposure records for the same target. The create side of
// "create"/"move" uses the same createOwnedSymlink install's applyExposurePlan uses.
async function applyEntrySyncActions(
  entry: ManagedEntry,
  actions: SyncAction[]
): Promise<{ exposures: ExposureRecord[]; changed: boolean; skippedOrphanRemovals: SkippedExposureRemoval[] }> {
  let exposures = [...entry.exposures];
  let changed = false;
  const skippedOrphanRemovals: SkippedExposureRemoval[] = [];

  for (const action of actions) {
    if (action.action === "conflict" || action.action === "match") {
      continue;
    }

    if (action.action === "remove-orphan") {
      if ((await revalidateAndRemove(action.path, entry.basePath)) === "foreign") {
        skippedOrphanRemovals.push({ id: entry.id, path: action.path, targetName: action.targetName });
      } else {
        exposures = removeRecordAtPath(exposures, action.path);
        changed = true;
      }

      continue;
    }

    if (action.action === "move" && action.previousPath !== undefined) {
      if ((await revalidateAndRemove(action.previousPath, entry.basePath)) === "foreign") {
        skippedOrphanRemovals.push({ id: entry.id, path: action.previousPath, targetName: action.targetName });
        continue;
      }

      exposures = removeRecordAtPath(exposures, action.previousPath);
      changed = true;
    }

    if (await createOwnedSymlink(entry.basePath, action.path)) {
      exposures = [...removeRecordAtPath(exposures, action.path), { path: action.path, targetName: action.targetName }];
      changed = true;
    }
  }

  return { exposures, changed, skippedOrphanRemovals };
}

// Reconciles installed artifacts' exposures against the current config.yaml: never
// contacts a source repository and never touches base-store content or content hashes,
// only exposures[] in state. `--dry-run` always returns the full plan (including
// conflicts) without touching the filesystem or state; otherwise a touched conflict
// aborts the whole run unless allowConflicts is set, mirroring install --all.
export async function syncExposures(options: SyncOptions = {}, home?: string): Promise<SyncResult> {
  const paths = resolveTargetPaths(home);
  const resolvedHome = resolveHome(home);
  const config = await loadConfig(paths, home);
  const state = await loadState(paths);

  const selectedEntries = options.only === undefined ? state.entries : selectManagedEntries(state.entries, options.only);
  const scopeTargetNames = resolveScopeTargetNames(options.targets, config, state.entries);

  const entryPlans = await Promise.all(
    selectedEntries.map((entry) => buildEntrySyncPlan(config, resolvedHome, entry, scopeTargetNames))
  );

  const actions = entryPlans.flatMap((plan) => plan.actions);
  const legacyNotices = entryPlans.flatMap((plan) => plan.legacyNotices);
  const conflicts = actions.filter((action) => action.action === "conflict");

  if (options.dryRun === true) {
    return { actions, legacyNotices, skippedOrphanRemovals: [], dryRun: true };
  }

  if (conflicts.length > 0 && options.allowConflicts !== true) {
    throw new SyncConflictError(conflicts);
  }

  const entriesById = new Map(state.entries.map((entry) => [entry.id, entry]));
  const skippedOrphanRemovals: SkippedExposureRemoval[] = [];

  for (const plan of entryPlans) {
    const { exposures, changed, skippedOrphanRemovals: skipped } = await applyEntrySyncActions(plan.entry, plan.actions);
    if (changed) {
      entriesById.set(plan.entry.id, { ...plan.entry, exposures });
    }

    skippedOrphanRemovals.push(...skipped);
  }

  await saveState(paths, { version: 4, entries: [...entriesById.values()].sort((left, right) => left.id.localeCompare(right.id)) });

  return { actions, legacyNotices, skippedOrphanRemovals, dryRun: false };
}
