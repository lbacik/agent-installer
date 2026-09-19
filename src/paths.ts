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
  configFile: string;
}

// The same redirected-HOME default `resolveTargetPaths` has always used (ADR 0003),
// shared so anything resolving `~/`-prefixed paths (config.ts) stays consistent with it.
export function resolveHome(home = process.env.HOME ?? path.join(process.cwd(), ".home")): string {
  return home;
}

export function resolveTargetPaths(home?: string): TargetPaths {
  const resolvedHome = resolveHome(home);
  const agentsRoot = path.join(resolvedHome, ".agents");
  const claudeRoot = path.join(resolvedHome, ".claude");
  const stateDir = path.join(agentsRoot, "agent-installer");

  return {
    agentsRoot,
    agentsSkillsDir: path.join(agentsRoot, "skills"),
    agentsPromptsDir: path.join(agentsRoot, "prompts"),
    claudeRoot,
    claudeSkillsDir: path.join(claudeRoot, "skills"),
    claudeCommandsDir: path.join(claudeRoot, "commands"),
    stateDir,
    stateFile: path.join(stateDir, "state.json"),
    configFile: path.join(stateDir, "config.yaml")
  };
}

export function artifactId(kind: ArtifactKind, name: string): string {
  return `${kind}:${name}`;
}

// A skill lives at "<dir>/<name>"; a prompt lives at "<dir>/<name>.md". Both the
// base-store copy and every configured exposure follow this same convention.
function artifactEntryName(artifact: Pick<DiscoveredArtifact, "kind" | "name">): string {
  return artifact.kind === "skill" ? artifact.name : `${artifact.name}.md`;
}

export function getBasePath(paths: TargetPaths, artifact: Pick<DiscoveredArtifact, "kind" | "name">): string {
  const dir = artifact.kind === "skill" ? paths.agentsSkillsDir : paths.agentsPromptsDir;
  return path.join(dir, artifactEntryName(artifact));
}

// A configured target directory plus an artifact's kind/name yields the exposure path
// that directory would hold for it.
export function resolveExposurePath(targetDir: string, artifact: Pick<DiscoveredArtifact, "kind" | "name">): string {
  return path.join(targetDir, artifactEntryName(artifact));
}

export function toSystemPath(basePath: string, relativePath: string): string {
  return path.join(basePath, ...relativePath.split("/"));
}

export function getMarkerPath(basePath: string, kind: ArtifactKind): string {
  return kind === "skill" ? path.join(basePath, ".agent-installer.json") : `${basePath}.agent-installer.json`;
}
