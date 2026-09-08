import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { hashArtifact } from "../src/hash.js";
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

async function writeSkill(repo: string, name: string, content: string): Promise<string> {
  const skillPath = path.join(repo, "skills", name);
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, "SKILL.md"), content, "utf8");
  return skillPath;
}

function skillWithFrontmatter(body: string): string {
  return `---\n${body}\n---\n\n# Restricted\n`;
}

const CODEX_METADATA_PATH = path.join("agents", "openai.yaml");

async function readCodexDocument(skillBasePath: string): Promise<unknown> {
  return parseYaml(await fs.readFile(path.join(skillBasePath, CODEX_METADATA_PATH), "utf8"));
}

async function readCodexSource(skillBasePath: string): Promise<string> {
  return fs.readFile(path.join(skillBasePath, CODEX_METADATA_PATH), "utf8");
}

async function writeCodexMetadata(skillPath: string, content: string): Promise<void> {
  await fs.mkdir(path.join(skillPath, "agents"), { recursive: true });
  await fs.writeFile(path.join(skillPath, CODEX_METADATA_PATH), content, "utf8");
}

async function installAll(repo: string, home: string): Promise<void> {
  const artifacts = await scanSourceRepository(repo);
  const { states } = await collectArtifactStates(artifacts, home);
  await installArtifacts(
    states.filter((state) => state.status === "new" || state.status === "installed-different"),
    home
  );
}

async function statusOf(repo: string, home: string, id: string): Promise<string | undefined> {
  const artifacts = await scanSourceRepository(repo);
  const { states } = await collectArtifactStates(artifacts, home);
  return states.find((state) => state.id === id)?.status;
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
    const sourceIdentity = "git+https://github.com/org/repo-v1.git";

    const artifacts = (await scanSourceRepository(repo)).map((artifact) => ({ ...artifact, sourceRoot: sourceIdentity }));
    const initial = await collectArtifactStates(artifacts, home, sourceIdentity);
    await installArtifacts(initial.states, home);

    await fs.rm(path.join(repo, "prompts", "commit-message.md"));
    const rescanned = (await scanSourceRepository(repo)).map((artifact) => ({ ...artifact, sourceRoot: sourceIdentity }));
    const next = await collectArtifactStates(rescanned, home, sourceIdentity);

    expect(next.removed.map((entry) => entry.id)).toEqual(["prompt:commit-message"]);

    const otherSource = await collectArtifactStates([], home, "git+https://github.com/org/repo-v2.git");
    expect(otherSource.removed).toEqual([]);
  });

  it("stores sanitized remote identities when installing remote artifacts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const sourceIdentity = "git+https://github.com/org/repo.git";

    const artifacts = (await scanSourceRepository(repo)).map((artifact) => ({ ...artifact, sourceRoot: sourceIdentity }));
    const { states } = await collectArtifactStates(artifacts, home, sourceIdentity);
    await installArtifacts(states, home);

    const state = await loadState(resolveTargetPaths(home));
    expect(state.entries.every((entry) => entry.sourceRoot === sourceIdentity)).toBe(true);
  });

  it("installs remote artifacts through a temporary Git checkout", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const resolvedCommit = "a".repeat(40);
    const git = makeCheckoutGitRunner(resolvedCommit, async (checkout) => {
      await fs.mkdir(path.join(checkout, "skills", "review"), { recursive: true });
      await fs.writeFile(path.join(checkout, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
      await fs.mkdir(path.join(checkout, "prompts"), { recursive: true });
      await fs.writeFile(path.join(checkout, "prompts", "commit-message.md"), "commit prompt\n", "utf8");
    });

    const { states } = await installAllFromSource(
      "https://token:secret@github.com/org/repo.git?access_token=abc",
      home,
      undefined,
      { ref: "main", git }
    );

    const paths = resolveTargetPaths(home);
    const state = await loadState(paths);
    expect(states.map((entry) => entry.id)).toEqual(["prompt:commit-message", "skill:review"]);
    expect(state.entries.map((entry) => entry.sourceRoot)).toEqual([
      "git+https://github.com/org/repo.git",
      "git+https://github.com/org/repo.git"
    ]);
    expect(state.entries.map((entry) => entry.requestedRef)).toEqual(["main", "main"]);
    expect(state.entries.map((entry) => entry.resolvedCommit)).toEqual([resolvedCommit, resolvedCommit]);
    expect(await fs.readFile(path.join(paths.agentsSkillsDir, "review", "SKILL.md"), "utf8")).toContain("# Review");
  });

  it("records resolved commit provenance without a requested ref", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const resolvedCommit = "b".repeat(40);
    const git = makeCheckoutGitRunner(resolvedCommit, async (checkout) => {
      await fs.mkdir(path.join(checkout, "prompts"), { recursive: true });
      await fs.writeFile(path.join(checkout, "prompts", "commit-message.md"), "commit prompt\n", "utf8");
    });

    await installAllFromSource("https://github.com/org/repo.git", home, undefined, { git });

    const state = await loadState(resolveTargetPaths(home));
    expect(state.entries[0]?.requestedRef).toBeUndefined();
    expect(state.entries[0]?.resolvedCommit).toBe(resolvedCommit);
  });

  it("advances a pinned ref by reconciling as installed-different rather than conflict", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const commitA = "a".repeat(40);
    const gitA = makeCheckoutGitRunner(commitA, async (checkout) => {
      await fs.mkdir(path.join(checkout, "prompts"), { recursive: true });
      await fs.writeFile(path.join(checkout, "prompts", "commit-message.md"), "commit prompt v1\n", "utf8");
    });

    const first = await installAllFromSource("https://github.com/org/repo.git", home, undefined, { ref: "aaa", git: gitA });
    expect(first.conflicts).toEqual([]);
    expect(first.states.map((state) => state.id)).toEqual(["prompt:commit-message"]);

    const commitB = "b".repeat(40);
    const gitB = makeCheckoutGitRunner(commitB, async (checkout) => {
      await fs.mkdir(path.join(checkout, "prompts"), { recursive: true });
      await fs.writeFile(path.join(checkout, "prompts", "commit-message.md"), "commit prompt v2\n", "utf8");
    });

    const second = await installAllFromSource("https://github.com/org/repo.git", home, undefined, { ref: "bbb", git: gitB });
    expect(second.conflicts).toEqual([]);
    expect(second.states.find((state) => state.id === "prompt:commit-message")?.status).toBe("installed-different");

    const state = await loadState(resolveTargetPaths(home));
    const entry = state.entries.find((candidate) => candidate.id === "prompt:commit-message");
    expect(entry?.requestedRef).toBe("bbb");
    expect(entry?.resolvedCommit).toBe(commitB);

    const paths = resolveTargetPaths(home);
    expect(await fs.readFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "utf8")).toBe("commit prompt v2\n");
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

