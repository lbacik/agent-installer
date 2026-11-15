import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runInstallFromStates } from "../src/install.js";
import { resolveTargetPaths } from "../src/paths.js";
import { withScannedSource } from "../src/source-workflow.js";
import type { GitRunner } from "../src/source-resolver.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.ts");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], home: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [CLI_ENTRY, ...args], {
      env: { ...process.env, HOME: home }
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1
    };
  }
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const repo = await makeTempDir("agent-installer-interactive-repo-");
  await fs.mkdir(path.join(repo, "skills", "review"), { recursive: true });
  await fs.writeFile(path.join(repo, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
  await fs.mkdir(path.join(repo, "prompts"), { recursive: true });
  await fs.writeFile(path.join(repo, "prompts", "commit-message.md"), "commit prompt\n", "utf8");
  return repo;
}

async function writeConfigYaml(paths: ReturnType<typeof resolveTargetPaths>, yaml: string): Promise<void> {
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.writeFile(paths.configFile, yaml, "utf8");
}

function makeCheckoutGitRunner(resolvedCommit: string, populate: (checkout: string) => Promise<void>, counts: { clones: number }): GitRunner {
  return async (args) => {
    if (args[0] === "clone") {
      counts.clones += 1;
      const checkout = args[4] ?? "";
      await populate(checkout);
      return "";
    }

    if (args[0] === "rev-parse") {
      return `${resolvedCommit}\n`;
    }

    return "";
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("interactive decision seam (runInstallFromStates)", () => {
  it("installs every other selected artifact and reports the conflicting pair as skipped without aborting", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-interactive-home-");
    const paths = resolveTargetPaths(home);
    const targetDir = path.join(home, "target-skills");
    await fs.mkdir(targetDir, { recursive: true });
    // Permanent exposure conflict for skill:review only.
    await fs.writeFile(path.join(targetDir, "review"), "user-owned\n", "utf8");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${targetDir}\n`);

    await withScannedSource(repo, { home }, async ({ states, removed, resolvedCommit }) => {
      // Drives the picker's selection without mocking @inquirer/prompts
      // internals: the same ids the picker would hand over.
      const only = ["skill:review", "prompt:commit-message"];
      const result = await runInstallFromStates(states, removed, {
        home,
        allowConflicts: true,
        only,
        resolvedCommit
      });

      expect(result.outcome.outcome).toBe("complete");
      // The run does not abort on the exposure conflict.
      expect(result.outcome.error).toBeUndefined();
      // The conflicting (artifact, target) pair is reported as skipped.
      expect(result.exposureConflicts).toHaveLength(1);
      expect(result.exposureConflicts[0]).toMatchObject({ id: "skill:review", targetName: "claude" });
      // Every other selected artifact still installs (fresh home, so both are written as new).
      const review = result.outcome.artifacts.find((record) => record.id === "skill:review");
      const prompt = result.outcome.artifacts.find((record) => record.id === "prompt:commit-message");
      expect(review?.disposition).toBe("installed");
      expect(prompt?.disposition).toBe("installed");
      // Base copies exist for both selected artifacts.
      await expect(fs.access(path.join(paths.agentsSkillsDir, "review", "SKILL.md"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(paths.agentsPromptsDir, "commit-message.md"))).resolves.toBeUndefined();
      // The conflicting exposure was never touched.
      expect(await fs.readFile(path.join(targetDir, "review"), "utf8")).toBe("user-owned\n");
    });
  });

  it("resolves/clones a remote source only once across picking and installing", async () => {
    const home = await makeTempDir("agent-installer-interactive-home-");
    const counts = { clones: 0 };
    const commit = "c".repeat(40);
    const git = makeCheckoutGitRunner(
      commit,
      async (checkout) => {
        await fs.mkdir(path.join(checkout, "skills", "review"), { recursive: true });
        await fs.writeFile(path.join(checkout, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
      },
      counts
    );

    await withScannedSource(
      "https://github.com/org/repo.git",
      { home, resolveOptions: { ref: "main", git } },
      async ({ states, removed, resolvedCommit }) => {
        // The install reuses the already-reconciled states: no second clone.
        const result = await runInstallFromStates(states, removed, {
          home,
          allowConflicts: true,
          only: ["skill:review"],
          resolvedCommit
        });
        expect(result.outcome.artifacts.map((record) => record.id)).toEqual(["skill:review"]);
      }
    );

    expect(counts.clones).toBe(1);
  });
});

describe("install human-readable counter with an unchanged exposure-conflicted artifact", () => {
  it("reports 0 installed/updated on the second run and still reports the skipped exposure", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-interactive-home-");
    const paths = resolveTargetPaths(home);
    const targetDir = path.join(home, "target-skills");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "review"), "user-owned\n", "utf8");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${targetDir}\n`);

    const first = await runCli(["install", repo, "--all", "--allow-conflicts"], home);
    expect(first.exitCode).toBe(0);

    const second = await runCli(["install", repo, "--all", "--allow-conflicts"], home);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/installed\/updated 0/);
    expect(second.stderr).toMatch(/skipped skill:review -> claude:/);
  });
});

describe("install selection validation", () => {
  it("mentions both --all and --only in legacy and schema-3 errors", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-interactive-home-");

    const legacy = await runCli(["install", repo], home);
    expect(legacy.exitCode).not.toBe(0);
    expect(legacy.stderr).toMatch(/--all/);
    expect(legacy.stderr).toMatch(/--only/);

    const v3 = await runCli(["install", repo, "--json", "--json-schema", "3"], home);
    expect(v3.exitCode).not.toBe(0);
    expect(v3.stderr).toMatch(/--all/);
    expect(v3.stderr).toMatch(/--only/);
  });

  it("still rejects --all with --only as mutually exclusive", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-interactive-home-");

    const result = await runCli(["install", repo, "--all", "--only", "skill:review"], home);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/mutually exclusive/);
  });
});

describe("sync --json option", () => {
  it("behaves exactly as before through the shared JSON-option helper", async () => {
    const home = await makeTempDir("agent-installer-interactive-home-");
    const result = await runCli(["sync", "--json"], home);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(2);
  });
});
