import { promises as fs } from "node:fs";
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

export interface InstallerState {
  version: 2;
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

function migrateV1ToV2(v1: z.infer<typeof stateSchemaV1>): InstallerState {
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

export async function loadState(paths: TargetPaths): Promise<InstallerState> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 2, entries: [] };
    }

    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  const version = typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined;

  if (version === 1) {
    const migrated = migrateV1ToV2(stateSchemaV1.parse(parsed));
    await saveState(paths, migrated);
    return migrated;
  }

  if (version === 2) {
    return stateSchemaV2.parse(parsed);
  }

  throw new Error(`Unsupported agent-installer state file version: ${JSON.stringify(version)}. Expected 1 or 2.`);
}

export async function saveState(paths: TargetPaths, state: InstallerState): Promise<void> {
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
