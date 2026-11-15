import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readSymlinkTarget } from "./exposures.js";
import type {
  ExposureActionOutcome,
  ExposureInstallRecord,
  ExposurePlanEntry,
  ExposureRecord,
  ManagedEntry,
  SyncAction,
} from "./types.js";

/** Reason recorded when a path is left alone because it no longer verifies as an owned symlink. */
export const KEPT_FOREIGN_REASON = "Exposure path is no longer an owned symlink, so it was left alone.";

export async function ensureParentDir(targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

export async function removePath(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
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
// alone. This is the only place ownership-checked deletion happens: install's
// removeArtifacts, sync's per-entry apply step and prune all reach it through the
// shared mutation functions in this module.
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

function removeRecordAtPath(records: ExposureRecord[], targetPath: string): ExposureRecord[] {
  return records.filter((record) => record.path !== targetPath);
}

function failureReason(targetName: string, targetPath: string, detail: string): string {
  return `Could not create exposure for target "${targetName}" at ${targetPath}: ${detail}`;
}

// Applies one artifact's exposure plan, best-effort per target: a "new" entry is
// (re)created, a "match" entry is left alone, and a "conflict" entry is never touched.
// A failed creation is skipped rather than retried or rolled back, so a later target's
// success is never undone by an earlier target's failure. The returned exposures
// reflect exactly what verified as correct on disk after every attempt, merged with
// whatever the entry already owns outside the current plan (e.g. a legacy exposure, or
// one for a target no longer declared in config.yaml).
export async function applyExposurePlanEntries(
  basePath: string,
  existingExposures: ExposureRecord[],
  plan: ExposurePlanEntry[]
): Promise<{ exposures: ExposureRecord[]; results: ExposureInstallRecord[]; outcomes: ExposureActionOutcome[] }> {
  const byPath = new Map(existingExposures.map((exposure) => [exposure.path, exposure]));
  const results: ExposureInstallRecord[] = [];
  const outcomes: ExposureActionOutcome[] = [];

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
      outcomes.push({ id: "", targetName: entry.targetName, kind: entry.kind, path: entry.path, outcome: "created" });
    } else {
      const reason = failureReason(entry.targetName, entry.path, created.reason);
      results.push({ targetName: entry.targetName, path: entry.path, result: "failed", reason });
      outcomes.push({ id: "", targetName: entry.targetName, kind: entry.kind, path: entry.path, outcome: "failed", reason });
    }
  }

  return { exposures: [...byPath.values()], results, outcomes };
}

// Applies one managed artifact's sync actions, best-effort per action: "conflict" and
// "match" are no-ops, "remove-orphan" and the stale side of "move" revalidate ownership
// immediately before deleting. A foreign replacement at the stale path is left alone,
// its record retained and reported; for "move" this also skips creating the new
// exposure this round, so a pair never ends up with two exposure records for the same
// target. The create side of "create"/"move" uses the same owned-symlink creation as
// the install plan step above, so both create exposures the same way.
export async function applySyncEntryActions(
  entry: ManagedEntry,
  actions: SyncAction[]
): Promise<{ exposures: ExposureRecord[]; outcomes: ExposureActionOutcome[] }> {
  let exposures = [...entry.exposures];
  const outcomes: ExposureActionOutcome[] = [];

  for (const action of actions) {
    if (action.action === "conflict" || action.action === "match") {
      continue;
    }

    if (action.action === "remove-orphan") {
      if ((await revalidateAndRemove(action.path, entry.basePath)) === "foreign") {
        outcomes.push({
          id: entry.id,
          targetName: action.targetName,
          kind: action.kind,
          path: action.path,
          outcome: "kept-foreign",
          reason: KEPT_FOREIGN_REASON
        });
      } else {
        exposures = removeRecordAtPath(exposures, action.path);
        outcomes.push({ id: entry.id, targetName: action.targetName, kind: action.kind, path: action.path, outcome: "removed" });
      }

      continue;
    }

    if (action.action === "move" && action.previousPath !== undefined) {
      if ((await revalidateAndRemove(action.previousPath, entry.basePath)) === "foreign") {
        outcomes.push({
          id: entry.id,
          targetName: action.targetName,
          kind: action.kind,
          path: action.path,
          fromPath: action.previousPath,
          outcome: "kept-foreign",
          reason: KEPT_FOREIGN_REASON
        });
        continue;
      }

      exposures = removeRecordAtPath(exposures, action.previousPath);
    }

    const created = await tryCreateOwnedSymlink(entry.basePath, action.path);
    if (created.ok) {
      exposures = [...removeRecordAtPath(exposures, action.path), { path: action.path, targetName: action.targetName }];
      outcomes.push({
        id: entry.id,
        targetName: action.targetName,
        kind: action.kind,
        path: action.path,
        ...(action.action === "move" && action.previousPath !== undefined ? { fromPath: action.previousPath } : {}),
        outcome: action.action === "move" ? "moved" : "created"
      });
    } else {
      const reason = failureReason(action.targetName, action.path, created.reason);
      outcomes.push({
        id: entry.id,
        targetName: action.targetName,
        kind: action.kind,
        path: action.path,
        ...(action.action === "move" && action.previousPath !== undefined ? { fromPath: action.previousPath } : {}),
        outcome: "failed",
        reason
      });
    }
  }

  return { exposures, outcomes };
}

// Ownership-checked removal of every recorded exposure of one managed entry, for
// uninstall and prune. A path a foreign file/dir/symlink has since replaced is left
// alone and reported as `kept-foreign` so the caller retains its record rather than
// silently dropping it; every other exposure reports `removed` (including paths
// already gone, whose records still need clearing).
export async function removeManagedExposures(
  entry: ManagedEntry
): Promise<{ retained: ExposureRecord[]; outcomes: ExposureActionOutcome[] }> {
  const retained: ExposureRecord[] = [];
  const outcomes: ExposureActionOutcome[] = [];

  for (const exposure of entry.exposures) {
    if ((await revalidateAndRemove(exposure.path, entry.basePath)) === "foreign") {
      retained.push(exposure);
      outcomes.push({
        id: entry.id,
        targetName: exposure.targetName,
        kind: entry.kind === "skill" ? "skills" : "prompts",
        path: exposure.path,
        outcome: "kept-foreign",
        reason: KEPT_FOREIGN_REASON
      });
    } else {
      outcomes.push({
        id: entry.id,
        targetName: exposure.targetName,
        kind: entry.kind === "skill" ? "skills" : "prompts",
        path: exposure.path,
        outcome: "removed"
      });
    }
  }

  return { retained, outcomes };
}
