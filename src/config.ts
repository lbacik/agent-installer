import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigurationError } from "./errors.js";
import { resolveHome, TargetPaths } from "./paths.js";

export type ExposureKind = "skills" | "prompts";

export interface ConfigTarget {
  skills?: string | undefined;
  prompts?: string | undefined;
}

export interface AgentInstallerConfig {
  version: 1;
  targets: Record<string, ConfigTarget>;
}

const targetSchema = z
  .object({
    skills: z.string().optional(),
    prompts: z.string().optional()
  })
  .strict()
  .refine((target) => target.skills !== undefined || target.prompts !== undefined, {
    message: 'must set at least one of "skills" or "prompts"'
  });

const configSchema = z
  .object({
    version: z.literal(1),
    targets: z.record(z.string(), targetSchema)
  })
  .strict();

function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? message;
}

function formatZodError(filePath: string, error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return `Invalid configuration file "${filePath}".`;
  }

  const location = issue.path.length > 0 ? ` at "${issue.path.join(".")}"` : "";
  return `Invalid configuration file "${filePath}"${location}: ${issue.message}`;
}

function isAllowedPathFormat(value: string): boolean {
  return path.isAbsolute(value) || value.startsWith("~/");
}

function expandHome(value: string, home: string): string {
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

// Resolves a path's existing prefix via `fs.realpath` (so a configured directory
// that is itself a symlink still compares by its real location) and falls back to
// `path.resolve` for any trailing segments that do not exist yet.
async function resolveRealish(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const trailing: string[] = [];
  let current = resolved;

  while (true) {
    try {
      const real = await fs.realpath(current);
      return trailing.length === 0 ? real : path.join(real, ...trailing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }

      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

function isNested(a: string, b: string): boolean {
  const relative = path.relative(a, b);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

interface ResolvedTargetPath {
  targetName: string;
  kind: ExposureKind;
  raw: string;
  resolvedPath: string;
}

async function validateConfigPaths(filePath: string, config: AgentInstallerConfig, paths: TargetPaths, home: string): Promise<void> {
  const declared: { targetName: string; kind: ExposureKind; raw: string }[] = [];
  for (const [targetName, target] of Object.entries(config.targets)) {
    if (target.skills !== undefined) {
      declared.push({ targetName, kind: "skills", raw: target.skills });
    }

    if (target.prompts !== undefined) {
      declared.push({ targetName, kind: "prompts", raw: target.prompts });
    }
  }

  for (const entry of declared) {
    if (!isAllowedPathFormat(entry.raw)) {
      throw new ConfigurationError(
        `Invalid configuration file "${filePath}": target "${entry.targetName}" ${entry.kind} path "${entry.raw}" must be absolute or start with "~/".`
      );
    }
  }

  const resolved: ResolvedTargetPath[] = await Promise.all(
    declared.map(async (entry) => ({
      ...entry,
      resolvedPath: await resolveRealish(expandHome(entry.raw, home))
    }))
  );

  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const a = resolved[i]!;
      const b = resolved[j]!;

      if (a.kind === b.kind && a.resolvedPath === b.resolvedPath) {
        throw new ConfigurationError(
          `Invalid configuration file "${filePath}": targets "${a.targetName}" and "${b.targetName}" both resolve ${a.kind} to "${a.resolvedPath}".`
        );
      }

      if (isNested(a.resolvedPath, b.resolvedPath) || isNested(b.resolvedPath, a.resolvedPath)) {
        throw new ConfigurationError(
          `Invalid configuration file "${filePath}": target "${a.targetName}" ${a.kind} ("${a.resolvedPath}") and ` +
            `target "${b.targetName}" ${b.kind} ("${b.resolvedPath}") must not nest inside one another.`
        );
      }
    }
  }

  const baseStoreDirs = await Promise.all([resolveRealish(paths.agentsRoot), resolveRealish(paths.stateDir)]);
  for (const entry of resolved) {
    for (const baseDir of baseStoreDirs) {
      if (entry.resolvedPath === baseDir || isNested(baseDir, entry.resolvedPath) || isNested(entry.resolvedPath, baseDir)) {
        throw new ConfigurationError(
          `Invalid configuration file "${filePath}": target "${entry.targetName}" ${entry.kind} ("${entry.resolvedPath}") ` +
            `must not equal or nest with the base store ("${baseDir}").`
        );
      }
    }
  }
}

// Shared by `loadConfig` (validating what is on disk) and `config init` (validating what
// is about to be written), so both paths reject the same malformed shapes and path
// relationships the same way.
export async function validateConfig(parsed: unknown, filePath: string, paths: TargetPaths, home?: string): Promise<AgentInstallerConfig> {
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigurationError(formatZodError(filePath, result.error));
  }

  await validateConfigPaths(filePath, result.data, paths, resolveHome(home));

  return result.data;
}

/**
 * Loads and validates `config.yaml`. Returns `null` when the file does not exist, meaning
 * base-store-only installation with no configured exposure targets. Any malformed
 * configuration -- parse failure, schema failure, unsupported version, or an invalid
 * path relationship -- throws a `ConfigurationError` naming the file and the problem.
 */
export async function loadConfig(paths: TargetPaths, home?: string): Promise<AgentInstallerConfig | null> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new ConfigurationError(`Cannot parse configuration file "${paths.configFile}": ${firstLine((error as Error).message)}`);
  }

  return validateConfig(parsed, paths.configFile, paths, home);
}

export async function configFileExists(paths: TargetPaths): Promise<boolean> {
  try {
    await fs.access(paths.configFile);
    return true;
  } catch {
    return false;
  }
}
