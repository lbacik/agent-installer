import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ManagedEntry } from "./types.js";
import { TargetPaths } from "./paths.js";

const managedEntrySchemaV1 = z.object({
  id: z.string(),
  kind: z.enum(["skill", "prompt"]),
  name: z.string(),
  sourceRoot: z.string(),
  relativeSourcePath: z.string(),
  basePath: z.string(),
  exposurePath: z.string(),
  sourceHash: z.string(),
  installedHash: z.string(),
  installedAt: z.string()
});

const stateSchemaV1 = z.object({
  version: z.literal(1),
  entries: z.array(managedEntrySchemaV1)
});

const managedEntrySchemaV2 = managedEntrySchemaV1.extend({
  requestedRef: z.string().optional(),
  resolvedCommit: z.string().optional()
});

const stateSchemaV2 = z.object({
  version: z.literal(2),
  entries: z.array(managedEntrySchemaV2)
});

const exposureRecordSchema = z.object({
  path: z.string(),
  targetName: z.string().nullable()
});

const managedEntrySchemaV3 = z.object({
  id: z.string(),
  kind: z.enum(["skill", "prompt"]),
  name: z.string(),
  sourceRoot: z.string(),
  relativeSourcePath: z.string(),
  basePath: z.string(),
  exposures: z.array(exposureRecordSchema),
  sourceHash: z.string(),
  installedHash: z.string(),
  installedAt: z.string(),
  requestedRef: z.string().optional(),
  resolvedCommit: z.string().optional()
});

const stateSchemaV3 = z.object({
  version: z.literal(3),
  entries: z.array(managedEntrySchemaV3)
});

export interface InstallerState {
  version: 3;
  entries: ManagedEntry[];
}

const REF_FRAGMENT_PREFIX = "#ref=";

// Version 1 stored the requested ref folded into sourceRoot as a `#ref=` fragment.
// Splitting it out here keeps pre-existing entries owned by the same source
// identity after the migration.
function splitLegacySourceRoot(sourceRoot: string): { sourceRoot: string; requestedRef?: string } {
  const fragmentIndex = sourceRoot.indexOf(REF_FRAGMENT_PREFIX);
  if (fragmentIndex === -1) {
    return { sourceRoot };
  }

  return {
    sourceRoot: sourceRoot.slice(0, fragmentIndex),
    requestedRef: decodeURIComponent(sourceRoot.slice(fragmentIndex + REF_FRAGMENT_PREFIX.length))
  };
}

function migrateV1ToV2(v1: z.infer<typeof stateSchemaV1>): z.infer<typeof stateSchemaV2> {
  return {
    version: 2,
    entries: v1.entries.map((entry) => {
      const { sourceRoot, requestedRef } = splitLegacySourceRoot(entry.sourceRoot);
      return {
        ...entry,
        sourceRoot,
        ...(requestedRef === undefined ? {} : { requestedRef })
      };
    })
  };
}

// v1/v2 always required a single, non-null exposurePath, so migration always
// produces exactly one legacy (unnamed) exposure record per entry.
function migrateV2ToV3(v2: z.infer<typeof stateSchemaV2>): InstallerState {
  return {
    version: 3,
    entries: v2.entries.map(({ exposurePath, ...entry }) => ({
      ...entry,
      exposures: [{ path: exposurePath, targetName: null }]
    }))
  };
}

export async function loadState(paths: TargetPaths): Promise<InstallerState> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 3, entries: [] };
    }

    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  const version = typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined;

  if (version === 1) {
    const migrated = migrateV2ToV3(migrateV1ToV2(stateSchemaV1.parse(parsed)));
    await saveState(paths, migrated);
    return migrated;
  }

  if (version === 2) {
    const migrated = migrateV2ToV3(stateSchemaV2.parse(parsed));
    await saveState(paths, migrated);
    return migrated;
  }

  if (version === 3) {
    return stateSchemaV3.parse(parsed);
  }

  throw new Error(`Unsupported agent-installer state file version: ${JSON.stringify(version)}. Expected 1, 2, or 3.`);
}

// Writes to a sibling temp path and renames it into place, so a crash mid-write can
// never leave state.json partially written; a retry always sees either the pre- or
// fully-written file.
export async function saveState(paths: TargetPaths, state: InstallerState): Promise<void> {
  await fs.mkdir(paths.stateDir, { recursive: true });
  const tempFile = path.join(paths.stateDir, `.state.json.${process.pid}.tmp`);
  await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, paths.stateFile);
}
