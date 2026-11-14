import { promises as fs } from "node:fs";
import { hashArtifactContent, SKILL_TREE_ALGORITHM_V1 } from "./hash.js";
import { getStoreRelativePath } from "./install.js";
import { getMarkerPath, resolveTargetPaths } from "./paths.js";
import { loadStateReadOnly } from "./state.js";
import type {
  ContentFileRecord,
  ManagedEntry,
  OverlayRecord,
  VerifyArtifactRecord,
  VerifyOutcome,
  VerifyRefusal,
  VerifyRefusalCode
} from "./types.js";

/** Fixed notice carried by every verify report and printed by the human renderer. */
export const VERIFY_NOTICE =
  "This verifies previously recorded provenance only and does not prove the current state of any source.";

const REFUSAL_MESSAGES: Record<VerifyRefusalCode, string> = {
  "not-managed": "No managed entry exists for this artifact id.",
  missing: "The recorded Base Store copy is absent or the wrong file type for its kind.",
  "not-owned": "The installer ownership marker is absent, unparsable, or records a different artifact id.",
  "invalid-content": "The Base Store copy could not be hashed (internal symlink, special file, or unreadable content).",
  "unsupported-algorithm":
    "The recorded content-identity algorithm is agent-installer-tree-v1, a collidable digest that is never accepted as integrity evidence; reinstall at the recorded commit to re-record with the current algorithm.",
  "provenance-missing": "The entry was installed from a Git source but records no resolved commit.",
  "inconsistent-record":
    "The recorded entry is internally inconsistent: the recorded hashes differ or the recorded overlays are unknown.",
  modified:
    "The Base Store copy differs from the recorded installed content (edited, added, or deleted files, or changed executable bits)."
};

function refusal(code: VerifyRefusalCode, message?: string): VerifyRefusal {
  return { code, message: message ?? REFUSAL_MESSAGES[code] };
}

/** A remote Git source identity always carries the sanitized-URL `git+` prefix; local sources are real paths. */
function isGitSource(sourceRoot: string): boolean {
  return sourceRoot.startsWith("git+");
}

function nullProvenance(value: string | undefined): string | null {
  return value ?? null;
}

function baseRecord(entry: ManagedEntry): Omit<VerifyArtifactRecord, "result" | "refusals" | "content" | "files"> {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    sourceIdentity: entry.sourceRoot,
    relativeSourcePath: entry.relativeSourcePath,
    basePath: entry.basePath,
    storeRelativePath: getStoreRelativePath(entry),
    requestedRef: nullProvenance(entry.requestedRef),
    resolvedCommit: nullProvenance(entry.resolvedCommit),
    installedAt: entry.installedAt,
    overlays: entry.overlays === null ? [] : [...entry.overlays],
    verification: "recorded-installation"
  };
}

/**
 * Ownership is keyed by the marker's recorded `id` alone: the marker is
 * absent, unparsable, or records a different id exactly when this tool does
 * not own the path. `installedAt` is never compared.
 */
async function readMarkerOwnerId(entry: ManagedEntry): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(getMarkerPath(entry.basePath, entry.kind), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const id = typeof parsed === "object" && parsed !== null ? (parsed as { id?: unknown }).id : undefined;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Verifies one managed entry offline against its recorded content identity.
 * Never contacts a source, runs Git, or writes anything: it stats the
 * recorded base path, validates the ownership marker, and rehashes the
 * current Base Store copy with the same walker install uses.
 */
async function verifyEntry(entry: ManagedEntry): Promise<VerifyArtifactRecord> {
  const record = baseRecord(entry);

  // Missing short-circuits: without the recorded base path (or with the wrong
  // file type for the kind) there is nothing to hash and no marker to check.
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stats = await fs.lstat(entry.basePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...record, result: "refused", refusals: [refusal("missing")] };
    }

    // Exists but cannot be stated: hashing below classifies it.
    return verifyOwned(entry, record);
  }

  // A symlink at the recorded base path is never the managed copy itself, and
  // any other wrong file type for the kind (file for a skill, directory for
  // a prompt) reads as missing, exactly like an absent path.
  if (stats.isSymbolicLink() || (entry.kind === "skill" ? !stats.isDirectory() : !stats.isFile())) {
    return { ...record, result: "refused", refusals: [refusal("missing")] };
  }

  return verifyOwned(entry, record);
}

