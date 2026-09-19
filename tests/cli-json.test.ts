import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

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

function parseStdoutJson(stdout: string): unknown {
  return JSON.parse(stdout);
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const repo = await makeTempDir("agent-installer-cli-repo-");
  await fs.mkdir(path.join(repo, "skills", "review"), { recursive: true });
  await fs.writeFile(path.join(repo, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
  await fs.mkdir(path.join(repo, "prompts"), { recursive: true });
  await fs.writeFile(path.join(repo, "prompts", "commit-message.md"), "commit prompt\n", "utf8");
  return repo;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("scan --json", () => {
  it("emits a single parseable object on stdout with nothing else", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");

    const result = await runCli(["scan", repo, "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as { schemaVersion: number; artifacts: Array<Record<string, unknown>> };
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.artifacts.map((artifact) => artifact.id).sort()).toEqual(["prompt:commit-message", "skill:review"]);
    expect(parsed.artifacts.every((artifact) => artifact.status === "new")).toBe(true);
  });

  it("includes source-missing entries", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");

    await runCli(["install", repo, "--all"], home);
    await fs.rm(path.join(repo, "prompts", "commit-message.md"));

    const result = await runCli(["scan", repo, "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as { artifacts: Array<{ id: string; status: string }> };
    const removed = parsed.artifacts.find((artifact) => artifact.id === "prompt:commit-message");
    expect(removed?.status).toBe("source-missing");
  });
});

describe("install --json", () => {
  it("distinguishes installed from updated artifacts by id", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");

    const first = await runCli(["install", repo, "--all", "--json"], home);
    expect(first.exitCode).toBe(0);
    const firstParsed = parseStdoutJson(first.stdout) as {
      installed: Array<{ id: string }>;
      updated: Array<{ id: string }>;
    };
    expect(firstParsed.installed.map((entry) => entry.id).sort()).toEqual(["prompt:commit-message", "skill:review"]);
    expect(firstParsed.updated).toEqual([]);

    await fs.writeFile(path.join(repo, "prompts", "commit-message.md"), "updated prompt\n", "utf8");

    const second = await runCli(["install", repo, "--all", "--json"], home);
    expect(second.exitCode).toBe(0);
    const secondParsed = parseStdoutJson(second.stdout) as {
      installed: Array<{ id: string }>;
      updated: Array<{ id: string }>;
    };
    expect(secondParsed.updated.map((entry) => entry.id)).toEqual(["prompt:commit-message"]);
    expect(secondParsed.installed).toEqual([]);
  });

  it("reports a strict-mode conflict abort as a parseable refusal with a non-zero exit", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    const promptsDir = path.join(home, ".agents", "prompts");
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.writeFile(path.join(promptsDir, "commit-message.md"), "user-owned\n", "utf8");

    const result = await runCli(["install", repo, "--all", "--json"], home);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseStdoutJson(result.stdout) as {
      installed: unknown[];
      updated: unknown[];
      skipped: unknown[];
      refused: Array<{ id: string }>;
      error?: string;
    };
    expect(parsed.installed).toEqual([]);
    expect(parsed.updated).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.refused.map((entry) => entry.id)).toEqual(["prompt:commit-message"]);
    expect(parsed.error).toMatch(/prompt:commit-message/);
  });

  it("reports skipped conflicts and installs the rest with --allow-conflicts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    const promptsDir = path.join(home, ".agents", "prompts");
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.writeFile(path.join(promptsDir, "commit-message.md"), "user-owned\n", "utf8");

    const result = await runCli(["install", repo, "--all", "--allow-conflicts", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as {
      installed: Array<{ id: string }>;
      skipped: Array<{ id: string }>;
      refused: unknown[];
    };
    expect(parsed.installed.map((entry) => entry.id)).toEqual(["skill:review"]);
    expect(parsed.skipped.map((entry) => entry.id)).toEqual(["prompt:commit-message"]);
    expect(parsed.refused).toEqual([]);
  });

  it("reports an unmatched --only selector as a parseable refusal", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");

    const result = await runCli(["install", repo, "--only", "skill:missing", "--json"], home);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseStdoutJson(result.stdout) as { error?: string; installed: unknown[] };
    expect(parsed.installed).toEqual([]);
    expect(parsed.error).toMatch(/skill:missing/);
  });

  it("reports pruned artifacts under their own category, distinct from installed and updated", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    await runCli(["install", repo, "--all"], home);

    await fs.rm(path.join(repo, "prompts", "commit-message.md"));
    const result = await runCli(["install", repo, "--all", "--prune", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as {
      installed: unknown[];
      updated: unknown[];
      pruned: Array<{ id: string }>;
    };
    expect(parsed.installed).toEqual([]);
    expect(parsed.updated).toEqual([]);
    expect(parsed.pruned.map((entry) => entry.id)).toEqual(["prompt:commit-message"]);
  });

  it("leaves source-missing artifacts installed and reports no pruned entries without --prune", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    await runCli(["install", repo, "--all"], home);

    await fs.rm(path.join(repo, "prompts", "commit-message.md"));
    const result = await runCli(["install", repo, "--all", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as { pruned: unknown[] };
    expect(parsed.pruned).toEqual([]);

    const list = await runCli(["list", "--json"], home);
    const listParsed = parseStdoutJson(list.stdout) as { artifacts: Array<{ id: string }> };
    expect(listParsed.artifacts.map((artifact) => artifact.id)).toContain("prompt:commit-message");
  });
});

describe("list --json", () => {
  it("produces output non-interactively with no managed artifacts", async () => {
    const home = await makeTempDir("agent-installer-cli-home-");

    const result = await runCli(["list", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as { schemaVersion: number; artifacts: unknown[] };
    expect(parsed).toEqual({ schemaVersion: 2, artifacts: [] });
  });

  it("lists managed entries non-interactively with no TTY attached", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    await runCli(["install", repo, "--all"], home);

    const result = await runCli(["list", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as { artifacts: Array<{ id: string; status: string }> };
    expect(parsed.artifacts.map((artifact) => artifact.id).sort()).toEqual(["prompt:commit-message", "skill:review"]);
    expect(parsed.artifacts.every((artifact) => artifact.status === "installed-same")).toBe(true);
  });

  it("reports installed-same for a freshly installed entry, which owns no exposure yet", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    await runCli(["install", repo, "--all"], home);

    const result = await runCli(["list", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as {
      schemaVersion: number;
      artifacts: Array<{ id: string; status: string; exposures: unknown[] }>;
    };
    expect(parsed.schemaVersion).toBe(2);
    const review = parsed.artifacts.find((artifact) => artifact.id === "skill:review");
    expect(review?.status).toBe("installed-same");
    expect(review?.exposures).toEqual([]);
    expect(review).not.toHaveProperty("exposurePath");
  });
});

describe("JSON report v2 exposures", () => {
  async function writeConfig(home: string, yaml: string): Promise<void> {
    const dir = path.join(home, ".agents", "agent-installer");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.yaml"), yaml, "utf8");
  }

  async function addLegacyExposure(home: string): Promise<string> {
    const legacyDir = path.join(home, ".claude", "skills");
    await fs.mkdir(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, "review");
    await fs.symlink(path.join(home, ".agents", "skills", "review"), legacyPath);

    const statePath = path.join(home, ".agents", "agent-installer", "state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      entries: Array<{ id: string; exposures: Array<{ path: string; targetName: string | null }> }>;
    };
    for (const entry of state.entries) {
      if (entry.id === "skill:review") {
        entry.exposures = [{ path: legacyPath, targetName: null }];
      }
    }
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    return legacyPath;
  }

  it("scan --json carries one exposures[] entry per configured target after install", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    const skillsDir = path.join(home, "claude-skills");
    const promptsDir = path.join(home, "claude-prompts");
    await writeConfig(home, `version: 1\ntargets:\n  claude:\n    skills: ${skillsDir}\n    prompts: ${promptsDir}\n`);
    await runCli(["install", repo, "--all"], home);

    const result = await runCli(["scan", repo, "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as {
      schemaVersion: number;
      artifacts: Array<{ id: string; status: string; exposures: Array<{ targetName: string; status: string }> }>;
    };
    expect(parsed.schemaVersion).toBe(2);
    const review = parsed.artifacts.find((artifact) => artifact.id === "skill:review");
    expect(review?.status).toBe("installed-same");
    expect(review?.exposures).toEqual([{ targetName: "claude", path: path.join(skillsDir, "review"), status: "installed-same" }]);
    const prompt = parsed.artifacts.find((artifact) => artifact.id === "prompt:commit-message");
    expect(prompt?.exposures).toEqual([
      { targetName: "claude", path: path.join(promptsDir, "commit-message.md"), status: "installed-same" }
    ]);
  });

  it("install --json emits schemaVersion 2 with exposures[] in place of exposurePath", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");

    const result = await runCli(["install", repo, "--all", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as {
      schemaVersion: number;
      installed: Array<{ id: string; exposures: unknown[] } & Record<string, unknown>>;
    };
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.installed.map((entry) => entry.id).sort()).toEqual(["prompt:commit-message", "skill:review"]);
    for (const entry of parsed.installed) {
      expect(entry).not.toHaveProperty("exposurePath");
      expect(entry.exposures).toEqual([]);
    }
  });

  it("scan --json surfaces a legacy notice pointing at config init", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    await runCli(["install", repo, "--all"], home);
    const legacyPath = await addLegacyExposure(home);

    const result = await runCli(["scan", repo, "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as {
      artifacts: Array<{ id: string; exposures: Array<{ targetName: string | null }> }>;
      notices?: string[];
    };
    const review = parsed.artifacts.find((artifact) => artifact.id === "skill:review");
    expect(review?.exposures).toEqual([{ targetName: null, path: legacyPath, status: "installed-same" }]);
    expect(parsed.notices?.join("\n")).toMatch(/config init/);
    expect(parsed.notices?.join("\n")).toMatch(/skill:review/);
  });

  it("scan human-readable output surfaces the same legacy notice", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    await runCli(["install", repo, "--all"], home);
    await addLegacyExposure(home);

    const result = await runCli(["scan", repo], home);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/config init/);
    expect(result.stdout).toMatch(/skill:review/);
  });

  it("list --json surfaces the same legacy notice", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    await runCli(["install", repo, "--all"], home);
    await addLegacyExposure(home);

    const result = await runCli(["list", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as { notices?: string[] };
    expect(parsed.notices?.join("\n")).toMatch(/config init/);
  });
});

describe("sync --json", () => {
  async function writeConfig(home: string, yaml: string): Promise<void> {
    const dir = path.join(home, ".agents", "agent-installer");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.yaml"), yaml, "utf8");
  }

  it("reports planned and applied creates with schemaVersion 2", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    await runCli(["install", repo, "--all"], home);

    const skillsDir = path.join(home, "claude-skills");
    const promptsDir = path.join(home, "claude-prompts");
    await writeConfig(home, `version: 1\ntargets:\n  claude:\n    skills: ${skillsDir}\n    prompts: ${promptsDir}\n`);

    const result = await runCli(["sync", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as {
      schemaVersion: number;
      planned: Array<{ id: string; action: string }>;
      applied: Array<{ id: string; action: string }>;
      skipped: unknown[];
    };
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.planned).toEqual(parsed.applied);
    expect(parsed.planned.map((action) => action.id).sort()).toEqual(["prompt:commit-message", "skill:review"]);
    expect(parsed.planned.every((action) => action.action === "create")).toBe(true);
    expect(parsed.skipped).toEqual([]);
  });

  it("reports an empty applied list under --dry-run", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    await runCli(["install", repo, "--all"], home);

    const skillsDir = path.join(home, "claude-skills");
    await writeConfig(home, `version: 1\ntargets:\n  claude:\n    skills: ${skillsDir}\n`);

    const result = await runCli(["sync", "--dry-run", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as {
      planned: Array<{ id: string }>;
      applied: unknown[];
    };
    expect(parsed.planned.map((action) => action.id)).toEqual(["skill:review"]);
    expect(parsed.applied).toEqual([]);
    await expect(fs.access(path.join(skillsDir, "review"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a conflict abort as a parseable error naming every conflicting pair", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    await runCli(["install", repo, "--all"], home);

    const skillsDir = path.join(home, "claude-skills");
    const promptsDir = path.join(home, "claude-prompts");
    await writeConfig(home, `version: 1\ntargets:\n  claude:\n    skills: ${skillsDir}\n    prompts: ${promptsDir}\n`);
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, "review"), "user-owned\n", "utf8");

    const refused = await runCli(["sync", "--json"], home);

    expect(refused.exitCode).not.toBe(0);
    const refusedParsed = parseStdoutJson(refused.stdout) as {
      planned: unknown[];
      applied: unknown[];
      skipped: Array<{ id: string; targetName: string }>;
      error?: string;
    };
    expect(refusedParsed.planned).toEqual([]);
    expect(refusedParsed.applied).toEqual([]);
    expect(refusedParsed.skipped).toEqual([
      expect.objectContaining({ id: "skill:review", targetName: "claude" })
    ]);
    expect(refusedParsed.error).toMatch(/skill:review/);

    const allowed = await runCli(["sync", "--allow-conflicts", "--json"], home);

    expect(allowed.exitCode).toBe(0);
    const allowedParsed = parseStdoutJson(allowed.stdout) as {
      planned: Array<{ id: string; action: string }>;
      skipped: Array<{ id: string }>;
    };
    expect(allowedParsed.planned.map((action) => action.id)).toEqual(["prompt:commit-message"]);
    expect(allowedParsed.skipped.map((entry) => entry.id)).toEqual(["skill:review"]);
    expect(await fs.readlink(path.join(promptsDir, "commit-message.md"))).toBe(
      path.join(home, ".agents", "prompts", "commit-message.md")
    );
  });
});
