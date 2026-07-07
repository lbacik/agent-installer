import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ArtifactKind } from "./types.js";

async function collectDirectoryEntries(dir: string): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    dirents
      .filter((dirent) => dirent.name !== ".agent-installer.json")
      .map(async (dirent) => {
        const fullPath = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          return collectDirectoryEntries(fullPath);
        }

        if (dirent.isFile()) {
          return [fullPath];
        }

        return [];
      })
  );

  return entries.flat().sort();
}

export async function hashArtifact(kind: ArtifactKind, targetPath: string): Promise<string> {
  const hash = createHash("sha256");

  if (kind === "prompt") {
    const content = await fs.readFile(targetPath);
    hash.update(content);
    return hash.digest("hex");
  }

  const files = await collectDirectoryEntries(targetPath);

  for (const file of files) {
    hash.update(path.relative(targetPath, file));
    hash.update("\n");
    hash.update(await fs.readFile(file));
  }

  return hash.digest("hex");
}
