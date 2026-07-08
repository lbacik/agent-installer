import { promises as fs } from "node:fs";
import path from "node:path";
import { DiscoveredArtifact } from "./types.js";

const DEFAULT_SKILL_MAX_DEPTH = 3;

export interface ScanSourceOptions {
  skillMaxDepth?: number;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveSkillMaxDepth(options?: ScanSourceOptions): number {
  return options?.skillMaxDepth ?? DEFAULT_SKILL_MAX_DEPTH;
}

async function discoverSkills(sourceRoot: string, maxDepth: number): Promise<DiscoveredArtifact[]> {
  const skillsDir = path.join(sourceRoot, "skills");
  const skillsByName = new Map<string, DiscoveredArtifact>();

  if (!(await pathExists(skillsDir)) || maxDepth < 1) {
    return [];
  }

  async function visitDirectory(currentPath: string, depth: number): Promise<void> {
    const entrypoint = path.join(currentPath, "SKILL.md");
    if (await pathExists(entrypoint)) {
      const name = path.basename(currentPath);
      const existing = skillsByName.get(name);
      if (existing) {
        throw new Error(
          `Duplicate skill name "${name}" found at "${existing.relativeSourcePath}" and "${path.relative(sourceRoot, currentPath)}".`
        );
      }

      skillsByName.set(name, {
        kind: "skill",
        name,
        sourceRoot,
        sourcePath: currentPath,
        relativeSourcePath: path.relative(sourceRoot, currentPath)
      });
    }

    if (depth >= maxDepth) {
      return;
    }

    const dirents = await fs.readdir(currentPath, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        await visitDirectory(path.join(currentPath, dirent.name), depth + 1);
      }
    }
  }

  const dirents = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      await visitDirectory(path.join(skillsDir, dirent.name), 1);
    }
  }

  return [...skillsByName.values()];
}

export async function scanSourceRepository(inputPath: string, options?: ScanSourceOptions): Promise<DiscoveredArtifact[]> {
  const sourceRoot = await fs.realpath(inputPath);
  const artifacts: DiscoveredArtifact[] = [];

  artifacts.push(...(await discoverSkills(sourceRoot, resolveSkillMaxDepth(options))));

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
