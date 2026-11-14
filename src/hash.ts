import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SourceConfigurationError } from "./errors.js";
import { toSystemPath } from "./paths.js";
import { ArtifactKind, ContentFileRecord, ContentIdentity, OverlayFile } from "./types.js";

// Only the executable bit is hashed, not the full POSIX mode, so digests do
// not depend on the process umask or on group/other permission noise.
const EXECUTABLE_MODE_MASK = 0o111;

/** Content-identity algorithm for skills hashed with the length-framed tree encoding (see docs/content-identity.md). */
export const SKILL_TREE_ALGORITHM_V2 = "agent-installer-tree-v2";

/** Content-identity algorithm label for skill hashes persisted before the v2 encoding existed. */
export const SKILL_TREE_ALGORITHM_V1 = "agent-installer-tree-v1";

/** Content-identity algorithm for prompts: plain SHA-256 over the raw file bytes. */
export const PROMPT_HASH_ALGORITHM = "sha256";

interface HashEntry {
  relativePath: string;
  isExecutable: boolean;
}

async function collectDirectoryEntries(dir: string, prefix: string): Promise<HashEntry[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    dirents
      .filter((dirent) => dirent.name !== ".agent-installer.json")
      .map(async (dirent) => {
        const entryPath = path.join(dir, dirent.name);
        const relativePath = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;

        if (dirent.isSymbolicLink()) {
          throw new SourceConfigurationError(
            `Skill directory contains a symlink at "${relativePath}" (${entryPath}). ` +
              `Symlinks inside skill directories are not supported; replace it with a regular file or directory in the source repository.`
          );
        }

        if (dirent.isDirectory()) {
          return collectDirectoryEntries(entryPath, relativePath);
        }

        if (dirent.isFile()) {
          const stat = await fs.stat(entryPath);
          if (!stat.isFile()) {
            throw new SourceConfigurationError(
              `Skill directory contains a non-regular file at "${relativePath}" (${entryPath}). ` +
                `Only regular files and directories are supported; replace it with a regular file in the source repository.`
            );
          }
          return [{ relativePath, isExecutable: (stat.mode & EXECUTABLE_MODE_MASK) !== 0 }];
        }

        throw new SourceConfigurationError(
          `Skill directory contains an unsupported file type at "${relativePath}" (${entryPath}). ` +
            `Only regular files and directories are supported; replace it with a regular file or directory in the source repository.`
        );
      })
  );

  return entries.flat();
}

/** UTF-8 byte-order comparison for content paths (differs from UTF-16 code-unit order outside ASCII/BMP). */
export function compareContentPaths(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Length-framed skill tree digest (ADR 0005): every path and every content
 * byte string is length-prefixed and NUL-delimited, so distinct trees can
 * never produce the same byte stream. Entries feed in UTF-8 byte order of
 * their `/`-separated relative path.
 */
function digestSkillTreeV2(resolved: Array<{ relativePath: string; isExecutable: boolean; content: Buffer }>): string {
  const hash = createHash("sha256");
  hash.update("agent-installer-tree-v2\x00", "utf8");
  for (const entry of resolved) {
    const pathBytes = Buffer.from(entry.relativePath, "utf8");
    hash.update(`path ${pathBytes.length}\x00`, "utf8");
    hash.update(pathBytes);
    hash.update(`\x00mode ${entry.isExecutable ? "x" : "-"}\x00content ${entry.content.length}\x00`, "utf8");
    hash.update(entry.content);
    hash.update("\x00", "utf8");
  }

  return hash.digest("hex");
}

/**
 * Freshly verified content identity for one artifact copy: the expected
 * source view (pass the installer Overlay) or an on-disk base-store view
 * (pass no Overlay; the materialized files hash as they lie). Prompts hash
 * as plain SHA-256 over the file bytes; skills use `agent-installer-tree-v2`.
 * The per-file inventory comes from the same walk as the digest.
 */
export async function hashArtifactContent(
  kind: ArtifactKind,
  targetPath: string,
  overlay: OverlayFile | null = null
): Promise<ContentIdentity> {
  if (kind === "prompt") {
    const content = await fs.readFile(targetPath);
    const digest = hashBytes(content);
    const files: ContentFileRecord[] = [{ path: path.basename(targetPath), sha256: digest, executable: false }];
    return { algorithm: PROMPT_HASH_ALGORITHM, digest, files };
  }

  const entries = await collectDirectoryEntries(targetPath, "");
  const entriesByPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  if (overlay !== null && !entriesByPath.has(overlay.relativePath)) {
    entriesByPath.set(overlay.relativePath, { relativePath: overlay.relativePath, isExecutable: false });
  }

  const sortedPaths = [...entriesByPath.keys()].sort(compareContentPaths);
  const resolved = await Promise.all(
    sortedPaths.map(async (relativePath) => {
      const entry = entriesByPath.get(relativePath)!;
      const content =
        relativePath === overlay?.relativePath
          ? Buffer.from(overlay.content, "utf8")
          : await fs.readFile(toSystemPath(targetPath, relativePath));
      return { relativePath, isExecutable: entry.isExecutable, content };
    })
  );

  return {
    algorithm: SKILL_TREE_ALGORITHM_V2,
    digest: digestSkillTreeV2(resolved),
    files: resolved.map((entry) => ({
      path: entry.relativePath,
      sha256: hashBytes(entry.content),
      executable: entry.isExecutable
    }))
  };
}

export async function hashArtifact(
  kind: ArtifactKind,
  targetPath: string,
  overlay: OverlayFile | null = null
): Promise<string> {
  return (await hashArtifactContent(kind, targetPath, overlay)).digest;
}
