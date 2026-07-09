import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ResolvedSource {
  scanRoot: string;
  sourceIdentity: string;
  cleanup: () => Promise<void>;
}

export type GitRunner = (args: string[], cwd?: string) => Promise<void>;

export interface ResolveSourceOptions {
  ref?: string;
  git?: GitRunner;
}

async function defaultGitRunner(args: string[], cwd?: string): Promise<void> {
  try {
    await execFileAsync("git", args, cwd === undefined ? {} : { cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

export function isHttpsGitSource(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && url.hostname.length > 0 && url.pathname.length > 1;
  } catch {
    return false;
  }
}

export function sanitizeRemoteSourceIdentity(input: string, ref?: string): string {
  const url = new URL(input);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";

  const base = `git+${url.toString()}`;
  return ref === undefined ? base : `${base}#ref=${encodeURIComponent(ref)}`;
}

async function removeTempDir(tempDir: string): Promise<void> {
  await fs.rm(tempDir, { recursive: true, force: true });
}

export async function resolveSourceInput(inputPath?: string, options: ResolveSourceOptions = {}): Promise<ResolvedSource> {
  const input = inputPath ?? process.cwd();

  if (!isHttpsGitSource(input)) {
    if (options.ref !== undefined) {
      throw new Error("--ref can only be used with an HTTPS Git source.");
    }

    const scanRoot = await fs.realpath(path.resolve(input));
    return {
      scanRoot,
      sourceIdentity: scanRoot,
      cleanup: async () => {}
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-installer-git-"));
  const scanRoot = path.join(tempDir, "repo");
  const git = options.git ?? defaultGitRunner;

  try {
    await git(["clone", "--depth", "1", input, scanRoot]);
    if (options.ref !== undefined) {
      await git(["fetch", "--depth", "1", "origin", options.ref], scanRoot);
      await git(["checkout", "--detach", "FETCH_HEAD"], scanRoot);
    }

    return {
      scanRoot,
      sourceIdentity: sanitizeRemoteSourceIdentity(input, options.ref),
      cleanup: async () => {
        await removeTempDir(tempDir);
      }
    };
  } catch (error) {
    await removeTempDir(tempDir);
    throw error;
  }
}
