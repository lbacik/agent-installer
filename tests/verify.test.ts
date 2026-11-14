import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getMarkerPath, resolveTargetPaths } from "../src/paths.js";
import { VERIFY_NOTICE } from "../src/verify.js";
import type { VerifyOutcome } from "../src/types.js";

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
      // picocolors enables color when CI is set; keep human-output assertions ANSI-free.
      env: { ...process.env, HOME: home, NO_COLOR: "1", ...extraEnv }
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

function parseVerifyReport(stdout: string): VerifyOutcome {
  return JSON.parse(stdout) as VerifyOutcome;
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const repo = await makeTempDir("agent-installer-verify-repo-");
  await fs.mkdir(path.join(repo, "skills", "review"), { recursive: true });
  await fs.writeFile(path.join(repo, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
  await fs.mkdir(path.join(repo, "skills", "plan"), { recursive: true });
  await fs.writeFile(path.join(repo, "skills", "plan", "SKILL.md"), "# Plan\n", "utf8");
  await fs.mkdir(path.join(repo, "prompts"), { recursive: true });
  await fs.writeFile(path.join(repo, "prompts", "commit-message.md"), "commit prompt\n", "utf8");
  return repo;
}

async function installAll(repo: string, home: string): Promise<CliResult> {
  return runCli(["install", repo, "--all"], home);
}

/** Full recursive snapshot of the HOME tree: contents plus mtimes, so any write shows up. */
async function snapshotHome(home: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, dirent.name);
      const rel = path.relative(home, full);
      const stat = await fs.lstat(full);
      if (dirent.isSymbolicLink()) {
        entries.set(rel, `link:${await fs.readlink(full)}`);
      } else if (dirent.isDirectory()) {
        entries.set(rel, `dir:${stat.mtimeMs}`);
        await walk(full);
      } else if (dirent.isFile()) {
        const content = await fs.readFile(full);
        entries.set(rel, `file:${stat.mtimeMs}:${stat.mode}:${createHash("sha256").update(content).digest("hex")}`);
      } else {
        entries.set(rel, `other:${stat.mtimeMs}:${stat.mode}`);
      }
    }
  }

  await walk(home);
  return entries;
}

function expectHomeUnchanged(before: Map<string, string>, after: Map<string, string>): void {
  expect([...after.entries()]).toEqual([...before.entries()]);
}

async function runVerifyJson(home: string, args: string[]): Promise<{ result: CliResult; report: VerifyOutcome }> {
  const before = await snapshotHome(home);
  const result = await runCli(["verify", ...args, "--json"], home);
  expectHomeUnchanged(before, await snapshotHome(home));
  return { result, report: parseVerifyReport(result.stdout) };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("verify usage", () => {
  it("fails with a usage error and changes nothing when --only is missing", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    const before = await snapshotHome(home);
    const result = await runCli(["verify"], home);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--only/);
    expectHomeUnchanged(before, await snapshotHome(home));
  });

  it("collapses duplicate selectors and keeps first-appearance order", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    const { result, report } = await runVerifyJson(home, ["--only", "skill:plan", "--only", "skill:review", "--only", "skill:plan"]);
    expect(result.exitCode).toBe(0);
    expect(report.outcome).toBe("verified");
    expect(report.artifacts.map((artifact) => artifact.id)).toEqual(["skill:plan", "skill:review"]);
  });
});