describe("install --all conflict handling", () => {
  it("aborts and installs nothing when every artifact conflicts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(path.join(paths.agentsSkillsDir, "review"), { recursive: true });
    await fs.writeFile(path.join(paths.agentsSkillsDir, "review", "SKILL.md"), "user-owned\n", "utf8");
    await fs.mkdir(paths.agentsPromptsDir, { recursive: true });
    await fs.writeFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "user-owned\n", "utf8");

    await expect(installAllFromSource(repo, home)).rejects.toThrow(/skill:review/);
    await expect(installAllFromSource(repo, home)).rejects.toThrow(/prompt:commit-message/);

    const state = await loadState(paths);
    expect(state.entries).toEqual([]);
    expect(await fs.readFile(path.join(paths.agentsSkillsDir, "review", "SKILL.md"), "utf8")).toBe("user-owned\n");
    expect(await fs.readFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "utf8")).toBe("user-owned\n");
  });

  it("aborts without installing the eligible artifact when only one artifact conflicts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(paths.agentsPromptsDir, { recursive: true });
    await fs.writeFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "user-owned\n", "utf8");

    await expect(installAllFromSource(repo, home)).rejects.toThrow(/prompt:commit-message/);

    const state = await loadState(paths);
    expect(state.entries).toEqual([]);
    await expect(fs.access(path.join(paths.agentsSkillsDir, "review"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs the eligible artifacts and reports the skipped conflict with allowConflicts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(paths.agentsPromptsDir, { recursive: true });
    await fs.writeFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "user-owned\n", "utf8");

    const { installed, conflicts } = await installAllFromSource(repo, home, undefined, undefined, { allowConflicts: true });

    expect(installed.map((entry) => entry.id)).toEqual(["skill:review"]);
    expect(conflicts.map((state) => state.id)).toEqual(["prompt:commit-message"]);

    const state = await loadState(paths);
    expect(state.entries.map((entry) => entry.id)).toEqual(["skill:review"]);
    expect(await fs.readFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "utf8")).toBe("user-owned\n");
  });

  it("names the exposure path, not the (nonexistent) base path, when only the Claude symlink conflicts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    const foreignTarget = await makeTempDir("agent-installer-foreign-");
    await fs.mkdir(paths.claudeSkillsDir, { recursive: true });
    await fs.symlink(foreignTarget, path.join(paths.claudeSkillsDir, "review"));

    await expect(installAllFromSource(repo, home)).rejects.toThrow(path.join(paths.claudeSkillsDir, "review"));

    const state = await loadState(paths);
    expect(state.entries).toEqual([]);
    await expect(fs.access(path.join(paths.agentsSkillsDir, "review"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the exposure path when an already-managed artifact's Claude symlink is replaced by something else", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);

    await installAllFromSource(repo, home);

    const foreignTarget = await makeTempDir("agent-installer-foreign-");
    await fs.rm(path.join(paths.claudeSkillsDir, "review"), { recursive: true, force: true });
    await fs.symlink(foreignTarget, path.join(paths.claudeSkillsDir, "review"));

    await expect(installAllFromSource(repo, home)).rejects.toThrow(path.join(paths.claudeSkillsDir, "review"));
  });
});

