/**
 * Shared `--only` selector matching and conflict-gate helpers. Install
 * (`--only` over discovered artifacts) and sync (`--only` over managed
 * entries) share this single implementation; each keeps its own error class
 * and user-facing wording via the `makeError` callback.
 */

/** Split `only` selectors into matched items and unmatched selector strings. */
export function partitionSelectedById<T>(
  items: T[],
  getId: (item: T) => string,
  only: string[]
): { matched: T[]; unmatched: string[] } {
  const byId = new Map(items.map((item) => [getId(item), item]));
  // Unmatched selectors are reported exactly as given (order and duplicates
  // preserved); only the matched side is deduped so each artifact syncs or
  // installs once.
  const unmatched = only.filter((id) => !byId.has(id));
  const matched = [...new Set(only)].filter((id) => byId.has(id)).map((id) => byId.get(id) as T);
  return { matched, unmatched };
}

/** Select the items named by `only`, throwing `makeError(unmatched)` when any selector matches nothing. */
export function selectByIdOrThrow<T>(
  items: T[],
  getId: (item: T) => string,
  only: string[],
  makeError: (unmatched: string[]) => Error
): T[] {
  const { matched, unmatched } = partitionSelectedById(items, getId, only);
  if (unmatched.length > 0) {
    throw makeError(unmatched);
  }

  return matched;
}

/**
 * The shared conflict gate: a run aborts when any touched (artifact, target)
 * pair conflicts with an unmanaged path, unless `--allow-conflicts` was
 * passed. Returns true when the caller must abort. Both install and sync use
 * this single predicate; each throws its own error type.
 */
export function conflictsShouldBlock(conflictCount: number, allowConflicts?: boolean): boolean {
  return conflictCount > 0 && allowConflicts !== true;
}

/** Throw `makeError(conflicts)` unless conflicts are absent or explicitly allowed. */
export function throwIfConflictsBlocked<T>(conflicts: T[], allowConflicts: boolean | undefined, makeError: (conflicts: T[]) => Error): void {
  if (conflictsShouldBlock(conflicts.length, allowConflicts)) {
    throw makeError(conflicts);
  }
}
