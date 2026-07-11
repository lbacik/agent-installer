#!/usr/bin/env node

import { Command } from "commander";
import { collectArtifactStates, installArtifacts, removeArtifacts } from "./install.js";
import { formatArtifactLine, formatOperationLine, formatRemovedLine } from "./format.js";
import { promptForManagedArtifactRemovals, promptForSelections } from "./interactive.js";
import { resolveTargetPaths } from "./paths.js";
import { loadState } from "./state.js";
import { withResolvedArtifactStates } from "./source-workflow.js";
import type { ScanSourceOptions } from "./source.js";
import type { ArtifactState } from "./types.js";

interface ScanCommandOptions {
  skillMaxDepth?: number;
  ref?: string;
}

interface InteractiveCommandOptions extends ScanCommandOptions {
  listLength?: number;
}

function printLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function toStateMap(states: ArtifactState[]): Map<string, ArtifactState> {
  return new Map(states.map((state) => [state.id, state]));
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer.`);
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
    (value) => parsePositiveInteger(value, "--skill-max-depth")
  );
}

function addRefOption(command: Command): Command {
  return command.option("--ref <ref>", "Git branch, tag, or commit to scan when the source is an HTTPS Git repository");
}

async function runInteractive(inputPath?: string, scanOptions?: ScanSourceOptions, listLength?: number, ref?: string): Promise<void> {
  await withResolvedArtifactStates(inputPath, undefined, scanOptions, ref === undefined ? undefined : { ref }, async ({ states, removed }) => {
    const selection = await promptForSelections(states, removed, {
      clearPromptOnDone: true,
      ...(listLength === undefined ? {} : { listLength })
    });
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

    const installed = selection.installIds.length > 0 ? await installArtifacts(installTargets) : [];
    const removedEntries = selection.removeIds.length > 0 ? await removeArtifacts(selection.removeIds) : [];

    const operations = [
      ...installTargets.map((state) => formatOperationLine(state.status === "new" ? "created" : "updated", state.id)),
      ...removedEntries.map((entry) => formatOperationLine("removed", entry.id))
    ];
    printLines(operations);
    if (installed.length === 0 && removedEntries.length === 0) {
      console.log("No changes applied.");
    }
  });
}

function createProgram(): Command {
  const program = new Command();
  addRefOption(addSkillMaxDepthOption(program))
    .name("agent-installer")
    .description("Install Codex skills and Claude Code skills and commands from a local or HTTPS Git repository.")
    .argument("[path]", "Source repository to scan", process.cwd())
    .option(
      "--list-length <count>",
      "Number of artifacts visible in the interactive selection list",
      (value) => parsePositiveInteger(value, "--list-length")
    )
    .action(async (inputPath, options: InteractiveCommandOptions) => {
      await runInteractive(inputPath, scanOptionsFromCommand(options), options.listLength, options.ref);
    });

  addRefOption(addSkillMaxDepthOption(program.command("scan")))
    .argument("[path]", "Source repository to scan", process.cwd())
    .action(async (inputPath, options: ScanCommandOptions) => {
      await withResolvedArtifactStates(
        inputPath,
        undefined,
        scanOptionsFromCommand(options),
        options.ref === undefined ? undefined : { ref: options.ref },
        async ({ states, removed }) => {
          printLines(states.map(formatArtifactLine));
          if (removed.length > 0) {
            printLines(removed.map(formatRemovedLine));
          }
        }
      );
    });

  addRefOption(addSkillMaxDepthOption(program.command("install")))
    .description("Install or update all discovered artifacts from the source repository.")
    .argument("[path]", "Source repository to scan", process.cwd())
    .option("--all", "Install all discovered artifacts")
    .action(async (inputPath, options: ScanCommandOptions & { all?: boolean }) => {
      if (!options.all) {
        throw new Error("Use --all for non-interactive installation.");
      }

      await withResolvedArtifactStates(
        inputPath,
        undefined,
        scanOptionsFromCommand(options),
        options.ref === undefined ? undefined : { ref: options.ref },
        async ({ states }) => {
          const installable = states.filter((state) => state.status === "new" || state.status === "installed-different");
          await installArtifacts(installable);
          console.log(`installed/updated ${installable.length}`);
        }
      );
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
    .description("Interactively manage currently installed artifacts from the base store.")
    .option(
      "--list-length <count>",
      "Number of artifacts visible in the interactive selection list",
      (value) => parsePositiveInteger(value, "--list-length")
    )
    .action(async (options: { listLength?: number }) => {
      const state = await loadState(resolveTargetPaths());
      if (state.entries.length === 0) {
        console.log("No managed artifacts.");
        return;
      }

      const selection = await promptForManagedArtifactRemovals(
        state.entries,
        {
          clearPromptOnDone: true,
          ...(options.listLength === undefined ? {} : { listLength: options.listLength })
        }
      );
      if (selection.cancelled) {
        console.log("No changes applied.");
        return;
      }

      const removed = await removeArtifacts(selection.removeIds);
      printLines(removed.map((entry) => formatOperationLine("removed", entry.id)));
      if (removed.length === 0) {
        console.log("No changes applied.");
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