describe("install --only selection", () => {
  it("installs exactly the selected artifacts and leaves others uninstalled", async () => {
    const repo = await makeRepo();
    await writeSkill(repo, "extra", "# Extra\n");
    const home = await makeTempDir("agent-installer-home-");

    const { installed, conflicts } = await installAllFromSource(repo, home, undefined, undefined, {
      only: ["skill:review", "prompt:commit-message"]
    });

    expect(conflicts).toEqual([]);
    expect(installed.map((entry) => entry.id).sort()).toEqual(["prompt:commit-message", "skill:review"]);

    const state = await loadState(resolveTargetPaths(home));
    expect(state.entries.map((entry) => entry.id).sort()).toEqual(["prompt:commit-message", "skill:review"]);
    expect(await statusOf(repo, home, "skill:extra")).toBe("new");
  });

  it("installs a repeated selector once", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");

    const { installed } = await installAllFromSource(repo, home, undefined, undefined, {
      only: ["skill:review", "skill:review"]
    });

    expect(installed.map((entry) => entry.id)).toEqual(["skill:review"]);
  });

  it("exits without installing anything when a selector matches no discovered artifact", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");

    await expect(
      installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review", "skill:missing"] })
    ).rejects.toThrow(/skill:missing/);

    const state = await loadState(resolveTargetPaths(home));
    expect(state.entries).toEqual([]);
  });

  it("aborts on a selected conflicting artifact under default strict behaviour", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(paths.agentsPromptsDir, { recursive: true });
    await fs.writeFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "user-owned\n", "utf8");

    await expect(
      installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review", "prompt:commit-message"] })
    ).rejects.toThrow(/prompt:commit-message/);

    const state = await loadState(paths);
    expect(state.entries).toEqual([]);
  });

  it("skips a selected conflicting artifact and installs the rest with allowConflicts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(paths.agentsPromptsDir, { recursive: true });
    await fs.writeFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "user-owned\n", "utf8");

    const { installed, conflicts } = await installAllFromSource(repo, home, undefined, undefined, {
      only: ["skill:review", "prompt:commit-message"],
      allowConflicts: true
    });

    expect(installed.map((entry) => entry.id)).toEqual(["skill:review"]);
    expect(conflicts.map((state) => state.id)).toEqual(["prompt:commit-message"]);
  });
});

