import { promises as fs } from "node:fs";
import path from "node:path";
import { DiscoveredArtifact } from "./types.js";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function scanSourceRepository(inputPath: string): Promise<DiscoveredArtifact[]> {
  const sourceRoot = await fs.realpath(inputPath);
  const artifacts: DiscoveredArtifact[] = [];

  const skillsDir = path.join(sourceRoot, "skills");
  if (await pathExists(skillsDir)) {
    const dirents = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) {
        continue;
      }

      const skillPath = path.join(skillsDir, dirent.name);
      const entrypoint = path.join(skillPath, "SKILL.md");
      if (await pathExists(entrypoint)) {
        artifacts.push({
          kind: "skill",
          name: dirent.name,
          sourceRoot,
          sourcePath: skillPath,
          relativeSourcePath: path.relative(sourceRoot, skillPath)
        });
      }
    }
  }

  const promptCandidates = new Map<string, DiscoveredArtifact>();
  for (const folder of ["prompts", "commands"]) {
    const folderPath = path.join(sourceRoot, folder);
    if (!(await pathExists(folderPath))) {
      continue;
    }

    const dirents = await fs.readdir(folderPath, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isFile() || path.extname(dirent.name) !== ".md") {
        continue;
      }

      const name = path.basename(dirent.name, ".md");
      if (promptCandidates.has(name)) {
        const first = promptCandidates.get(name);
        throw new Error(
          `Duplicate prompt or command name "${name}" found at "${first?.relativeSourcePath}" and "${path.join(folder, dirent.name)}".`
        );
      }

      const sourcePath = path.join(folderPath, dirent.name);
      promptCandidates.set(name, {
        kind: "prompt",
        name,
        sourceRoot,
        sourcePath,
        relativeSourcePath: path.relative(sourceRoot, sourcePath)
      });
    }
  }

  artifacts.push(...promptCandidates.values());
  return artifacts.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
}
