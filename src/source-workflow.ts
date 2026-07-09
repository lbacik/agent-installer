import { collectArtifactStates } from "./install.js";
import { scanSourceRepository, type ScanSourceOptions } from "./source.js";
import { resolveSourceInput, type ResolveSourceOptions } from "./source-resolver.js";
import type { ArtifactState, RemovedArtifactState } from "./types.js";

export interface ResolvedArtifactStates {
  states: ArtifactState[];
  removed: RemovedArtifactState[];
  sourceIdentity: string;
}

export async function withResolvedArtifactStates<T>(
  inputPath: string | undefined,
  home: string | undefined,
  scanOptions: ScanSourceOptions | undefined,
  resolveOptions: ResolveSourceOptions | undefined,
  callback: (result: ResolvedArtifactStates) => Promise<T>
): Promise<T> {
  const source = await resolveSourceInput(inputPath, resolveOptions);

  try {
    const artifacts = (await scanSourceRepository(source.scanRoot, scanOptions)).map((artifact) => ({
      ...artifact,
      sourceRoot: source.sourceIdentity
    }));
    const result = await collectArtifactStates(artifacts, home, source.sourceIdentity);
    return await callback({ ...result, sourceIdentity: source.sourceIdentity });
  } finally {
    await source.cleanup();
  }
}
