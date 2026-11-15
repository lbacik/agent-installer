import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { hashArtifactContent } from "../src/hash.js";
import { runInstall } from "../src/install.js";
import { managedEntryToJson } from "../src/json-report.js";
import { resolveTargetPaths } from "../src/paths.js";
import { loadState } from "../src/state.js";
import type { GitRunner } from "../src/source-resolver.js";
import type { InstallArtifactOutcome, InstallOutcome } from "../src/types.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.ts");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], home: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [CLI_ENTRY, ...args], {
      env: { ...process.env, HOME: home, ...extraEnv }
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
  const repo = await makeTempDir("agent-installer-v3-repo-");
  await fs.mkdir(path.join(repo, "skills", "review"), { recursive: true });
  await fs.writeFile(path.join(repo, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
  await fs.mkdir(path.join(repo, "prompts"), { recursive: true });
  await fs.writeFile(path.join(repo, "prompts", "commit-message.md"), "commit prompt\n", "utf8");
  return repo;
}

async function writeSkill(repo: string, name: string, content: string): Promise<string> {
  const skillPath = path.join(repo, "skills", name);
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, "SKILL.md"), content, "utf8");
  return skillPath;
}

function skillWithFrontmatter(body: string): string {
  return `---\n${body}\n---\n\n# Restricted\n`;
}

async function writeCodexMetadata(skillPath: string, content: string): Promise<void> {
  await fs.mkdir(path.join(skillPath, "agents"), { recursive: true });
  await fs.writeFile(path.join(skillPath, "agents", "openai.yaml"), content, "utf8");
}

async function writeConfigYaml(paths: ReturnType<typeof resolveTargetPaths>, yaml: string): Promise<void> {
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.writeFile(paths.configFile, yaml, "utf8");
}