describe("install --prune", () => {
  it("leaves source-missing artifacts installed when --prune is not passed", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    await fs.rm(path.join(repo, "prompts", "commit-message.md"));
    const { pruned } = await installAllFromSource(repo, home, undefined, undefined, {});

    expect(pruned).toEqual([]);
    const state = await loadState(paths);
    expect(state.entries.map((entry) => entry.id)).toContain("prompt:commit-message");
    expect(await fs.readFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "utf8")).toContain("commit prompt");
    expect(await fs.readlink(path.join(paths.claudeCommandsDir, "commit-message.md"))).toBe(
      path.join(paths.agentsPromptsDir, "commit-message.md")
    );
  });

  it("removes the base store copy, exposure symlink and state entry for source-missing artifacts with --prune", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    await fs.rm(path.join(repo, "prompts", "commit-message.md"));
    const { pruned } = await installAllFromSource(repo, home, undefined, undefined, { prune: true });

    expect(pruned.map((entry) => entry.id)).toEqual(["prompt:commit-message"]);

    const state = await loadState(paths);
    expect(state.entries.map((entry) => entry.id)).toEqual(["skill:review"]);
    await expect(fs.access(path.join(paths.agentsPromptsDir, "commit-message.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(fs.access(path.join(paths.claudeCommandsDir, "commit-message.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("never prunes artifacts owned by a different source identity, even when the scanned source shares their names", async () => {
    const repoA = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    await installAllFromSource(repoA, home);

    // repoB is a distinct source identity that happens to declare the exact same artifact
    // names ("review", "commit-message") already owned by repoA. Installing from it reconciles
    // those names as conflicts (owned by another source), not source-missing, so --prune must
    // leave repoA's entries untouched.
    const repoB = await makeRepo();
    const { pruned } = await installAllFromSource(repoB, home, undefined, undefined, {
      allowConflicts: true,
      prune: true
    });

    expect(pruned).toEqual([]);

    const paths = resolveTargetPaths(home);
    const state = await loadState(paths);
    const ownerOfRepoA = await fs.realpath(repoA);
    expect(state.entries.map((entry) => entry.id).sort()).toEqual(["prompt:commit-message", "skill:review"]);
    expect(state.entries.every((entry) => entry.sourceRoot === ownerOfRepoA)).toBe(true);
    expect(await fs.readFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "utf8")).toContain("commit prompt");
  });

  it("does not prune previously installed artifacts when --ref advances", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const commitA = "a".repeat(40);
    const gitA = makeCheckoutGitRunner(commitA, async (checkout) => {
      await fs.mkdir(path.join(checkout, "prompts"), { recursive: true });
      await fs.writeFile(path.join(checkout, "prompts", "commit-message.md"), "commit prompt v1\n", "utf8");
      await fs.mkdir(path.join(checkout, "skills", "review"), { recursive: true });
      await fs.writeFile(path.join(checkout, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    });
    await installAllFromSource("https://github.com/org/repo.git", home, undefined, { ref: "aaa", git: gitA });

    const commitB = "b".repeat(40);
    const gitB = makeCheckoutGitRunner(commitB, async (checkout) => {
      await fs.mkdir(path.join(checkout, "prompts"), { recursive: true });
      await fs.writeFile(path.join(checkout, "prompts", "commit-message.md"), "commit prompt v2\n", "utf8");
      await fs.mkdir(path.join(checkout, "skills", "review"), { recursive: true });
      await fs.writeFile(path.join(checkout, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    });
    const { pruned } = await installAllFromSource("https://github.com/org/repo.git", home, undefined, {
      ref: "bbb",
      git: gitB
    }, { prune: true });

    expect(pruned).toEqual([]);
    const state = await loadState(resolveTargetPaths(home));
    expect(state.entries.map((entry) => entry.id).sort()).toEqual(["prompt:commit-message", "skill:review"]);
  });

  it("prunes only what the scanned source no longer offers, leaving merely-unselected artifacts alone", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    await installAllFromSource(repo, home);

    await writeSkill(repo, "extra", "# Extra\n");
    await fs.rm(path.join(repo, "prompts", "commit-message.md"));
    const { pruned, installed } = await installAllFromSource(repo, home, undefined, undefined, {
      only: ["skill:extra"],
      prune: true
    });

    expect(pruned.map((entry) => entry.id)).toEqual(["prompt:commit-message"]);
    expect(installed.map((entry) => entry.id)).toEqual(["skill:extra"]);

    const paths = resolveTargetPaths(home);
    const state = await loadState(paths);
    expect(state.entries.map((entry) => entry.id).sort()).toEqual(["skill:extra", "skill:review"]);
    await expect(fs.access(path.join(paths.agentsPromptsDir, "commit-message.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

describe("exposure symlink drift", () => {
  it("reports new for artifacts that have never been installed", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");

    expect(await statusOf(repo, home, "skill:review")).toBe("new");
    expect(await statusOf(repo, home, "prompt:commit-message")).toBe("new");
  });

  it("reports installed-different when the skill exposure symlink is deleted", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    await fs.rm(path.join(paths.claudeSkillsDir, "review"), { recursive: true, force: true });

    expect(await statusOf(repo, home, "skill:review")).toBe("installed-different");
  });

  it("reports installed-different when the prompt exposure symlink is deleted", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    await fs.rm(path.join(paths.claudeCommandsDir, "commit-message.md"), { recursive: true, force: true });

    expect(await statusOf(repo, home, "prompt:commit-message")).toBe("installed-different");
  });

  it("recreates the deleted skill exposure symlink on install --all and returns to installed-same", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);
    await fs.rm(path.join(paths.claudeSkillsDir, "review"), { recursive: true, force: true });

    await installAllFromSource(repo, home);

    expect(await fs.readlink(path.join(paths.claudeSkillsDir, "review"))).toBe(path.join(paths.agentsSkillsDir, "review"));
    expect(await statusOf(repo, home, "skill:review")).toBe("installed-same");
  });

  it("recreates the deleted prompt exposure symlink on install --all and returns to installed-same", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);
    await fs.rm(path.join(paths.claudeCommandsDir, "commit-message.md"), { recursive: true, force: true });

    await installAllFromSource(repo, home);

    expect(await fs.readlink(path.join(paths.claudeCommandsDir, "commit-message.md"))).toBe(
      path.join(paths.agentsPromptsDir, "commit-message.md")
    );
    expect(await statusOf(repo, home, "prompt:commit-message")).toBe("installed-same");
  });

  it("still reports conflict when the skill exposure path is replaced by a regular file", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    await fs.rm(path.join(paths.claudeSkillsDir, "review"), { recursive: true, force: true });
    await fs.writeFile(path.join(paths.claudeSkillsDir, "review"), "user-owned\n", "utf8");

    expect(await statusOf(repo, home, "skill:review")).toBe("conflict");
    expect(await fs.readFile(path.join(paths.claudeSkillsDir, "review"), "utf8")).toBe("user-owned\n");
  });

  it("still reports conflict when the prompt exposure path is replaced by a symlink to a foreign target", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    const foreignTarget = await makeTempDir("agent-installer-foreign-");
    await fs.rm(path.join(paths.claudeCommandsDir, "commit-message.md"), { recursive: true, force: true });
    await fs.symlink(foreignTarget, path.join(paths.claudeCommandsDir, "commit-message.md"));

    expect(await statusOf(repo, home, "prompt:commit-message")).toBe("conflict");
    expect(await fs.readlink(path.join(paths.claudeCommandsDir, "commit-message.md"))).toBe(foreignTarget);
  });

  it("still reports conflict when the skill exposure path is replaced by a symlink to a foreign target", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    const foreignTarget = await makeTempDir("agent-installer-foreign-");
    await fs.rm(path.join(paths.claudeSkillsDir, "review"), { recursive: true, force: true });
    await fs.symlink(foreignTarget, path.join(paths.claudeSkillsDir, "review"));

    expect(await statusOf(repo, home, "skill:review")).toBe("conflict");
    expect(await fs.readlink(path.join(paths.claudeSkillsDir, "review"))).toBe(foreignTarget);
  });

  it("still reports conflict when the prompt exposure path is replaced by a regular file", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    await fs.rm(path.join(paths.claudeCommandsDir, "commit-message.md"), { recursive: true, force: true });
    await fs.writeFile(path.join(paths.claudeCommandsDir, "commit-message.md"), "user-owned\n", "utf8");

    expect(await statusOf(repo, home, "prompt:commit-message")).toBe("conflict");
    expect(await fs.readFile(path.join(paths.claudeCommandsDir, "commit-message.md"), "utf8")).toBe("user-owned\n");
  });
});