describe("verify clean tree", () => {
  it("reports verified with recorded provenance, matching hashes, and a files inventory", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    const { result, report } = await runVerifyJson(home, ["--only", "skill:review"]);
    expect(result.exitCode).toBe(0);
    expect(report.schemaVersion).toBe(3);
    expect(report.kind).toBe("agent-installer.verify-report");
    expect(report.outcome).toBe("verified");
    expect(report.notice).toBe(VERIFY_NOTICE);

    expect(report.artifacts).toHaveLength(1);
    const record = report.artifacts[0]!;
    expect(record.id).toBe("skill:review");
    expect(record.kind).toBe("skill");
    expect(record.name).toBe("review");
    expect(record.verification).toBe("recorded-installation");
    expect(record.result).toBe("verified");
    expect(record.refusals).toEqual([]);
    expect(record.requestedRef).toBeNull();
    expect(record.resolvedCommit).toBeNull();
    expect(record.storeRelativePath).toBe("review");
    expect(record.basePath).toBe(path.join(home, ".agents", "skills", "review"));
    expect(record.overlays).toEqual([]);
    expect(record.content).toBeDefined();
    expect(record.content!.algorithm).toBe("agent-installer-tree-v2");
    expect(record.content!.installedHash).toBe(record.content!.expectedHash);

    const fresh = await fs.readFile(path.join(home, ".agents", "skills", "review", "SKILL.md"));
    expect(record.files).toEqual([
      {
        path: "SKILL.md",
        sha256: createHash("sha256").update(fresh).digest("hex"),
        executable: false
      }
    ]);
  });

  it("verifies a prompt with the sha256 algorithm", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    const { result, report } = await runVerifyJson(home, ["--only", "prompt:commit-message"]);
    expect(result.exitCode).toBe(0);
    const record = report.artifacts[0]!;
    expect(record.result).toBe("verified");
    expect(record.storeRelativePath).toBe("commit-message.md");
    expect(record.content!.algorithm).toBe("sha256");
    expect(record.files).toHaveLength(1);
  });

  it("succeeds without config.yaml and with a malformed config.yaml", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);
    const paths = resolveTargetPaths(home);

    await expect(fs.stat(paths.configFile)).rejects.toThrow();
    const clean = await runVerifyJson(home, ["--only", "skill:review"]);
    expect(clean.result.exitCode).toBe(0);
    expect(clean.report.outcome).toBe("verified");

    await fs.mkdir(paths.stateDir, { recursive: true });
    await fs.writeFile(paths.configFile, "{{{ not yaml at all", "utf8");
    const malformed = await runVerifyJson(home, ["--only", "skill:review"]);
    expect(malformed.result.exitCode).toBe(0);
    expect(malformed.report.outcome).toBe("verified");
  });

  it("succeeds after the source is gone, without spawning git", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    await fs.rm(repo, { recursive: true, force: true });
    const { result, report } = await runVerifyJson(home, ["--only", "skill:review", "--only", "prompt:commit-message"]);
    expect(result.exitCode).toBe(0);
    expect(report.outcome).toBe("verified");
  });

  it("ignores a tampered unselected artifact", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    await fs.appendFile(path.join(home, ".agents", "skills", "plan", "SKILL.md"), "tampered\n", "utf8");
    const { result, report } = await runVerifyJson(home, ["--only", "skill:review"]);
    expect(result.exitCode).toBe(0);
    expect(report.outcome).toBe("verified");
    expect(report.artifacts).toHaveLength(1);
    expect(report.artifacts[0]!.id).toBe("skill:review");
  });
});

