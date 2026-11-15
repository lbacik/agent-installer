import { loadConfig } from "./config.js";
import { collectArtifactStates } from "./install.js";
import { resolveTargetPaths } from "./paths.js";
import { scanSourceRepository, type ScanSourceOptions } from "./source.js";
import { resolveSourceInput, type ResolveSourceOptions } from "./source-resolver.js";
import type { ArtifactState, RemovedArtifactState } from "./types.js";

export interface ScannedSource {
  states: ArtifactState[];
  removed: RemovedArtifactState[];
  sourceIdentity: string;
  requestedRef?: string | undefined;
  resolvedCommit?: string | undefined;
}

export interface WithScannedSourceOptions {
  home?: string | undefined;
  scanOptions?: ScanSourceOptions | undefined;
  resolveOptions?: ResolveSourceOptions | undefined;
}

export interface ResolvedArtifactStates {
  states: ArtifactState[];
  removed: RemovedArtifactState[];
  sourceIdentity: string;
}

/**
 * The single implementation of resolve -> scan -> stamp -> reconcile ->
 * cleanup. Owns the config preflight (so a malformed config.yaml aborts
 * before a remote source is cloned), source resolution, scanning, stamping
 * each artifact with Source Identity / Requested Ref / Resolved Commit,
 * reconciliation, and checkout cleanup on success and on failure.
 */
export async function withScannedSource<T>(
  inputPath: string | undefined,
  options: WithScannedSourceOptions | undefined,
  callback: (result: ScannedSource) => Promise<T>
): Promise<T> {
  const opts = options ?? {};
  // Validated before touching the source, so a malformed config.yaml aborts before a
  // remote source is cloned rather than after paying for the clone.
  await loadConfig(resolveTargetPaths(opts.home), opts.home);
  const source = await resolveSourceInput(inputPath, opts.resolveOptions);

  try {
    const artifacts = (await scanSourceRepository(source.scanRoot, opts.scanOptions)).map((artifact) => ({
      ...artifact,
      sourceRoot: source.sourceIdentity,
      requestedRef: source.requestedRef,
      resolvedCommit: source.resolvedCommit
    }));
    const result = await collectArtifactStates(artifacts, opts.home, source.sourceIdentity);
    return await callback({
      ...result,
      sourceIdentity: source.sourceIdentity,
      requestedRef: source.requestedRef,
      resolvedCommit: source.resolvedCommit
    });
  } finally {
    await source.cleanup();
  }
}

/**
 * Legacy positional-signature alias over {@link withScannedSource}. Kept so
 * existing callers and tests keep compiling; all logic lives in
 * `withScannedSource`.
 */
export async function withResolvedArtifactStates<T>(
  inputPath: string | undefined,
  home: string | undefined,
  scanOptions: ScanSourceOptions | undefined,
  resolveOptions: ResolveSourceOptions | undefined,
  callback: (result: ResolvedArtifactStates) => Promise<T>
): Promise<T> {
  return withScannedSource(inputPath, { home, scanOptions, resolveOptions }, callback);
}
