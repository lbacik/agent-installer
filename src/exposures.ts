import { promises as fs } from "node:fs";
import path from "node:path";
import { expandHome, type AgentInstallerConfig } from "./config.js";
import { resolveExposurePath, resolveRealish } from "./paths.js";
import type {
  ArtifactKind,
  ArtifactStatus,
  DiscoveredArtifact,
  ExposureKind,
  ExposurePlanEntry,
  ExposurePlanStatus,
  ExposureRecord,
  ExposureState,
  ManagedEntry,
  SyncAction,
  SyncLegacyNotice,
} from "./types.js";

export function exposureKindOf(kind: ArtifactKind): ExposureKind {
  return kind === "skill" ? "skills" : "prompts";
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readSymlinkTarget(targetPath: string): Promise<string | null> {
  try {
    return await fs.readlink(targetPath);
  } catch {
    return null;
  }
}

// Normalizes an exposure path for comparison only: `~`-expanded (against
// `home` when given), made absolute, with the parent directory resolved through
// realpath where it exists. The leaf itself is a symlink into the base store
// and must never be followed, so only the directory part is normalized. Stored
// and reported paths keep their original spelling; only equality checks go
// through here, so equivalent spellings of the same target directory (absolute
// vs `~`, or a symlinked alias) compare as one location.
export async function normalizeExposurePathForCompare(exposurePath: string, home?: string): Promise<string> {
  const expanded = home === undefined ? exposurePath : expandHome(exposurePath, home);
  const absolute = path.resolve(expanded);
  const dir = path.dirname(absolute);
  const leaf = path.basename(absolute);
  return path.join(await resolveRealish(dir), leaf);
}

export async function sameExposurePath(left: string, right: string, home?: string): Promise<boolean> {
  if (left === right) {
    return true;
  }

  return (await normalizeExposurePathForCompare(left, home)) === (await normalizeExposurePathForCompare(right, home));
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

// Maps one desired exposure plan entry to its reportable ExposureState. A "match"
// entry mirrors the content check (a correct link still serves stale content after
// a source change); anything desired-but-not-"match" reports as its own drift
// ("new") or blockage ("conflict").
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

export interface ExposureObservationOptions {
  artifact: Pick<DiscoveredArtifact, "kind" | "name">;
  basePath: string;
  records: ExposureRecord[];
  config: AgentInstallerConfig | null;
  home: string;
  contentMatches: boolean;
  baseIsNew: boolean;
}

export interface ExposureObservation {
  plan: ExposurePlanEntry[];
  exposures: ExposureState[];
  /** True when any desired exposure drifts (`new` or `conflict`). Legacy drift never sets this. */
  desiredDrift: boolean;
}

async function legacyExposureStates(
  records: ExposureRecord[],
  plannedNormalizedPaths: Set<string>,
  basePath: string,
  contentMatches: boolean,
  baseIsNew: boolean,
  home: string
): Promise<ExposureState[]> {
  const states: ExposureState[] = [];
  for (const record of records) {
    if (record.targetName !== null) {
      continue;
    }

    // A legacy record colliding (after normalization) with a desired path is
    // already covered by that desired entry; report it once, as desired.
    if (plannedNormalizedPaths.has(await normalizeExposurePathForCompare(record.path, home))) {
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

// The single Tool Exposure reconciliation point. Observes every desired exposure
// (one per configured target that declares the artifact's kind) plus every
// legacy (`targetName: null`) record, and returns the reportable `exposures[]`
// plus the desired plan the aggregate status derives from. Recorded exposures
// for named targets are sync's domain and are intentionally left out: scan and
// list report what is desired plus what is legacy, not orphans awaiting `sync`
// cleanup. Legacy exposures are observe-only: they are reported, never planned.
export async function observeExposures(options: ExposureObservationOptions): Promise<ExposureObservation> {
  const plan = await buildExposurePlan(options.config, options.home, options.artifact, options.basePath);
  const plannedNormalizedPaths = new Set(
    await Promise.all(plan.map((entry) => normalizeExposurePathForCompare(entry.path, options.home)))
  );
  const states = plan.map((entry) => exposureStateForPlanEntry(entry, options.contentMatches, options.baseIsNew));
  states.push(
    ...(await legacyExposureStates(
      options.records,
      plannedNormalizedPaths,
      options.basePath,
      options.contentMatches,
      options.baseIsNew,
      options.home
    ))
  );

  return { plan, exposures: states, desiredDrift: plan.some((entry) => entry.status !== "match") };
}

// The `list`-without-config projection: every recorded exposure (named and
// legacy) is reported, but legacy drift never affects the aggregate status.
export async function observeRecordedExposures(
  records: ExposureRecord[],
  basePath: string,
  contentMatches: boolean
): Promise<{ exposures: ExposureState[]; namedDrift: boolean }> {
  const checks = await Promise.all(
    records.map(async (record) => ({ record, owned: (await readSymlinkTarget(record.path)) === basePath }))
  );

  const exposures: ExposureState[] = checks.map(({ record, owned }) => ({
    targetName: record.targetName,
    path: record.path,
    status: owned
      ? ((contentMatches ? "installed-same" : "installed-different") as ArtifactStatus)
      : ("installed-different" as ArtifactStatus)
  }));

  const namedDrift = checks.some((check) => check.record.targetName !== null && !check.owned);
  return { exposures, namedDrift };
}

export interface EntrySyncPlan {
  entry: ManagedEntry;
  actions: SyncAction[];
  legacyNotices: SyncLegacyNotice[];
}

// Read-only: computes what sync would do for one managed artifact by comparing
// its recorded exposures against the exposure plan the current config.yaml
// desires. Recorded and desired paths compare after normalization (directory
// part only), so equivalent spellings of the same target directory plan
// `match`, never a phantom `move`. Legacy exposures stay observe-only: they
// surface as notices and never produce actions.
export async function planEntrySync(
  entry: ManagedEntry,
  config: AgentInstallerConfig | null,
  home: string,
  scopeTargetNames: Set<string> | null
): Promise<EntrySyncPlan> {
  const kind = exposureKindOf(entry.kind);
  const desiredPlan = await buildExposurePlan(config, home, { kind: entry.kind, name: entry.name }, entry.basePath);
  const scopedDesired = scopeTargetNames === null ? desiredPlan : desiredPlan.filter((plan) => scopeTargetNames.has(plan.targetName));
  const desiredByTarget = new Map(scopedDesired.map((plan) => [plan.targetName, plan]));

  const recordByTarget = new Map<string, ExposureRecord>();
  const legacyNotices: SyncLegacyNotice[] = [];

  for (const record of entry.exposures) {
    if (record.targetName === null) {
      legacyNotices.push({ id: entry.id, path: record.path });
      continue;
    }

    if (scopeTargetNames !== null && !scopeTargetNames.has(record.targetName)) {
      continue;
    }

    recordByTarget.set(record.targetName, record);
  }

  const targetNames = new Set([...desiredByTarget.keys(), ...recordByTarget.keys()]);
  const actions: SyncAction[] = [];

  for (const targetName of targetNames) {
    const desired = desiredByTarget.get(targetName);
    const record = recordByTarget.get(targetName);

    if (desired === undefined) {
      // record is guaranteed here: targetName came from the union of both maps.
      actions.push({ id: entry.id, targetName, kind, action: "remove-orphan", path: record!.path });
      continue;
    }

    const reason = desired.status === "conflict" ? desired.reason : undefined;

    if (record === undefined || (await sameExposurePath(record.path, desired.path, home))) {
      const action = planStatusToSyncAction(desired.status);
      actions.push({ id: entry.id, targetName, kind, action, path: desired.path, ...(reason === undefined ? {} : { reason }) });
      continue;
    }

    const action = desired.status === "conflict" ? ("conflict" as const) : ("move" as const);
    actions.push({
      id: entry.id,
      targetName,
      kind,
      action,
      path: desired.path,
      previousPath: record.path,
      ...(reason === undefined ? {} : { reason })
    });
  }

  return { entry, actions, legacyNotices };
}

function planStatusToSyncAction(status: ExposurePlanStatus): SyncAction["action"] {
  if (status === "conflict") {
    return "conflict";
  }

  return status === "match" ? "match" : "create";
}
