import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { toSystemPath } from "./paths.js";
import { OverlayFile } from "./types.js";

const SKILL_ENTRYPOINT = "SKILL.md";
const CLAUDE_DISABLE_KEY = "disable-model-invocation";

const CODEX_METADATA_RELATIVE_PATH = "agents/openai.yaml";

function extractFrontmatter(content: string): string | null {
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(normalized);
  return match?.[1] ?? null;
}

function declaresDisabledModelInvocation(content: string): boolean {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch {
    return false;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }

  return (parsed as Record<string, unknown>)[CLAUDE_DISABLE_KEY] === true;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Translate the Claude frontmatter invocation intent of a source skill into the
 * Codex metadata that the managed copy should carry. Only a literal boolean
 * `disable-model-invocation: true` translates; every other frontmatter, including
 * absent or malformed frontmatter, leaves the skill unchanged.
 *
 * A skill that already ships authored `agents/openai.yaml` metadata keeps that
 * metadata verbatim and receives no generated policy.
 */
export async function resolveInvocationPolicyOverlay(skillSourcePath: string): Promise<OverlayFile | null> {
  let content: string;
  try {
    content = await fs.readFile(path.join(skillSourcePath, SKILL_ENTRYPOINT), "utf8");
  } catch {
    return null;
  }

  if (!declaresDisabledModelInvocation(content)) {
    return null;
  }

  if (await pathExists(toSystemPath(skillSourcePath, CODEX_METADATA_RELATIVE_PATH))) {
    return null;
  }

  return {
    relativePath: CODEX_METADATA_RELATIVE_PATH,
    content: stringifyYaml({ policy: { allow_implicit_invocation: false } })
  };
}

export async function materializeOverlay(basePath: string, overlay: OverlayFile | null): Promise<void> {
  if (overlay === null) {
    return;
  }

  const targetPath = toSystemPath(basePath, overlay.relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, overlay.content, "utf8");
}
