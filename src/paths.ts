import path from "node:path";
import { ArtifactKind, DiscoveredArtifact } from "./types.js";

export interface TargetPaths {
  agentsRoot: string;
  agentsSkillsDir: string;
  agentsPromptsDir: string;
  claudeRoot: string;
  claudeSkillsDir: string;
  claudeCommandsDir: string;
  stateDir: string;
  stateFile: string;
}

export function resolveTargetPaths(home = process.env.HOME ?? path.join(process.cwd(), ".home")): TargetPaths {
  const agentsRoot = path.join(home, ".agents");
  const claudeRoot = path.join(home, ".claude");
  const stateDir = path.join(agentsRoot, "agent-installer");

  return {
    agentsRoot,
    agentsSkillsDir: path.join(agentsRoot, "skills"),
    agentsPromptsDir: path.join(agentsRoot, "prompts"),
    claudeRoot,
    claudeSkillsDir: path.join(claudeRoot, "skills"),
    claudeCommandsDir: path.join(claudeRoot, "commands"),
    stateDir,
    stateFile: path.join(stateDir, "state.json")
  };
}

export function artifactId(kind: ArtifactKind, name: string): string {
  return `${kind}:${name}`;
}

export function getBasePath(paths: TargetPaths, artifact: Pick<DiscoveredArtifact, "kind" | "name">): string {
  if (artifact.kind === "skill") {
    return path.join(paths.agentsSkillsDir, artifact.name);
  }

  return path.join(paths.agentsPromptsDir, `${artifact.name}.md`);
}

export function getExposurePath(paths: TargetPaths, artifact: Pick<DiscoveredArtifact, "kind" | "name">): string {
  if (artifact.kind === "skill") {
    return path.join(paths.claudeSkillsDir, artifact.name);
  }

  return path.join(paths.claudeCommandsDir, `${artifact.name}.md`);
}

export function getMarkerPath(basePath: string, kind: ArtifactKind): string {
  return kind === "skill" ? path.join(basePath, ".agent-installer.json") : `${basePath}.agent-installer.json`;
}