describe("verify drift", () => {
  it.each([
    ["edit", async (base: string) => fs.appendFile(path.join(base, "SKILL.md"), "tampered\n", "utf8")],
    ["delete", async (base: string) => fs.rm(path.join(base, "SKILL.md"))],
    ["add", async (base: string) => fs.writeFile(path.join(base, "extra.txt"), "extra\n", "utf8")],
    ["executable-bit", async (base: string) => fs.chmod(path.join(base, "SKILL.md"), 0o755)]
  ])("refuses with modified after %s and repairs nothing", async (_label, tamper) => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    const base = path.join(home, ".agents", "skills", "review");
    await tamper(base);

    const { result, report } = await runVerifyJson(home, ["--only", "skill:review"]);
    expect(result.exitCode).toBe(1);
    expect(report.outcome).toBe("refused");
    const record = report.artifacts[0]!;
    expect(record.result).toBe("refused");
    expect(record.refusals.map((refusal) => refusal.code)).toContain("modified");
    // The tamper is still there: verify never repairs.
    const rerun = await runCli(["verify", "--only", "skill:review", "--json"], home);
    expect(rerun.exitCode).toBe(1);
    expect((parseVerifyReport(rerun.stdout).artifacts[0]!.refusals ?? []).map((r) => r.code)).toContain("modified");
    // Fresh hash is reported even on refused records.
    expect(record.content).toBeDefined();
    expect(record.files).toBeDefined();
  });

  it("reports invalid-content for a special file in the copy", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    const { execFile: execFileCb } = await import("node:child_process");
    const execFileP = promisify(execFileCb);
    await execFileP("mkfifo", [path.join(home, ".agents", "skills", "review", "pipe")]);
    const { result, report } = await runVerifyJson(home, ["--only", "skill:review"]);
    expect(result.exitCode).toBe(1);
    expect(report.artifacts[0]!.refusals.map((r) => r.code)).toContain("invalid-content");
  });

  it("reports missing when the base path is gone, with no content or files", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    await fs.rm(path.join(home, ".agents", "skills", "review"), { recursive: true, force: true });
    const { result, report } = await runVerifyJson(home, ["--only", "skill:review"]);
    expect(result.exitCode).toBe(1);
    const record = report.artifacts[0]!;
    expect(record.result).toBe("refused");
    expect(record.refusals.map((r) => r.code)).toEqual(["missing"]);
    expect(record.content).toBeUndefined();
    expect(record.files).toBeUndefined();
  });

  it("reports missing when the base path is the wrong file type", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    // A prompt copy must be a file: replace it with a directory.
    const promptBase = path.join(home, ".agents", "prompts", "commit-message.md");
    await fs.rm(promptBase);
    await fs.mkdir(promptBase, { recursive: true });
    const { report } = await runVerifyJson(home, ["--only", "prompt:commit-message"]);
    expect(report.artifacts[0]!.refusals.map((r) => r.code)).toEqual(["missing"]);
  });

  it.each(["remove", "rewrite"])("reports not-owned when the marker is %sed", async (mode) => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    const marker = getMarkerPath(path.join(home, ".agents", "skills", "review"), "skill");
    if (mode === "remove") {
      await fs.rm(marker);
    } else {
      await fs.writeFile(marker, JSON.stringify({ id: "skill:someone-else", installedAt: "x" }), "utf8");
    }

    const { result, report } = await runVerifyJson(home, ["--only", "skill:review"]);
    expect(result.exitCode).toBe(1);
    const record = report.artifacts[0]!;
    expect(record.refusals.map((r) => r.code)).toContain("not-owned");
    // The walk still succeeds, so content and files are reported.
    expect(record.content).toBeDefined();
    expect(record.files).toBeDefined();
  });

  it("reports invalid-content for an internal symlink", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    await fs.symlink(
      path.join(home, ".agents", "skills", "review", "SKILL.md"),
      path.join(home, ".agents", "skills", "review", "evil.md")
    );
    const { result, report } = await runVerifyJson(home, ["--only", "skill:review"]);
    expect(result.exitCode).toBe(1);
    const record = report.artifacts[0]!;
    expect(record.refusals.map((r) => r.code)).toContain("invalid-content");
    expect(record.content).toBeUndefined();
    expect(record.files).toBeUndefined();
  });
});

describe("verify record identity", () => {
  it("refuses unknown selectors as not-managed while verifying the rest", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    const { result, report } = await runVerifyJson(home, ["--only", "skill:nope", "--only", "skill:review"]);
    expect(result.exitCode).toBe(1);
    expect(report.outcome).toBe("refused");
    expect(report.artifacts).toHaveLength(2);
    expect(report.artifacts[0]!.result).toBe("refused");
    expect(report.artifacts[0]!.refusals.map((r) => r.code)).toEqual(["not-managed"]);
    expect(report.artifacts[1]!.result).toBe("verified");
  });

  it("refuses every selector as not-managed when state is missing", async () => {
    const home = await makeTempDir("agent-installer-verify-home-");

    const before = await snapshotHome(home);
    const result = await runCli(["verify", "--only", "skill:review", "--json"], home);
    expect(result.exitCode).toBe(1);
    const report = parseVerifyReport(result.stdout);
    expect(report.outcome).toBe("refused");
    expect(report.artifacts).toHaveLength(1);
    expect(report.artifacts[0]!.refusals.map((r) => r.code)).toEqual(["not-managed"]);
    expectHomeUnchanged(before, await snapshotHome(home));
  });
});