describe("codex invocation policy translation", () => {
  it("materializes the Codex policy for a Claude-disabled skill and keeps it installed-same", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    await writeSkill(repo, "restricted", skillWithFrontmatter("name: restricted\ndisable-model-invocation: true"));

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    const skillBasePath = path.join(paths.agentsSkillsDir, "restricted");
    expect(await readCodexDocument(skillBasePath)).toEqual({ policy: { allow_implicit_invocation: false } });
    expect(await statusOf(repo, home, "skill:restricted")).toBe("installed-same");
  });

  it("never writes generated metadata into the source repository", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));

    await installAll(repo, home);

    await expect(fs.access(path.join(skillPath, CODEX_METADATA_PATH))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("translates only a literal boolean true", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    await writeSkill(repo, "quoted", skillWithFrontmatter('disable-model-invocation: "true"'));
    await writeSkill(repo, "numeric", skillWithFrontmatter("disable-model-invocation: 1"));
    await writeSkill(repo, "worded", skillWithFrontmatter("disable-model-invocation: yes"));
    await writeSkill(repo, "disabled", skillWithFrontmatter("disable-model-invocation: false"));
    await writeSkill(repo, "nested", skillWithFrontmatter("metadata:\n  disable-model-invocation: true"));

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    for (const name of ["quoted", "numeric", "worded", "disabled", "nested"]) {
      await expect(
        fs.access(path.join(paths.agentsSkillsDir, name, CODEX_METADATA_PATH))
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await statusOf(repo, home, `skill:${name}`)).toBe("installed-same");
    }
  });

  it("does not newly validate skills that do not enable the translation", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    await writeSkill(repo, "malformed", "---\nname: [unclosed\n: : :\n---\n\n# Malformed\n");
    await writeSkill(repo, "no-frontmatter", "# Plain\n");

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    expect(await fs.readFile(path.join(paths.agentsSkillsDir, "malformed", "SKILL.md"), "utf8")).toContain("unclosed");
    expect(await statusOf(repo, home, "skill:malformed")).toBe("installed-same");
    expect(await statusOf(repo, home, "skill:no-frontmatter")).toBe("installed-same");
  });

  it.each([
    ["a false setting", skillWithFrontmatter("disable-model-invocation: false")],
    ["no setting at all", skillWithFrontmatter("name: restricted")]
  ])("removes generated-only metadata when the source declares %s", async (_label, updatedSkill) => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));

    await installAll(repo, home);
    await fs.writeFile(path.join(skillPath, "SKILL.md"), updatedSkill, "utf8");

    expect(await statusOf(repo, home, "skill:restricted")).toBe("installed-different");

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    await expect(
      fs.access(path.join(paths.agentsSkillsDir, "restricted", CODEX_METADATA_PATH))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await statusOf(repo, home, "skill:restricted")).toBe("installed-same");
  });

  it("removes generated metadata together with the managed skill directory", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));

    await installAll(repo, home);
    await removeArtifacts(["skill:restricted"], home);

    const paths = resolveTargetPaths(home);
    await expect(fs.access(path.join(paths.agentsSkillsDir, "restricted"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(paths.claudeSkillsDir, "restricted"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies the same translation to install-all and remote sources", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const git: GitRunner = async (args) => {
      if (args[0] !== "clone") {
        return "";
      }

      const checkout = args[4] ?? "";
      await fs.mkdir(path.join(checkout, "skills", "restricted"), { recursive: true });
      await fs.writeFile(
        path.join(checkout, "skills", "restricted", "SKILL.md"),
        skillWithFrontmatter("disable-model-invocation: true"),
        "utf8"
      );
      return "";
    };

    const { states } = await installAllFromSource("https://github.com/org/repo.git", home, undefined, { ref: "main", git });

    const paths = resolveTargetPaths(home);
    expect(states.map((state) => state.id)).toEqual(["skill:restricted"]);
    expect(await readCodexDocument(path.join(paths.agentsSkillsDir, "restricted"))).toEqual({
      policy: { allow_implicit_invocation: false }
    });

    const state = await loadState(paths);
    expect(state.entries[0]?.sourceHash).toBe(state.entries[0]?.installedHash);
  });

  it("leaves ordinary skills and prompts untouched", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    await expect(fs.access(path.join(paths.agentsSkillsDir, "review", "agents"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await fs.readFile(path.join(paths.agentsPromptsDir, "commit-message.md"), "utf8")).toBe("commit prompt\n");
    expect(await statusOf(repo, home, "skill:review")).toBe("installed-same");
    expect(await statusOf(repo, home, "prompt:commit-message")).toBe("installed-same");
  });
});

