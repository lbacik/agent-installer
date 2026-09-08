#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { InstallConflictError, installAllFromSource, installArtifacts, removeArtifacts } from "./install.js";
import { formatArtifactLine, formatConflictLine, formatOperationLine, formatRemovedLine } from "./format.js";
import { promptForManagedArtifactRemovals, promptForSelections } from "./interactive.js";
import {
  buildArtifactsErrorJson,
  buildInstallErrorJson,
  buildInstallSuccessJson,
  buildListJson,
  buildScanJson
} from "./json-report.js";
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

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function addJsonOption(command: Command, description: string): Command {
  return command.option("--json", description);
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

function collectOnly(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function readPackageVersion(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.join(moduleDir, "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
  return packageJson.version;
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
    .version(readPackageVersion(), "-v, --version", "Output the installed CLI version")
    .argument("[path]", "Source repository to scan", process.cwd())
    .option(
      "--list-length <count>",
      "Number of artifacts visible in the interactive selection list",
      (value) => parsePositiveInteger(value, "--list-length")
    )
    .action(async (inputPath, options: InteractiveCommandOptions) => {
      await runInteractive(inputPath, scanOptionsFromCommand(options), options.listLength, options.ref);
    });

  addJsonOption(
    addRefOption(addSkillMaxDepthOption(program.command("scan"))),
    "Emit a machine-readable JSON report on stdout instead of human-readable output"
  )
    .argument("[path]", "Source repository to scan", process.cwd())
    .action(async (inputPath, options: ScanCommandOptions & { json?: boolean }) => {
      const json = options.json === true;
      try {
        await withResolvedArtifactStates(
          inputPath,
          undefined,
          scanOptionsFromCommand(options),
          options.ref === undefined ? undefined : { ref: options.ref },
          async ({ states, removed }) => {
            if (json) {
              printJson(buildScanJson(states, removed));
              return;
            }

            printLines(states.map(formatArtifactLine));
            if (removed.length > 0) {
              printLines(removed.map(formatRemovedLine));
            }
          }
        );
      } catch (error) {
        if (!json) {
          throw error;
        }

        printJson(buildArtifactsErrorJson(error));
        process.exitCode = 1;
      }
    });

  addJsonOption(
    addRefOption(addSkillMaxDepthOption(program.command("install"))),
    "Emit a machine-readable JSON report on stdout instead of human-readable output"
  )
    .description("Install or update discovered artifacts from the source repository (--all or --only).")
    .argument("[path]", "Source repository to scan", process.cwd())
    .option("--all", "Install all discovered artifacts")
    .option("--only <artifact-id>", "Install only this artifact id, for example skill:review (repeatable)", collectOnly, [])
    .option("--allow-conflicts", "Install eligible artifacts and skip conflicting ones instead of aborting")
    .option(
      "--prune",
      "Remove managed artifacts no longer present in the scanned source (deletes their base-store copy, exposure symlink, and state entry)"
    )
    .action(
      async (
        inputPath,
        options: ScanCommandOptions & {
          all?: boolean;
          only: string[];
          allowConflicts?: boolean;
          prune?: boolean;
          json?: boolean;
        }
      ) => {
        const json = options.json === true;
        try {
          const only = options.only.length > 0 ? options.only : undefined;
          if (options.all && only !== undefined) {
            throw new Error("--all and --only are mutually exclusive.");
          }

          if (!options.all && only === undefined) {
            throw new Error("Use --all for non-interactive installation.");
          }

          const { states, installed, conflicts, pruned } = await installAllFromSource(
            inputPath,
            undefined,
            scanOptionsFromCommand(options),
            options.ref === undefined ? undefined : { ref: options.ref },
            {
              allowConflicts: options.allowConflicts === true,
              prune: options.prune === true,
              ...(only === undefined ? {} : { only })
            }
          );

          if (json) {
            printJson(await buildInstallSuccessJson(states, installed, conflicts, pruned));
            return;
          }

          console.log(`installed/updated ${installed.length}`);
          for (const state of conflicts) {
            console.error(`skipped ${formatConflictLine(state)}`);
          }

          if (pruned.length > 0) {
            console.log(`pruned ${pruned.length}`);
            for (const entry of pruned) {
              console.log(formatOperationLine("removed", entry.id));
            }
          }
        } catch (error) {
          if (!json) {
            throw error;
          }

          const refused = error instanceof InstallConflictError ? error.conflicts : [];
          printJson(buildInstallErrorJson(error, refused));
          process.exitCode = 1;
        }
      }
    );

  program
    .command("uninstall")
    .description("Remove managed artifacts by id, for example skill:review or prompt:commit-message.")
    .argument("<ids...>", "Managed artifact ids")
    .action(async (ids: string[]) => {
      const removed = await removeArtifacts(ids);
      console.log(`removed ${removed.length}`);
    });

  addJsonOption(
    program.command("list"),
    "Emit a machine-readable JSON report of managed entries on stdout, non-interactively"
  )
    .description("Interactively manage currently installed artifacts from the base store.")
    .option(
      "--list-length <count>",
      "Number of artifacts visible in the interactive selection list",
      (value) => parsePositiveInteger(value, "--list-length")
    )
    .action(async (options: { listLength?: number; json?: boolean }) => {
      const json = options.json === true;
      try {
        const state = await loadState(resolveTargetPaths());

        if (json) {
          printJson(await buildListJson(state.entries));
          return;
        }

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
      } catch (error) {
        if (!json) {
          throw error;
        }

        printJson(buildArtifactsErrorJson(error));
        process.exitCode = 1;
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
