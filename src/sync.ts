import { AgentInstallerConfig, loadConfig } from "./config.js";
import { applySyncEntryActions } from "./exposure-mutations.js";
import { planEntrySync, type EntrySyncPlan } from "./exposures.js";
import { formatExposureConflictLine } from "./format.js";
import { resolveHome, resolveTargetPaths } from "./paths.js";
import { selectByIdOrThrow, throwIfConflictsBlocked } from "./selection.js";
import { loadState, saveSortedEntries } from "./state.js";
import { ExposureActionOutcome, ManagedEntry, SkippedExposureRemoval, SyncAction, SyncActionKind, SyncLegacyNotice } from "./types.js";

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
  /** Per-action outcomes for every attempted mutation; empty on dry runs. `buildSyncJson` derives `applied` from these. */
  outcomes: ExposureActionOutcome[];
  dryRun: boolean;
}

// Thrown by syncExposures when a touched (artifact, target) pair conflicts with an
// unmanaged path and --allow-conflicts was not passed. Shares its per-pair line
// format with InstallConflictError via formatExposureConflictLine.
export class SyncConflictError extends Error {
  constructor(public readonly conflicts: SyncAction[]) {
    super(
      [
        `Refusing to sync: ${conflicts.length} (artifact, target) pair(s) conflict with unmanaged targets.`,
        ...conflicts.map((conflict) => `  ${formatExposureConflictLine({ ...conflict, reason: conflict.reason ?? "conflict" })}`),
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
  return selectByIdOrThrow(entries, (entry) => entry.id, only, (unmatched) => new UnmatchedSyncSelectorsError(unmatched));
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

function skippedForOutcome(outcome: ExposureActionOutcome): SkippedExposureRemoval {
  return {
    id: outcome.id,
    path: outcome.fromPath ?? outcome.path,
    targetName: outcome.targetName
  };
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
    return { actions, legacyNotices, skippedOrphanRemovals: [], outcomes: [], dryRun: true };
  }

  throwIfConflictsBlocked(conflicts, options.allowConflicts, (blocked) => new SyncConflictError(blocked));

  const entriesById = new Map(state.entries.map((entry) => [entry.id, entry]));
  const outcomes: ExposureActionOutcome[] = [];
  const skippedOrphanRemovals: SkippedExposureRemoval[] = [];

  // Each changed entry is persisted before moving to the next, matching install's
  // per-artifact saves: a mid-run failure leaves at most one entry's state out of
  // sync with what is actually on disk, and every exposure already created or moved
  // stays recorded.
  for (const plan of entryPlans) {
    // Test seam for the failure-partway path: fail before touching this entry, so
    // the test can assert every earlier entry's exposures are already persisted.
    if (process.env.AGENT_INSTALLER_TEST_FAIL_SYNC === plan.entry.id) {
      throw new Error(`Injected sync failure for ${plan.entry.id} (AGENT_INSTALLER_TEST_FAIL_SYNC).`);
    }

    const current = entriesById.get(plan.entry.id) ?? plan.entry;
    const applied = await applySyncEntryActions(current, plan.actions);
    outcomes.push(...applied.outcomes);

    for (const outcome of applied.outcomes) {
      if (outcome.outcome === "kept-foreign") {
        skippedOrphanRemovals.push(skippedForOutcome(outcome));
      }
    }

    const changed = applied.outcomes.some(
      (outcome) => outcome.outcome === "created" || outcome.outcome === "moved" || outcome.outcome === "removed"
    );
    if (changed) {
      entriesById.set(current.id, { ...current, exposures: applied.exposures });
      await saveSortedEntries(paths, entriesById);
    }
  }

  return { actions, legacyNotices, skippedOrphanRemovals, outcomes, dryRun: false };
}