describe("verify provenance and record consistency", () => {
  async function installThenRewriteState(
    home: string,
    rewrite: (state: { version: number; entries: Array<Record<string, unknown>> }) => void
  ): Promise<void> {
    const paths = resolveTargetPaths(home);
    const raw = JSON.parse(await fs.readFile(paths.stateFile, "utf8")) as {
      version: number;
      entries: Array<Record<string, unknown>>;
    };
    rewrite(raw);
    await fs.writeFile(paths.stateFile, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  }

  it("reports each artifact's own resolved commit for one shared source", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    await installThenRewriteState(home, (state) => {
      for (const entry of state.entries) {
        entry["sourceRoot"] = "git+https://example.com/repo.git";
      }
      state.entries.find((e) => e["id"] === "skill:review")!["resolvedCommit"] = "a".repeat(40);
      state.entries.find((e) => e["id"] === "skill:plan")!["resolvedCommit"] = "b".repeat(40);
      state.entries.find((e) => e["id"] === "skill:review")!["requestedRef"] = "main";
    });

    const { result, report } = await runVerifyJson(home, ["--only", "skill:review", "--only", "skill:plan"]);
    expect(result.exitCode).toBe(0);
    expect(report.outcome).toBe("verified");
    expect(report.artifacts[0]!.resolvedCommit).toBe("a".repeat(40));
    expect(report.artifacts[0]!.requestedRef).toBe("main");
    expect(report.artifacts[1]!.resolvedCommit).toBe("b".repeat(40));
  });

  it("refuses provenance-missing for git entries without a commit, but verifies local entries with null", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    await installThenRewriteState(home, (state) => {
      state.entries.find((e) => e["id"] === "skill:review")!["sourceRoot"] = "git+https://example.com/repo.git";
    });

    const { result, report } = await runVerifyJson(home, ["--only", "skill:review", "--only", "skill:plan"]);
    expect(result.exitCode).toBe(1);
    expect(report.artifacts[0]!.refusals.map((r) => r.code)).toContain("provenance-missing");
    expect(report.artifacts[1]!.result).toBe("verified");
    expect(report.artifacts[1]!.resolvedCommit).toBeNull();
  });

  it("refuses unsupported-algorithm and inconsistent-record for pre-v4 entries without persisting the migration", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    const paths = resolveTargetPaths(home);
    const raw = JSON.parse(await fs.readFile(paths.stateFile, "utf8")) as {
      version: number;
      entries: Array<Record<string, unknown>>;
    };
    const v3 = {
      version: 3,
      entries: raw.entries.map((entry) => {
        const { hashAlgorithm: _hash, overlays: _overlays, ...rest } = entry;
        return rest;
      })
    };
    await fs.writeFile(paths.stateFile, `${JSON.stringify(v3, null, 2)}\n`, "utf8");

    const before = await snapshotHome(home);
    const result = await runCli(["verify", "--only", "skill:review", "--json"], home);
    expect(result.exitCode).toBe(1);
    const report = parseVerifyReport(result.stdout);
    const codes = report.artifacts[0]!.refusals.map((r) => r.code);
    expect(codes).toContain("unsupported-algorithm");
    expect(codes).toContain("inconsistent-record");
    // The v3 file is untouched: migration happened in memory only.
    expect(JSON.parse(await fs.readFile(paths.stateFile, "utf8")).version).toBe(3);
    expectHomeUnchanged(before, await snapshotHome(home));
  });

  it("refuses inconsistent-record when recorded hashes differ", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    await installThenRewriteState(home, (state) => {
      state.entries.find((e) => e["id"] === "skill:review")!["sourceHash"] = "0".repeat(64);
    });

    const { result, report } = await runVerifyJson(home, ["--only", "skill:review"]);
    expect(result.exitCode).toBe(1);
    expect(report.artifacts[0]!.refusals.map((r) => r.code)).toEqual(["inconsistent-record"]);
  });
});

describe("verify state errors", () => {
  it("reports state-unreadable for invalid JSON and unsupported versions", async () => {
    const home = await makeTempDir("agent-installer-verify-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(paths.stateDir, { recursive: true });

    for (const contents of [`{not json`, JSON.stringify({ version: 99, entries: [] })]) {
      await fs.writeFile(paths.stateFile, contents, "utf8");
      const before = await snapshotHome(home);
      const result = await runCli(["verify", "--only", "skill:review", "--json"], home);
      expect(result.exitCode).toBe(1);
      const report = parseVerifyReport(result.stdout);
      expect(report.outcome).toBe("error");
      expect(report.artifacts).toEqual([]);
      expect(report.error!.code).toBe("state-unreadable");
      expectHomeUnchanged(before, await snapshotHome(home));
    }
  });
});

describe("verify human output", () => {
  it("prints per-artifact verdicts and the recorded-provenance notice", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-verify-home-");
    expect((await installAll(repo, home)).exitCode).toBe(0);

    const before = await snapshotHome(home);
    const verified = await runCli(["verify", "--only", "skill:review"], home);
    expect(verified.exitCode).toBe(0);
    expect(verified.stdout).toMatch(/verified\s+skill:review/);
    expect(verified.stdout).toContain(VERIFY_NOTICE);
    expectHomeUnchanged(before, await snapshotHome(home));

    await fs.appendFile(path.join(home, ".agents", "skills", "review", "SKILL.md"), "tampered\n", "utf8");
    const refused = await runCli(["verify", "--only", "skill:review"], home);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toMatch(/refused\s+skill:review.*modified/);
    expect(refused.stdout).toContain(VERIFY_NOTICE);
  });
});
