import { promises as fs } from "node:fs";
import { z } from "zod";
import { ManagedEntry } from "./types.js";
import { TargetPaths } from "./paths.js";

const managedEntrySchema = z.object({
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

const stateSchema = z.object({
  version: z.literal(1),
  entries: z.array(managedEntrySchema)
});

export interface InstallerState {
  version: 1;
  entries: ManagedEntry[];
}

export async function loadState(paths: TargetPaths): Promise<InstallerState> {
  try {
    const raw = await fs.readFile(paths.stateFile, "utf8");
    return stateSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, entries: [] };
    }

    throw error;
  }
}

export async function saveState(paths: TargetPaths, state: InstallerState): Promise<void> {
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
