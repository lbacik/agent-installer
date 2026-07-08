#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import { collectArtifactStates, installArtifacts, removeArtifacts } from "./install.js";
import { formatArtifactLine, formatManagedEntryLine, formatRemovedLine } from "./format.js";
import { promptForSelections } from "./interactive.js";
import { resolveTargetPaths } from "./paths.js";
import { scanSourceRepository } from "./source.js";
import { loadState } from "./state.js";
import type { ScanSourceOptions } from "./source.js";
import type { ArtifactState } from "./types.js";

interface ScanCommandOptions {
  skillMaxDepth?: number;
}

function resolveSourcePath(inputPath?: string): string {
  return path.resolve(inputPath ?? process.cwd());
}

function printLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function toStateMap(states: ArtifactState[]): Map<string, ArtifactState> {
  return new Map(states.map((state) => [state.id, state]));
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--skill-max-depth must be a positive integer.");
  }

  return parsed;
}

function scanOptionsFromCommand(options: ScanCommandOptions): ScanSourceOptions {
  return options.skillMaxDepth === undefined ? {} : { skillMaxDepth: options.skillMaxDepth };
}

function addSkillMaxDepthOption(command: Command): Command {
  return command.option(
    "--skill-max-depth <depth>",
    "Maximum directory depth to search below skills/ for SKILL.md",
    parsePositiveInteger
  );
}

async function scanWithState(inputPath?: string, home?: string, scanOptions?: ScanSourceOptions) {
  const sourcePath = resolveSourcePath(inputPath);
  const artifacts = await scanSourceRepository(sourcePath, scanOptions);
  return collectArtifactStates(artifacts, home, sourcePath);
}

async function runInteractive(inputPath?: string, scanOptions?: ScanSourceOptions): Promise<void> {
  const { states, removed } = await scanWithState(inputPath, undefined, scanOptions);
  printLines(states.map(formatArtifactLine));
  if (removed.length > 0) {
    printLines(removed.map(formatRemovedLine));
  }

  const selection = await promptForSelections(states, removed);
  if (selection.cancelled) {
    console.log("No changes applied.");
    return;
  }

  const stateMap = toStateMap(states);
  const installTargets = selection.installIds.map((id) => {
    const state = stateMap.get(id);
    if (!state) {
      throw new Error(`Unknown artifact id: ${id}`);
    }

    return state;
  });

  if (selection.installIds.length > 0) {
    await installArtifacts(installTargets);
  }

  if (selection.removeIds.length > 0) {
    await removeArtifacts(selection.removeIds);
  }

  const summary = [];
  if (selection.installIds.length > 0) {
    summary.push(`installed/updated ${selection.installIds.length}`);
  }
  if (selection.removeIds.length > 0) {
    summary.push(`removed ${selection.removeIds.length}`);
  }

  console.log(summary.length > 0 ? summary.join(", ") : "No changes applied.");
}

function createProgram(): Command {
  const program = new Command();
  addSkillMaxDepthOption(program)
    .name("agent-installer")
    .description("Install Codex skills and Claude Code skills and commands from a local repository.")
    .argument("[path]", "Source repository to scan", process.cwd())
    .action(async (inputPath, options: ScanCommandOptions) => {
      await runInteractive(inputPath, scanOptionsFromCommand(options));
    });

  addSkillMaxDepthOption(program.command("scan"))
    .argument("[path]", "Source repository to scan", process.cwd())
    .action(async (inputPath, options: ScanCommandOptions) => {
      const { states, removed } = await scanWithState(inputPath, undefined, scanOptionsFromCommand(options));
      printLines(states.map(formatArtifactLine));
      if (removed.length > 0) {
        printLines(removed.map(formatRemovedLine));
      }
    });

  addSkillMaxDepthOption(program.command("install"))
    .description("Install or update all discovered artifacts from the source repository.")
    .argument("[path]", "Source repository to scan", process.cwd())
    .option("--all", "Install all discovered artifacts")
    .action(async (inputPath, options: ScanCommandOptions & { all?: boolean }) => {
      if (!options.all) {
        throw new Error("Use --all for non-interactive installation.");
      }

      const { states } = await scanWithState(inputPath, undefined, scanOptionsFromCommand(options));
      const installable = states.filter((state) => state.status === "new" || state.status === "installed-different");
      await installArtifacts(installable);
      console.log(`installed/updated ${installable.length}`);
    });

  program
    .command("uninstall")
    .description("Remove managed artifacts by id, for example skill:review or prompt:commit-message.")
    .argument("<ids...>", "Managed artifact ids")
    .action(async (ids: string[]) => {
      const removed = await removeArtifacts(ids);
      console.log(`removed ${removed.length}`);
    });

  program
    .command("list")
    .description("List currently managed artifacts from the base store.")
    .action(async () => {
      const state = await loadState(resolveTargetPaths());
      if (state.entries.length === 0) {
        console.log("No managed artifacts.");
        return;
      }

      for (const entry of state.entries) {
        console.log(formatManagedEntryLine(entry));
      }
    });

  return program;
}

async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
