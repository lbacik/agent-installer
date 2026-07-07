import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectArtifactStates, installArtifacts, removeArtifacts } from "../src/install.js";
import { resolveTargetPaths } from "../src/paths.js";
import { scanSourceRepository } from "../src/source.js";
import { loadState } from "../src/state.js";

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
