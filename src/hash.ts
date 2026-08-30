import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { toSystemPath } from "./paths.js";
import { ArtifactKind, OverlayFile } from "./types.js";

async function collectDirectoryEntries(dir: string, prefix: string): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    dirents
      .filter((dirent) => dirent.name !== ".agent-installer.json")
      .map(async (dirent) => {
        const relativePath = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
        if (dirent.isDirectory()) {
          return collectDirectoryEntries(path.join(dir, dirent.name), relativePath);
        }

        if (dirent.isFile()) {
          return [relativePath];
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

  const relativePaths = await collectDirectoryEntries(targetPath, "");
  const overlaidPaths = overlay === null ? relativePaths : [...new Set([...relativePaths, overlay.relativePath])];

  for (const relativePath of overlaidPaths.sort()) {
    hash.update(relativePath);
    hash.update("\n");
    hash.update(
      relativePath === overlay?.relativePath
        ? overlay.content
        : await fs.readFile(toSystemPath(targetPath, relativePath))
    );
  }

  return hash.digest("hex");
}