function makeCheckoutGitRunner(resolvedCommit: string, populate: (checkout: string) => Promise<void>): GitRunner {
  return async (args) => {
    if (args[0] === "clone") {
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

function recordById(outcome: InstallOutcome, id: string): InstallArtifactOutcome {
  const record = outcome.artifacts.find((candidate) => candidate.id === id);
  expect(record, `expected a record for ${id}`).toBeDefined();
  return record!;
}

afterEach(async () => {
  delete process.env.AGENT_INSTALLER_TEST_FAIL_WRITE;
  delete process.env.AGENT_INSTALLER_TEST_CORRUPT_WRITE;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("install --json-schema selection", () => {
  it("emits byte-identical v2 output with and without --json-schema 2", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");

    const plain = await runCli(["install", repo, "--all", "--json"], home);
    expect(plain.exitCode).toBe(0);
    await fs.rm(path.join(home, ".agents"), { recursive: true, force: true });

    const explicit = await runCli(["install", repo, "--all", "--json", "--json-schema", "2"], home);
    expect(explicit.exitCode).toBe(0);

    expect(explicit.stdout).toBe(plain.stdout);
    expect(JSON.parse(explicit.stdout)).toMatchObject({ schemaVersion: 2 });
  });

  it("rejects --json-schema 3 without --json and changes nothing", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    const paths = resolveTargetPaths(home);

    const result = await runCli(["install", repo, "--all", "--json-schema", "3"], home);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/--json-schema requires --json/);
    await expect(fs.access(paths.stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(paths.agentsSkillsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unknown --json-schema value and changes nothing", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    const paths = resolveTargetPaths(home);

    const result = await runCli(["install", repo, "--all", "--json", "--json-schema", "4"], home);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--json-schema must be 2 or 3/);
    await expect(fs.access(paths.stateFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects --json-schema 3 for scan, list, and sync", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");

    for (const command of ["scan", "list", "sync"]) {
      const args = command === "scan" ? [command, repo, "--json", "--json-schema", "3"] : [command, "--json", "--json-schema", "3"];
      const result = await runCli(args, home);
      expect(result.exitCode, command).not.toBe(0);
      expect(result.stdout, command).toBe("");
      expect(result.stderr, command).toMatch(/only supported by install/);
    }
  });

  it("accepts --json-schema 2 for scan, list, and sync", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");

    for (const command of ["scan", "list", "sync"]) {
      const args = command === "scan" ? [command, repo, "--json", "--json-schema", "2"] : [command, "--json", "--json-schema", "2"];
      const result = await runCli(args, home);
      expect(result.exitCode, command).toBe(0);
      expect(JSON.parse(result.stdout), command).toMatchObject({ schemaVersion: 2 });
    }
  });
});

describe("install --json --json-schema 3 end to end", () => {
  it("reports one installed record per artifact, then unchanged on repeat", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");

    const first = await runCli(["install", repo, "--all", "--json", "--json-schema", "3"], home);
    expect(first.exitCode).toBe(0);
    const firstReport = JSON.parse(first.stdout) as InstallOutcome;
    expect(firstReport).toMatchObject({ schemaVersion: 3, kind: "agent-installer.install-report" });
    expect(firstReport.outcome).toBe("complete");
    expect(firstReport.error).toBeUndefined();
    expect(firstReport.artifacts.map((record) => record.id).sort()).toEqual([
      "prompt:commit-message",
      "skill:review"
    ]);
    for (const record of firstReport.artifacts) {
      expect(record.disposition).toBe("installed");
      expect(record.requestedRef).toBeNull();
      expect(record.resolvedCommit).toBeNull();
      expect(record.content?.expectedHash).toBe(record.content?.installedHash);
    }

    const second = await runCli(["install", repo, "--all", "--json", "--json-schema", "3"], home);
    expect(second.exitCode).toBe(0);
    const secondReport = JSON.parse(second.stdout) as InstallOutcome;
    expect(secondReport.outcome).toBe("complete");
    expect(secondReport.artifacts.every((record) => record.disposition === "unchanged")).toBe(true);
  });

  it("exits 1 with an aborted conflict report on strict refusal, and 0 with partial on --allow-conflicts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(paths.agentsPromptsDir, { recursive: true });
    await fs.writeFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "user-owned\n", "utf8");

    const strict = await runCli(["install", repo, "--all", "--json", "--json-schema", "3"], home);
    expect(strict.exitCode).toBe(1);
    const strictReport = JSON.parse(strict.stdout) as InstallOutcome;
    expect(strictReport.outcome).toBe("aborted");
    expect(strictReport.error?.code).toBe("conflict");
    expect(recordById(strictReport, "prompt:commit-message").disposition).toBe("conflict");
    expect(recordById(strictReport, "skill:review").disposition).toBe("not-attempted");

    const lenient = await runCli(["install", repo, "--all", "--json", "--json-schema", "3", "--allow-conflicts"], home);
    expect(lenient.exitCode).toBe(0);
    const lenientReport = JSON.parse(lenient.stdout) as InstallOutcome;
    expect(lenientReport.outcome).toBe("partial");
    expect(lenientReport.error).toBeUndefined();
    expect(recordById(lenientReport, "prompt:commit-message").disposition).toBe("conflict");
    expect(recordById(lenientReport, "skill:review").disposition).toBe("installed");
  });
});

describe("runInstall v3 outcome", () => {
  it("reports fresh content identity matching the base-store copy for a git source", async () => {
    const home = await makeTempDir("agent-installer-v3-home-");
    const commit = "c".repeat(40);
    const git = makeCheckoutGitRunner(commit, async (checkout) => {
      await fs.mkdir(path.join(checkout, "skills", "review"), { recursive: true });
      await fs.writeFile(path.join(checkout, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
      await fs.mkdir(path.join(checkout, "prompts"), { recursive: true });
      await fs.writeFile(path.join(checkout, "prompts", "commit-message.md"), "commit prompt\n", "utf8");
    });

    const { outcome } = await runInstall({
      sourcePath: "https://github.com/org/repo.git",
      home,
      resolveOptions: { ref: "main", git }
    });

    expect(outcome.outcome).toBe("complete");
    expect(outcome.exposureOutcome).toBe("not-configured");
    expect(outcome.artifacts).toHaveLength(2);
    const paths = resolveTargetPaths(home);
    for (const record of outcome.artifacts) {
      expect(record.disposition).toBe("installed");
      expect(record.sourceIdentity).toBe("git+https://github.com/org/repo.git");
      expect(record.requestedRef).toBe("main");
      expect(record.resolvedCommit).toBe(commit);
      expect(record.content?.algorithm).toBe(record.kind === "skill" ? "agent-installer-tree-v2" : "sha256");
      expect(record.content?.expectedHash).toBe(record.content?.installedHash);
      expect(record.basePath.startsWith(record.kind === "skill" ? paths.agentsSkillsDir : paths.agentsPromptsDir)).toBe(
        true
      );

      const reverified = await hashArtifactContent(record.kind, record.basePath);
      expect(record.content?.installedHash).toBe(reverified.digest);
      expect(record.files).toEqual(reverified.files);
    }
  });

  it("reports unchanged with freshly computed content on repeat installs", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");

    await runInstall({ sourcePath: repo, home });
    const { outcome } = await runInstall({ sourcePath: repo, home });

    expect(outcome.outcome).toBe("complete");
    expect(outcome.artifacts.every((record) => record.disposition === "unchanged")).toBe(true);
    for (const record of outcome.artifacts) {
      const reverified = await hashArtifactContent(record.kind, record.basePath);
      expect(record.content?.installedHash).toBe(reverified.digest);
    }
  });

  it("repairs a deleted exposure as created while leaving the disposition unchanged", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    const paths = resolveTargetPaths(home);
    const claudeSkills = path.join(home, "claude-skills");
    const claudePrompts = path.join(home, "claude-prompts");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n    prompts: ${claudePrompts}\n`);

    await runInstall({ sourcePath: repo, home });
    await fs.rm(path.join(claudeSkills, "review"));

    const { outcome } = await runInstall({ sourcePath: repo, home });

    expect(outcome.outcome).toBe("complete");
    expect(outcome.exposureOutcome).toBe("complete");
    const skill = recordById(outcome, "skill:review");
    expect(skill.status).toBe("installed-different");
    expect(skill.disposition).toBe("unchanged");
    expect(skill.exposures).toContainEqual({
      targetName: "claude",
      path: path.join(claudeSkills, "review"),
      result: "created"
    });
    expect(await fs.readlink(path.join(claudeSkills, "review"))).toBe(path.join(paths.agentsSkillsDir, "review"));
  });

  it("reports not-configured exposure outcome with no config.yaml", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");

    const { outcome } = await runInstall({ sourcePath: repo, home });

    expect(outcome.outcome).toBe("complete");
    expect(outcome.exposureOutcome).toBe("not-configured");
    expect(outcome.artifacts.every((record) => record.exposures.length === 0)).toBe(true);
  });

  it("reports the codex-invocation-policy overlay as added for a generated file", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));

    const { outcome } = await runInstall({ sourcePath: repo, home });

    const restricted = recordById(outcome, "skill:restricted");
    expect(restricted.overlays).toEqual([
      { id: "codex-invocation-policy", version: 1, paths: ["agents/openai.yaml"], effect: "added" }
    ]);
    expect(restricted.files?.map((file) => file.path)).toContain("agents/openai.yaml");
    expect(restricted.content?.expectedHash).toBe(restricted.content?.installedHash);
  });

  it("reports the codex-invocation-policy overlay as modified for merged authored metadata", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    const skillPath = await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));
    await writeCodexMetadata(skillPath, "policy:\n  allow_implicit_invocation: true\n  requires_approval: always\n");

    const { outcome } = await runInstall({ sourcePath: repo, home });

    const restricted = recordById(outcome, "skill:restricted");
    expect(restricted.overlays).toEqual([
      { id: "codex-invocation-policy", version: 1, paths: ["agents/openai.yaml"], effect: "modified" }
    ]);
    expect(restricted.files?.map((file) => file.path)).toContain("agents/openai.yaml");
  });

  it("records state overlays equal to the report overlays", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));

    const { outcome } = await runInstall({ sourcePath: repo, home });

    const state = await loadState(resolveTargetPaths(home));
    for (const record of outcome.artifacts) {
      const entry = state.entries.find((candidate) => candidate.id === record.id);
      expect(entry?.overlays).toEqual(record.overlays);
    }
    expect(state.entries.find((entry) => entry.id === "prompt:commit-message")?.overlays).toEqual([]);
  });

  it("keeps exposure conflicts out of the base-store outcome under --allow-conflicts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    const paths = resolveTargetPaths(home);
    const claudeSkills = path.join(home, "claude-skills");
    const claudePrompts = path.join(home, "claude-prompts");
    await fs.mkdir(claudeSkills, { recursive: true });
    await fs.writeFile(path.join(claudeSkills, "review"), "user-owned\n", "utf8");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n    prompts: ${claudePrompts}\n`);

    const { outcome } = await runInstall({ sourcePath: repo, home, allowConflicts: true });

    expect(outcome.outcome).toBe("complete");
    expect(outcome.exposureOutcome).toBe("partial");
    const skill = recordById(outcome, "skill:review");
    expect(skill.disposition).toBe("installed");
    const conflict = skill.exposures.find((exposure) => exposure.targetName === "claude");
    expect(conflict).toMatchObject({ result: "conflict" });
    expect(typeof conflict?.reason).toBe("string");
  });

  it("aborts strict runs with structured exposure conflicts and not-attempted siblings", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    const paths = resolveTargetPaths(home);
    const claudeSkills = path.join(home, "claude-skills");
    await fs.mkdir(claudeSkills, { recursive: true });
    await fs.writeFile(path.join(claudeSkills, "review"), "user-owned\n", "utf8");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n`);

    const { outcome } = await runInstall({ sourcePath: repo, home });

    expect(outcome.outcome).toBe("aborted");
    expect(outcome.error?.code).toBe("conflict");
    const skill = recordById(outcome, "skill:review");
    expect(skill.disposition).toBe("conflict");
    expect(skill.exposures).toHaveLength(1);
    expect(skill.exposures[0]).toMatchObject({ targetName: "claude", result: "conflict" });
    expect(recordById(outcome, "prompt:commit-message").disposition).toBe("not-attempted");
  });

  it("reports unmatched selectors with every matched artifact not-attempted", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");

    const { outcome } = await runInstall({ sourcePath: repo, home, only: ["skill:review", "skill:missing"] });

    expect(outcome.outcome).toBe("aborted");
    expect(outcome.error?.code).toBe("unmatched-selector");
    expect(outcome.unmatchedSelectors).toEqual(["skill:missing"]);
    expect(recordById(outcome, "skill:review").disposition).toBe("not-attempted");
  });

  it("discloses installed, failed, and not-attempted artifacts around a mid-run failure", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    await writeSkill(repo, "extra", "# Extra\n");
    process.env.AGENT_INSTALLER_TEST_FAIL_WRITE = "skill:extra";

    const { outcome } = await runInstall({
      sourcePath: repo,
      home,
      only: ["skill:review", "skill:extra", "prompt:commit-message"]
    });

    expect(outcome.outcome).toBe("aborted");
    expect(recordById(outcome, "skill:review").disposition).toBe("installed");
    const failed = recordById(outcome, "skill:extra");
    expect(failed.disposition).toBe("failed");
    expect(failed.failure?.code).toBe("install-failed");
    expect(typeof failed.failure?.message).toBe("string");
    expect(recordById(outcome, "prompt:commit-message").disposition).toBe("not-attempted");
  });

  it("fails the artifact with verification-failed when the written copy does not verify", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    process.env.AGENT_INSTALLER_TEST_CORRUPT_WRITE = "skill:review";

    // Pinned order so the prompt is still unreached when the skill fails.
    const { outcome } = await runInstall({ sourcePath: repo, home, only: ["skill:review", "prompt:commit-message"] });

    expect(outcome.outcome).toBe("aborted");
    expect(outcome.error?.code).toBe("verification-failed");
    const failed = recordById(outcome, "skill:review");
    expect(failed.disposition).toBe("failed");
    expect(failed.failure?.code).toBe("verification-failed");
    expect(failed.content?.expectedHash).not.toBe(failed.content?.installedHash);
    expect(recordById(outcome, "prompt:commit-message").disposition).toBe("not-attempted");
  });

  it("maps an unreadable local source to source-unavailable without touching the base store", async () => {
    const home = await makeTempDir("agent-installer-v3-home-");
    const paths = resolveTargetPaths(home);
    const missing = path.join(await makeTempDir("agent-installer-v3-missing-"), "no-such-repo");

    // Source failures throw for the caller to classify; the CLI maps them to
    // an aborted v3 report with error.code source-unavailable.
    await expect(runInstall({ sourcePath: missing, home })).rejects.toMatchObject({
      name: "SourceUnavailableError"
    });
    await expect(runInstall({ sourcePath: missing, home })).rejects.toThrow(/Cannot read source repository/);
    await expect(fs.access(paths.stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(paths.agentsSkillsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports pruned artifacts separately with retained foreign exposures", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-v3-home-");
    const paths = resolveTargetPaths(home);
    const claudeSkills = path.join(home, "claude-skills");
    const claudePrompts = path.join(home, "claude-prompts");
    await writeConfigYaml(
      paths,
      `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n    prompts: ${claudePrompts}\n`
    );

    await runInstall({ sourcePath: repo, home });

    await fs.rm(path.join(repo, "prompts", "commit-message.md"));
    const exposurePath = path.join(claudePrompts, "commit-message.md");
    await fs.rm(exposurePath);
    await fs.writeFile(exposurePath, "not ours anymore\n", "utf8");

    const { outcome } = await runInstall({ sourcePath: repo, home, prune: true });

    expect(outcome.outcome).toBe("complete");
    expect(outcome.exposureOutcome).toBe("partial");
    expect(outcome.artifacts.map((record) => record.id)).toEqual(["skill:review"]);
    expect(outcome.pruned).toHaveLength(1);
    expect(outcome.pruned[0]).toMatchObject({
      id: "prompt:commit-message",
      storeRelativePath: "commit-message.md",
      requestedRef: null,
      resolvedCommit: null,
      removedExposures: [],
      retainedExposures: [{ path: exposurePath, targetName: "claude" }]
    });
    expect(outcome.pruned[0]?.basePath).toBe(path.join(paths.agentsPromptsDir, "commit-message.md"));
  });

  it("migrates v3 state to v4, lists installed-same, and records tree-v2 on the next install", async () => {
    const home = await makeTempDir("agent-installer-v3-home-");
    const paths = resolveTargetPaths(home);
    const commitA = "a".repeat(40);
    const populate = async (checkout: string): Promise<void> => {
      await fs.mkdir(path.join(checkout, "skills", "review"), { recursive: true });
      await fs.writeFile(path.join(checkout, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
      await fs.mkdir(path.join(checkout, "prompts"), { recursive: true });
      await fs.writeFile(path.join(checkout, "prompts", "commit-message.md"), "commit prompt\n", "utf8");
    };

    await runInstall({
      sourcePath: "https://github.com/org/repo.git",
      home,
      resolveOptions: { ref: "main", git: makeCheckoutGitRunner(commitA, populate) }
    });

    const written = JSON.parse(await fs.readFile(paths.stateFile, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    await fs.writeFile(
      paths.stateFile,
      JSON.stringify({ version: 3, entries: written.entries.map(({ hashAlgorithm: _a, overlays: _o, ...rest }) => rest) }),
      "utf8"
    );

    const migrated = await loadState(paths);
    expect(migrated.version).toBe(4);
    expect(migrated.entries.find((entry) => entry.id === "skill:review")).toMatchObject({
      hashAlgorithm: "agent-installer-tree-v1",
      overlays: null
    });
    expect(migrated.entries.find((entry) => entry.id === "prompt:commit-message")).toMatchObject({
      hashAlgorithm: "sha256",
      overlays: []
    });

    for (const entry of migrated.entries) {
      expect((await managedEntryToJson(entry)).status).toBe("installed-same");
    }

    const commitB = "b".repeat(40);
    const { outcome } = await runInstall({
      sourcePath: "https://github.com/org/repo.git",
      home,
      resolveOptions: { ref: "main", git: makeCheckoutGitRunner(commitB, populate) }
    });

    expect(outcome.outcome).toBe("complete");
    expect(outcome.artifacts.every((record) => record.disposition === "unchanged")).toBe(true);
    const refreshed = await loadState(paths);
    expect(refreshed.entries.find((entry) => entry.id === "skill:review")).toMatchObject({
      hashAlgorithm: "agent-installer-tree-v2",
      overlays: [],
      requestedRef: "main",
      resolvedCommit: commitB
    });
  });

  it("gives distinct trees distinct agent-installer-tree-v2 digests", async () => {
    const first = await makeTempDir("agent-installer-v3-tree-a-");
    await fs.writeFile(path.join(first, "a"), "Xb\n-\nY", "utf8");

    const second = await makeTempDir("agent-installer-v3-tree-b-");
    await fs.writeFile(path.join(second, "a"), "X", "utf8");
    await fs.writeFile(path.join(second, "b"), "Y", "utf8");

    const firstIdentity = await hashArtifactContent("skill", first);
    const secondIdentity = await hashArtifactContent("skill", second);
    expect(firstIdentity.algorithm).toBe("agent-installer-tree-v2");
    expect(secondIdentity.algorithm).toBe("agent-installer-tree-v2");
    expect(firstIdentity.digest).not.toBe(secondIdentity.digest);
  });
});
