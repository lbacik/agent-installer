import { promises as fs } from "node:fs";
import path from "node:path";
import { Document, isMap, isScalar, parse as parseYaml, parseDocument } from "yaml";
import { toSystemPath } from "./paths.js";
import { OverlayFile } from "./types.js";

const SKILL_ENTRYPOINT = "SKILL.md";
const CLAUDE_DISABLE_KEY = "disable-model-invocation";

const CODEX_METADATA_RELATIVE_PATH = "agents/openai.yaml";
const CODEX_POLICY_KEY = "policy";
const CODEX_IMPLICIT_INVOCATION_KEY = "allow_implicit_invocation";

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

async function readIfPresent(targetPath: string): Promise<string | null> {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return null;
  }
}

function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? message;
}

class SourceConfigurationError extends Error {
  constructor(skillSourcePath: string, metadataPath: string, problem: string) {
    super(
      `Cannot translate "${CLAUDE_DISABLE_KEY}: true" for skill "${path.basename(skillSourcePath)}": ` +
        `its authored Codex metadata "${metadataPath}" ${problem}. ` +
        `Fix that file in the source repository, or remove "${CLAUDE_DISABLE_KEY}: true" from ${SKILL_ENTRYPOINT}.`
    );
    this.name = "SourceConfigurationError";
  }
}

/**
 * Parse authored Codex metadata that the translation must build on. Anything the
 * installer cannot merge into deterministically is a source-configuration error,
 * so no managed artifact is created or changed from an ambiguous configuration.
 */
function parseAuthoredMetadata(skillSourcePath: string, metadataPath: string, content: string): Document {
  const document = parseDocument(content);
  const reject = (problem: string): never => {
    throw new SourceConfigurationError(skillSourcePath, metadataPath, problem);
  };

  if (document.errors.length > 0) {
    reject(`is not valid YAML (${firstLine(document.errors[0]!.message)})`);
  }

  if (document.contents !== null && !isMap(document.contents)) {
    reject("must be a YAML mapping");
  }

  const policy = document.get(CODEX_POLICY_KEY, true);
  if (policy === null || (isScalar(policy) && policy.value === null)) {
    // An empty `policy:` carries no authored intent, so the translation fills it
    // in place rather than failing on a value it cannot descend into.
    document.set(CODEX_POLICY_KEY, document.createNode({}));
  } else if (policy !== undefined && !isMap(policy)) {
    reject(`must define "${CODEX_POLICY_KEY}" as a YAML mapping`);
  }

  return document;
}

/**
 * Translate the Claude frontmatter invocation intent of a source skill into the
 * Codex metadata that the managed copy should carry. Only a literal boolean
 * `disable-model-invocation: true` translates; every other frontmatter, including
 * absent or malformed frontmatter, leaves the skill unchanged.
 *
 * A skill that already ships authored `agents/openai.yaml` metadata keeps that
 * metadata, including unrelated keys and comments; only the nested invocation
 * policy is overridden, because the Claude declaration is the cross-runtime one
 * being translated. Authored metadata that cannot be parsed and merged raises a
 * source-configuration error instead of being replaced.
 */
export async function resolveInvocationPolicyOverlay(skillSourcePath: string): Promise<OverlayFile | null> {
  const skillContent = await readIfPresent(path.join(skillSourcePath, SKILL_ENTRYPOINT));
  if (skillContent === null || !declaresDisabledModelInvocation(skillContent)) {
    return null;
  }

  const metadataPath = toSystemPath(skillSourcePath, CODEX_METADATA_RELATIVE_PATH);
  const authored = await readIfPresent(metadataPath);
  const document = authored === null ? new Document({}) : parseAuthoredMetadata(skillSourcePath, metadataPath, authored);

  document.setIn([CODEX_POLICY_KEY, CODEX_IMPLICIT_INVOCATION_KEY], false);

  return {
    relativePath: CODEX_METADATA_RELATIVE_PATH,
    // lineWidth 0 disables folding, so authored long scalars survive the round trip.
    content: document.toString({ lineWidth: 0 })
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