describe("authored codex metadata", () => {
  it("retains authored interface and dependency metadata while enforcing the policy", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));
    await writeCodexMetadata(
      skillPath,
      "interface:\n  arguments:\n    - name: path\ndependencies:\n  - jq\n"
    );

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    const skillBasePath = path.join(paths.agentsSkillsDir, "restricted");
    expect(await readCodexDocument(skillBasePath)).toEqual({
      interface: { arguments: [{ name: "path" }] },
      dependencies: ["jq"],
      policy: { allow_implicit_invocation: false }
    });
    expect(await statusOf(repo, home, "skill:restricted")).toBe("installed-same");
  });

  it("gives the Claude setting precedence over a conflicting authored policy", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));
    await writeCodexMetadata(
      skillPath,
      "policy:\n  allow_implicit_invocation: true\n  requires_approval: always\n"
    );

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    expect(await readCodexDocument(path.join(paths.agentsSkillsDir, "restricted"))).toEqual({
      policy: { allow_implicit_invocation: false, requires_approval: "always" }
    });
    expect(await fs.readFile(path.join(skillPath, CODEX_METADATA_PATH), "utf8")).toContain(
      "allow_implicit_invocation: true"
    );
    expect(await statusOf(repo, home, "skill:restricted")).toBe("installed-same");
  });

  it("keeps an already compatible authored policy stable across install and rescan", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));
    await writeCodexMetadata(skillPath, "policy:\n  allow_implicit_invocation: false\n");

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    const skillBasePath = path.join(paths.agentsSkillsDir, "restricted");
    const installedMetadata = await readCodexSource(skillBasePath);
    expect(await statusOf(repo, home, "skill:restricted")).toBe("installed-same");

    await installAll(repo, home);

    expect(await readCodexSource(skillBasePath)).toBe(installedMetadata);
    expect(await readCodexDocument(skillBasePath)).toEqual({ policy: { allow_implicit_invocation: false } });
    expect(await statusOf(repo, home, "skill:restricted")).toBe("installed-same");
  });

  it.each([
    ["an empty policy key", "dependencies:\n  - jq\npolicy:\n"],
    ["an explicitly null policy", "policy: null\n"]
  ])("fills in %s instead of failing", async (_label, metadata) => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));
    await writeCodexMetadata(skillPath, metadata);

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    const skillBasePath = path.join(paths.agentsSkillsDir, "restricted");
    expect(await readCodexDocument(skillBasePath)).toMatchObject({ policy: { allow_implicit_invocation: false } });
    expect(await statusOf(repo, home, "skill:restricted")).toBe("installed-same");
  });

  it("keeps authored long values unfolded", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));
    const description = "word ".repeat(40).trim();
    await writeCodexMetadata(skillPath, `description: ${description}\n`);

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    const skillBasePath = path.join(paths.agentsSkillsDir, "restricted");
    expect(await readCodexSource(skillBasePath)).toContain(`description: ${description}\n`);
    expect(await readCodexDocument(skillBasePath)).toMatchObject({ description });
  });

  it.each([
    ["unparsable YAML", "policy: [unclosed\n: : :\n"],
    ["a non-mapping document", "just-a-string\n"],
    ["a non-mapping policy value", "policy: nope\n"]
  ])("fails before touching the managed copy when authored metadata is %s", async (_label, metadata) => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));
    await writeCodexMetadata(skillPath, metadata);

    await expect(installAll(repo, home)).rejects.toThrow(/agents[\\/]openai\.yaml/);
    await expect(installAll(repo, home)).rejects.toThrow(/disable-model-invocation/);

    const paths = resolveTargetPaths(home);
    await expect(fs.access(path.join(paths.agentsSkillsDir, "restricted"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(paths.claudeSkillsDir, "restricted"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await loadState(paths)).entries.map((entry) => entry.id)).not.toContain("skill:restricted");
  });

  it("leaves an already managed copy unchanged when the source metadata becomes malformed", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "restricted", skillWithFrontmatter("disable-model-invocation: true"));
    await writeCodexMetadata(skillPath, "dependencies:\n  - jq\n");

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    const skillBasePath = path.join(paths.agentsSkillsDir, "restricted");
    const installedMetadata = await readCodexSource(skillBasePath);

    await writeCodexMetadata(skillPath, "policy: [unclosed\n: : :\n");

    await expect(installAll(repo, home)).rejects.toThrow(/openai\.yaml/);
    expect(await readCodexSource(skillBasePath)).toBe(installedMetadata);
  });

  it("does not validate authored metadata when the Claude setting does not translate", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const broken = "policy: [unclosed\n: : :\n";
    const permissive = await writeSkill(repo, "permissive", skillWithFrontmatter("disable-model-invocation: false"));
    await writeCodexMetadata(permissive, broken);
    const plain = await writeSkill(repo, "plain", "# Plain\n");
    await writeCodexMetadata(plain, "policy:\n  allow_implicit_invocation: true\n");

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    expect(await readCodexSource(path.join(paths.agentsSkillsDir, "permissive"))).toBe(broken);
    expect(await readCodexDocument(path.join(paths.agentsSkillsDir, "plain"))).toEqual({
      policy: { allow_implicit_invocation: true }
    });
    expect(await statusOf(repo, home, "skill:permissive")).toBe("installed-same");
    expect(await statusOf(repo, home, "skill:plain")).toBe("installed-same");
  });
});