async function verifyOwned(
  entry: ManagedEntry,
  record: Omit<VerifyArtifactRecord, "result" | "refusals" | "content" | "files">
): Promise<VerifyArtifactRecord> {
  const refusals: VerifyRefusal[] = [];

  if ((await readMarkerOwnerId(entry)) !== entry.id) {
    refusals.push(refusal("not-owned"));
  }

  let installedHash: string | null = null;
  let files: ContentFileRecord[] | null = null;
  try {
    const fresh = await hashArtifactContent(entry.kind, entry.basePath);
    installedHash = fresh.digest;
    files = fresh.files;
  } catch (error) {
    refusals.push(
      refusal("invalid-content", `${REFUSAL_MESSAGES["invalid-content"]} (${error instanceof Error ? error.message : String(error)})`)
    );
  }

  if (entry.hashAlgorithm === SKILL_TREE_ALGORITHM_V1) {
    refusals.push(refusal("unsupported-algorithm"));
  }

  if (isGitSource(entry.sourceRoot) && entry.resolvedCommit == null) {
    refusals.push(refusal("provenance-missing"));
  }

  if (entry.sourceHash !== entry.installedHash || entry.overlays === null) {
    refusals.push(refusal("inconsistent-record"));
  }

  if (installedHash !== null && installedHash !== entry.installedHash) {
    refusals.push(refusal("modified"));
  }

  if (refusals.length === 0) {
    return {
      ...record,
      result: "verified",
      refusals: [],
      content: { algorithm: entry.hashAlgorithm, expectedHash: entry.sourceHash, installedHash: installedHash! },
      files: files!
    };
  }

  const refused: VerifyArtifactRecord = { ...record, result: "refused", refusals };
  if (installedHash !== null && files !== null) {
    refused.content = { algorithm: entry.hashAlgorithm, expectedHash: entry.sourceHash, installedHash };
    refused.files = files;
  }

  return refused;
}

export interface VerifyRequest {
  /** Distinct artifact ids are verified; this function dedupes defensively but the CLI preserves first-appearance order. */
  only: string[];
  home?: string | undefined;
}

/**
 * Runs offline verification for exactly the requested artifact ids: rehashes
 * each selected Base Store copy against its recorded content identity and
 * reports each artifact's recorded provenance. Unrelated managed entries are
 * never read. Never contacts a source, runs Git, loads `config.yaml`, checks
 * Tool Exposures, or writes anything; state migrates in memory only.
 */
export async function runVerify(request: VerifyRequest): Promise<VerifyOutcome> {
  const paths = resolveTargetPaths(request.home);
  const baseStore = { skills: paths.agentsSkillsDir, prompts: paths.agentsPromptsDir };

  let state: Awaited<ReturnType<typeof loadStateReadOnly>>;
  try {
    state = await loadStateReadOnly(paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: 3,
      kind: "agent-installer.verify-report",
      baseStore,
      outcome: "error",
      artifacts: [],
      notice: VERIFY_NOTICE,
      error: { code: "state-unreadable", message }
    };
  }

  const entriesById = new Map<string, ManagedEntry>(state.entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const artifacts: VerifyArtifactRecord[] = [];

  for (const id of request.only) {
    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    const entry = entriesById.get(id);
    if (entry === undefined) {
      const parsed = /^(skill|prompt):(.+)$/.exec(id);
      const kind = parsed?.[1] === "prompt" ? "prompt" : "skill";
      const name = parsed?.[2] ?? id;
      artifacts.push({
        id,
        kind,
        name,
        sourceIdentity: "",
        relativeSourcePath: "",
        basePath: "",
        storeRelativePath: getStoreRelativePath({ kind, name }),
        requestedRef: null,
        resolvedCommit: null,
        installedAt: "",
        overlays: [] as OverlayRecord[],
        verification: "recorded-installation",
        result: "refused",
        refusals: [refusal("not-managed", `No managed entry exists for ${JSON.stringify(id)}.`)]
      });
      continue;
    }

    artifacts.push(await verifyEntry(entry));
  }

  return {
    schemaVersion: 3,
    kind: "agent-installer.verify-report",
    baseStore,
    outcome: artifacts.every((artifact) => artifact.result === "verified") ? "verified" : "refused",
    artifacts,
    notice: VERIFY_NOTICE
  };
}
