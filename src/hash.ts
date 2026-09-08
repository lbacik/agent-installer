import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SourceConfigurationError } from "./errors.js";
import { toSystemPath } from "./paths.js";
import { ArtifactKind, OverlayFile } from "./types.js";

// Only the executable bit is hashed, not the full POSIX mode, so digests do
// not depend on the process umask or on group/other permission noise.
const EXECUTABLE_MODE_MASK = 0o111;

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
          return [{ relativePath, isExecutable: (stat.mode & EXECUTABLE_MODE_MASK) !== 0 }];
        }

        return [];
      })
  );

  return entries.flat();
}

export async function hashArtifact(
  kind: ArtifactKind,
  targetPath: string,
  overlay: OverlayFile | null = null
): Promise<string> {
  const hash = createHash("sha256");

  if (kind === "prompt") {
    const content = await fs.readFile(targetPath);
    hash.update(content);
    return hash.digest("hex");
  }

  const entries = await collectDirectoryEntries(targetPath, "");
  const entriesByPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  if (overlay !== null && !entriesByPath.has(overlay.relativePath)) {
    entriesByPath.set(overlay.relativePath, { relativePath: overlay.relativePath, isExecutable: false });
  }

  for (const relativePath of [...entriesByPath.keys()].sort()) {
    const entry = entriesByPath.get(relativePath)!;
    hash.update(relativePath);
    hash.update("\n");
    hash.update(entry.isExecutable ? "x" : "-");
    hash.update("\n");
    hash.update(
      relativePath === overlay?.relativePath
        ? overlay.content
        : await fs.readFile(toSystemPath(targetPath, relativePath))
    );
  }

  return hash.digest("hex");
}
