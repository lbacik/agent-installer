import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ResolvedSource {
  scanRoot: string;
  sourceIdentity: string;
  /** The `--ref` value the caller requested, when the source is a remote Git repository. */
  requestedRef?: string | undefined;
  /** The full 40-character commit SHA actually checked out, when the source is a remote Git repository. */
  resolvedCommit?: string;
  cleanup: () => Promise<void>;
}

export type GitRunner = (args: string[], cwd?: string) => Promise<string>;

export interface ResolveSourceOptions {
  ref?: string;
  git?: GitRunner;
}

async function defaultGitRunner(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, cwd === undefined ? {} : { cwd });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The child-process message echoes the raw argv (including any credentialed
    // source URL). Strip userinfo and query/fragment from any https URL it
    // contains so the default runner never leaks credentials on its own. The
    // resolveSourceInput wrapper below redacts exact secrets as well.
    throw new Error(redactGenericGitSecrets(message));
  }
}

function redactGenericGitSecrets(message: string): string {
  let out = message;
  // Strip `user[:pass]@` from any http(s) URL, keeping the rest of the URL.
  out = out.replace(/(https?:\/\/)[^\s/@]*@/g, "$1");
  // Strip query strings and fragments from any http(s) URL.
  out = out.replace(/(https?:\/\/[^\s?#"'`\]\)]+)\?[^\s"'`\]\)]*/g, "$1");
  out = out.replace(/(https?:\/\/[^\s#"'`\]\)]+)#[^\s"'`\]\)]*/g, "$1");
  return out;
}

function collectSecretValues(input: string): string[] {
  const secrets: string[] = [];
  const push = (value: string): void => {
    if (value.length === 0) {
      return;
    }
    secrets.push(value);
    try {
      const decoded = decodeURIComponent(value);
      if (decoded.length > 0 && decoded !== value) {
        secrets.push(decoded);
      }
    } catch {
      // Not percent-encoded; nothing to add.
    }
    try {
      const encoded = encodeURIComponent(value);
      if (encoded.length > 0 && encoded !== value) {
        secrets.push(encoded);
      }
    } catch {
      // Nothing to add.
    }
  };

  try {
    const url = new URL(input);
    if (url.password.length > 0) {
      push(url.password);
    }
    url.searchParams.forEach((value) => {
      push(value);
    });
    if (url.search.length > 1) {
      push(url.search);
      push(url.search.slice(1));
    }
    if (url.hash.length > 1) {
      push(url.hash);
      push(url.hash.slice(1));
    }
  } catch {
    // Not a URL; nothing secret to extract.
  }

  // Only redact substrings long enough to avoid mangling ordinary prose.
  // Short secrets (and the username, which can be a common word) are covered
  // by the exact-URL replacement and the credential-context patterns below.
  return [...new Set(secrets)].filter((secret) => secret.length >= 3).sort((a, b) => b.length - a.length);
}

function redactSourceSecretsFromDetail(detail: string, rawInput: string, displayUrl: string): string {
  let out = detail;

  if (rawInput.length > 0) {
    out = out.split(rawInput).join(displayUrl);
  }

  try {
    const url = new URL(rawInput);
    const { username, password } = url;
    if (username.length > 0 && password.length > 0) {
      const combo = `${username}:${password}`;
      if (combo.length > 0) {
        out = out.split(combo).join("[redacted]");
      }
      try {
        const decodedCombo = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
        if (decodedCombo.length > 0 && decodedCombo !== combo) {
          out = out.split(decodedCombo).join("[redacted]");
        }
      } catch {
        // Nothing to add.
      }
    }
    if (username.length > 0) {
      // Redact the username only in credentialed contexts (`USER:` / `USER@`)
      // so a common-word username never mangles unrelated prose like "git".
      const variants = new Set([username]);
      try {
        const decoded = decodeURIComponent(username);
        if (decoded.length > 0) {
          variants.add(decoded);
        }
      } catch {
        // Nothing to add.
      }
      try {
        const encoded = encodeURIComponent(username);
        if (encoded.length > 0) {
          variants.add(encoded);
        }
      } catch {
        // Nothing to add.
      }
      for (const variant of variants) {
        if (variant.length === 0) {
          continue;
        }
        out = out.split(`${variant}:`).join("[redacted]:");
        out = out.split(`${variant}@`).join("[redacted]@");
      }
    }
  } catch {
    // Not a URL; fall through to generic redaction.
  }

  for (const secret of collectSecretValues(rawInput)) {
    out = out.split(secret).join("[redacted]");
  }

  return redactGenericGitSecrets(out);
}

export function isHttpsGitSource(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && url.hostname.length > 0 && url.pathname.length > 1;
  } catch {
    return false;
  }
}

export function sanitizeRemoteSourceIdentity(input: string): string {
  const url = new URL(input);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";

  return `git+${url.toString()}`;
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
  const sourceIdentity = sanitizeRemoteSourceIdentity(input);
  const displayUrl = sourceIdentity.replace(/^git\+/, "");
  const rawGit = options.git ?? defaultGitRunner;

  // Every git failure is re-thrown with credentialed parts redacted, so all
  // callers (scan, install, interactive, --json) get safe diagnostics without
  // per-command handling. The message keeps the failed operation, the
  // sanitized source, the requested ref when there is one, and git's own
  // (redacted) stderr explanation.
  const git: GitRunner = async (args, cwd) => {
    try {
      return await rawGit(args, cwd);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const redactedDetail = redactSourceSecretsFromDetail(detail, input, displayUrl);
      const operation = args[0] ?? "git";
      const refSuffix = options.ref === undefined ? "" : ` (ref ${options.ref})`;
      throw new Error(`git ${operation} for ${sourceIdentity}${refSuffix} failed: ${redactedDetail}`);
    }
  };

  try {
    await git(["clone", "--depth", "1", input, scanRoot]);
    if (options.ref !== undefined) {
      await git(["fetch", "--depth", "1", "origin", options.ref], scanRoot);
      await git(["checkout", "--detach", "FETCH_HEAD"], scanRoot);
    }

    const resolvedCommit = (await git(["rev-parse", "HEAD"], scanRoot)).trim();

    return {
      scanRoot,
      sourceIdentity,
      requestedRef: options.ref,
      resolvedCommit,
      cleanup: async () => {
        await removeTempDir(tempDir);
      }
    };
  } catch (error) {
    await removeTempDir(tempDir);
    throw error;
  }
}