describe("content hashing", () => {
  async function writeExecutableScript(skillPath: string, relativePath: string, mode = 0o755): Promise<string> {
    const scriptPath = path.join(skillPath, relativePath);
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, "#!/bin/sh\necho hi\n", "utf8");
    await fs.chmod(scriptPath, mode);
    return scriptPath;
  }

  it("preserves the executable bit when installing a skill script", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "runnable", "# Runnable\n");
    await writeExecutableScript(skillPath, "scripts/run.sh");

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    const installedMode = (await fs.stat(path.join(paths.agentsSkillsDir, "runnable", "scripts", "run.sh"))).mode & 0o777;
    expect(installedMode).toBe(0o755);
  });

  it("reconciles installed-different when the installed script loses its executable bit, and reinstalling restores it", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "runnable", "# Runnable\n");
    await writeExecutableScript(skillPath, "scripts/run.sh");
    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    const installedScriptPath = path.join(paths.agentsSkillsDir, "runnable", "scripts", "run.sh");
    await fs.chmod(installedScriptPath, 0o644);

    expect(await statusOf(repo, home, "skill:runnable")).toBe("installed-different");

    await installAll(repo, home);

    expect((await fs.stat(installedScriptPath)).mode & 0o777).toBe(0o755);
    expect(await statusOf(repo, home, "skill:runnable")).toBe("installed-same");
  });

  it("aborts scan and install with an error naming the relative path when a skill directory contains a symlink", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    const skillPath = await writeSkill(repo, "linked", "# Linked\n");
    await fs.writeFile(path.join(skillPath, "target.txt"), "content\n", "utf8");
    await fs.symlink(path.join(skillPath, "target.txt"), path.join(skillPath, "shortcut.txt"));

    const artifacts = await scanSourceRepository(repo);
    await expect(collectArtifactStates(artifacts, home)).rejects.toThrow(/shortcut\.txt/);
    await expect(installAll(repo, home)).rejects.toThrow(/shortcut\.txt/);

    const paths = resolveTargetPaths(home);
    await expect(fs.access(path.join(paths.agentsSkillsDir, "linked"))).rejects.toMatchObject({ code: "ENOENT" });
    // The repo also contains the unrelated "review" skill from makeRepo(); the abort must
    // stop the whole run before any managed target is created, not just the offending one.
    await expect(fs.access(path.join(paths.agentsSkillsDir, "review"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hashes the executable bit independently of the process umask", async () => {
    const repo = await makeRepo();
    const skillPath = await writeSkill(repo, "runnable", "# Runnable\n");
    await writeExecutableScript(skillPath, "scripts/run.sh");
    const artifacts = await scanSourceRepository(repo);
    const runnable = artifacts.find((artifact) => artifact.name === "runnable")!;

    const originalUmask = process.umask(0o077);
    try {
      const withRestrictiveUmask = await hashArtifact(runnable.kind, runnable.sourcePath);
      process.umask(0o022);
      const withPermissiveUmask = await hashArtifact(runnable.kind, runnable.sourcePath);
      expect(withRestrictiveUmask).toBe(withPermissiveUmask);
    } finally {
      process.umask(originalUmask);
    }
  });
});
