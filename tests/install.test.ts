import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectArtifactStates, installAllFromSource, installArtifacts, removeArtifacts } from "../src/install.js";
import { resolveTargetPaths } from "../src/paths.js";
import { scanSourceRepository } from "../src/source.js";
import { loadState } from "../src/state.js";
import type { GitRunner } from "../src/source-resolver.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const repo = await makeTempDir("agent-installer-repo-");
  await fs.mkdir(path.join(repo, "skills", "review"), { recursive: true });
  await fs.writeFile(path.join(repo, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
  await fs.mkdir(path.join(repo, "prompts"), { recursive: true });
  await fs.writeFile(path.join(repo, "prompts", "commit-message.md"), "commit prompt\n", "utf8");
  return repo;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("install lifecycle", () => {
  it("installs canonical copies and Claude symlinks", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");

    const artifacts = await scanSourceRepository(repo);
    const { states } = await collectArtifactStates(artifacts, home);
    await installArtifacts(states, home);

    const paths = resolveTargetPaths(home);
    expect(await fs.readFile(path.join(paths.agentsSkillsDir, "review", "SKILL.md"), "utf8")).toContain("# Review");
    expect(await fs.readFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "utf8")).toContain("commit prompt");
    expect(await fs.readlink(path.join(paths.claudeSkillsDir, "review"))).toBe(path.join(paths.agentsSkillsDir, "review"));
    expect(await fs.readlink(path.join(paths.claudeCommandsDir, "commit-message.md"))).toBe(
      path.join(paths.agentsPromptsDir, "commit-message.md")
    );

    const state = await loadState(paths);
    expect(state.entries.map((entry) => entry.id)).toEqual(["prompt:commit-message", "skill:review"]);
  });

  it("classifies changed source artifacts as installed-different", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");

    const artifacts = await scanSourceRepository(repo);
    const initial = await collectArtifactStates(artifacts, home);
    await installArtifacts(initial.states, home);

    await fs.writeFile(path.join(repo, "prompts", "commit-message.md"), "updated prompt\n", "utf8");
    const rescanned = await scanSourceRepository(repo);
    const next = await collectArtifactStates(rescanned, home);

    expect(next.states.find((state) => state.id === "prompt:commit-message")?.status).toBe("installed-different");
    expect(next.states.find((state) => state.id === "skill:review")?.status).toBe("installed-same");
  });

  it("refuses unmanaged conflicts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(paths.agentsPromptsDir, { recursive: true });
    await fs.writeFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "user-owned\n", "utf8");

    const artifacts = await scanSourceRepository(repo);
    const { states } = await collectArtifactStates(artifacts, home);

    expect(states.find((state) => state.id === "prompt:commit-message")?.status).toBe("conflict");
  });

  it("reports managed artifacts missing from the current source repository", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");

    const artifacts = await scanSourceRepository(repo);
    const initial = await collectArtifactStates(artifacts, home);
    await installArtifacts(initial.states, home);

    await fs.rm(path.join(repo, "prompts", "commit-message.md"));
    const rescanned = await scanSourceRepository(repo);
    const next = await collectArtifactStates(rescanned, home, repo);

    expect(next.removed.map((entry) => entry.id)).toEqual(["prompt:commit-message"]);
  });

  it("does not report artifacts from other repositories as source-missing when the current scan is empty", async () => {
    const repoA = await makeRepo();
    const repoB = await makeTempDir("agent-installer-empty-repo-");
    const home = await makeTempDir("agent-installer-home-");

    const artifacts = await scanSourceRepository(repoA);
    const initial = await collectArtifactStates(artifacts, home, repoA);
    await installArtifacts(initial.states, home);

    const emptyScan = await scanSourceRepository(repoB);
    const next = await collectArtifactStates(emptyScan, home, repoB);

    expect(next.removed).toEqual([]);
  });

  it("scopes remote source-missing entries by remote source identity", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const sourceIdentity = "git+https://github.com/org/repo.git#ref=v1";

    const artifacts = (await scanSourceRepository(repo)).map((artifact) => ({ ...artifact, sourceRoot: sourceIdentity }));
    const initial = await collectArtifactStates(artifacts, home, sourceIdentity);
    await installArtifacts(initial.states, home);

    await fs.rm(path.join(repo, "prompts", "commit-message.md"));
    const rescanned = (await scanSourceRepository(repo)).map((artifact) => ({ ...artifact, sourceRoot: sourceIdentity }));
    const next = await collectArtifactStates(rescanned, home, sourceIdentity);

    expect(next.removed.map((entry) => entry.id)).toEqual(["prompt:commit-message"]);

    const otherSource = await collectArtifactStates([], home, "git+https://github.com/org/repo.git#ref=v2");
    expect(otherSource.removed).toEqual([]);
  });

  it("stores sanitized remote identities when installing remote artifacts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const sourceIdentity = "git+https://github.com/org/repo.git#ref=main";

    const artifacts = (await scanSourceRepository(repo)).map((artifact) => ({ ...artifact, sourceRoot: sourceIdentity }));
    const { states } = await collectArtifactStates(artifacts, home, sourceIdentity);
    await installArtifacts(states, home);

    const state = await loadState(resolveTargetPaths(home));
    expect(state.entries.every((entry) => entry.sourceRoot === sourceIdentity)).toBe(true);
  });

  it("installs remote artifacts through a temporary Git checkout", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const git: GitRunner = async (args) => {
      if (args[0] !== "clone") {
        return;
      }

      const checkout = args[4] ?? "";
      await fs.mkdir(path.join(checkout, "skills", "review"), { recursive: true });
      await fs.writeFile(path.join(checkout, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
      await fs.mkdir(path.join(checkout, "prompts"), { recursive: true });
      await fs.writeFile(path.join(checkout, "prompts", "commit-message.md"), "commit prompt\n", "utf8");
    };

    const states = await installAllFromSource(
      "https://token:secret@github.com/org/repo.git?access_token=abc",
      home,
      undefined,
      { ref: "main", git }
    );

    const paths = resolveTargetPaths(home);
    const state = await loadState(paths);
    expect(states.map((entry) => entry.id)).toEqual(["prompt:commit-message", "skill:review"]);
    expect(state.entries.map((entry) => entry.sourceRoot)).toEqual([
      "git+https://github.com/org/repo.git#ref=main",
      "git+https://github.com/org/repo.git#ref=main"
    ]);
    expect(await fs.readFile(path.join(paths.agentsSkillsDir, "review", "SKILL.md"), "utf8")).toContain("# Review");
  });

  it("removes only managed artifacts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");

    const artifacts = await scanSourceRepository(repo);
    const { states } = await collectArtifactStates(artifacts, home);
    await installArtifacts(states, home);

    const paths = resolveTargetPaths(home);
    await fs.mkdir(path.join(paths.agentsSkillsDir, "custom"), { recursive: true });
    await fs.writeFile(path.join(paths.agentsSkillsDir, "custom", "SKILL.md"), "# Custom\n", "utf8");

    await removeArtifacts(["prompt:commit-message"], home);

    await expect(fs.access(path.join(paths.agentsPromptsDir, "commit-message.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(paths.agentsSkillsDir, "custom", "SKILL.md"), "utf8")).toContain("# Custom");
  });
});
