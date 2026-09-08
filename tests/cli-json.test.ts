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
    expect(parsed.schemaVersion).toBe(1);
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
});

describe("list --json", () => {
  it("produces output non-interactively with no managed artifacts", async () => {
    const home = await makeTempDir("agent-installer-cli-home-");

    const result = await runCli(["list", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as { schemaVersion: number; artifacts: unknown[] };
    expect(parsed).toEqual({ schemaVersion: 1, artifacts: [] });
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

  it("reports installed-different for a managed entry whose Claude exposure symlink was removed", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-cli-home-");
    await runCli(["install", repo, "--all"], home);
    await fs.rm(path.join(home, ".claude", "skills", "review"), { recursive: true, force: true });

    const result = await runCli(["list", "--json"], home);

    expect(result.exitCode).toBe(0);
    const parsed = parseStdoutJson(result.stdout) as { artifacts: Array<{ id: string; status: string }> };
    const review = parsed.artifacts.find((artifact) => artifact.id === "skill:review");
    expect(review?.status).toBe("installed-different");
    const prompt = parsed.artifacts.find((artifact) => artifact.id === "prompt:commit-message");
    expect(prompt?.status).toBe("installed-same");
  });
});
