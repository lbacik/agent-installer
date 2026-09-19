import { promises as fs } from "node:fs";
import path from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import { stringify as stringifyYaml } from "yaml";
import { AgentInstallerConfig, ConfigTarget, configFileExists, validateConfig } from "./config.js";
import { TargetPaths } from "./paths.js";
import { loadState } from "./state.js";
import type { ArtifactKind } from "./types.js";

export interface ConfigInitOptions {
  force?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  clearPromptOnDone?: boolean;
}

const CLAUDE_PRESET = "claude";
const CUSTOM_PRESET = "custom";

interface PromptContext {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  clearPromptOnDone?: boolean;
}

// The legacy (pre-config.yaml) exposure symlinks all carry `targetName: null`. When every
// exposure of a kind sits in the same directory, that directory is what "claude" already
// meant on this machine, so the preset should prefill it instead of a generic default.
async function detectLegacyExposureDir(paths: TargetPaths, kind: ArtifactKind): Promise<string | null> {
  const state = await loadState(paths);
  const dirs = new Set(
    state.entries
      .filter((entry) => entry.kind === kind)
      .flatMap((entry) => entry.exposures)
      .filter((exposure) => exposure.targetName === null)
      .map((exposure) => path.dirname(exposure.path))
  );

  return dirs.size === 1 ? [...dirs][0]! : null;
}

async function promptTargetName(context: PromptContext): Promise<string> {
  return input(
    {
      message: 'Target name (leave blank to finish):'
    },
    context
  );
}

async function promptDirectory(message: string, defaultValue: string | undefined, context: PromptContext): Promise<string | undefined> {
  const answer = await input(
    {
      message: `${message} (leave blank to skip):`,
      ...(defaultValue === undefined ? {} : { default: defaultValue })
    },
    context
  );

  const trimmed = answer.trim();
  return trimmed === "" ? undefined : trimmed;
}

async function promptOneTarget(paths: TargetPaths, context: PromptContext): Promise<ConfigTarget | null> {
  const preset = await select(
    {
      message: "Preset",
      choices: [
        { name: "custom (enter directories manually)", value: CUSTOM_PRESET },
        { name: "claude (Claude Code skills + commands)", value: CLAUDE_PRESET }
      ]
    },
    context
  );

  const [skillsDefault, promptsDefault] =
    preset === CLAUDE_PRESET
      ? [
          (await detectLegacyExposureDir(paths, "skill")) ?? paths.claudeSkillsDir,
          (await detectLegacyExposureDir(paths, "prompt")) ?? paths.claudeCommandsDir
        ]
      : [undefined, undefined];

  const skills = await promptDirectory("Skills directory", skillsDefault, context);
  const prompts = await promptDirectory("Prompts directory", promptsDefault, context);

  if (skills === undefined && prompts === undefined) {
    return null;
  }

  return { ...(skills === undefined ? {} : { skills }), ...(prompts === undefined ? {} : { prompts }) };
}

function log(context: PromptContext, message: string): void {
  (context.output ?? process.stdout).write(`${message}\n`);
}

/**
 * Interactively builds `config.yaml` by repeatedly prompting for a target name and its
 * directories, until the user leaves a target name blank. Refuses to overwrite an existing
 * `config.yaml` unless `force` is set or the user confirms.
 */
export async function runConfigInit(paths: TargetPaths, options: ConfigInitOptions = {}): Promise<void> {
  const context: PromptContext = {
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.clearPromptOnDone === undefined ? {} : { clearPromptOnDone: options.clearPromptOnDone })
  };

  if ((await configFileExists(paths)) && options.force !== true) {
    const overwrite = await confirm(
      {
        message: `"${paths.configFile}" already exists. Overwrite it?`,
        default: false
      },
      context
    );

    if (!overwrite) {
      log(context, "Aborted: config.yaml already exists. Re-run with --force to skip this confirmation.");
      return;
    }
  }

  const targets: Record<string, ConfigTarget> = {};
  while (true) {
    const name = (await promptTargetName(context)).trim();
    if (name === "") {
      break;
    }

    const target = await promptOneTarget(paths, context);
    if (target === null) {
      log(context, `Skipped target "${name}": must set at least one of "skills" or "prompts".`);
      continue;
    }

    targets[name] = target;
  }

  if (Object.keys(targets).length === 0) {
    log(context, "No targets defined; config.yaml was not created.");
    return;
  }

  const config: AgentInstallerConfig = { version: 1, targets };
  await validateConfig(config, paths.configFile, paths);

  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.writeFile(paths.configFile, `${stringifyYaml(config)}`, "utf8");
  log(context, `Wrote ${paths.configFile}`);
}
