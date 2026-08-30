import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
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

async function readCodexPolicy(skillBasePath: string): Promise<unknown> {
  return parseYaml(await fs.readFile(path.join(skillBasePath, CODEX_METADATA_PATH), "utf8"));
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

describe("codex invocation policy translation", () => {
  it("materializes the Codex policy for a Claude-disabled skill and keeps it installed-same", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-home-");
    await writeSkill(repo, "restricted", skillWithFrontmatter("name: restricted\ndisable-model-invocation: true"));

    await installAll(repo, home);

    const paths = resolveTargetPaths(home);
    const skillBasePath = path.join(paths.agentsSkillsDir, "restricted");
    expect(await readCodexPolicy(skillBasePath)).toEqual({ policy: { allow_implicit_invocation: false } });
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
        return;
      }

      const checkout = args[4] ?? "";
      await fs.mkdir(path.join(checkout, "skills", "restricted"), { recursive: true });
      await fs.writeFile(
        path.join(checkout, "skills", "restricted", "SKILL.md"),
        skillWithFrontmatter("disable-model-invocation: true"),
        "utf8"
      );
    };

    const states = await installAllFromSource("https://github.com/org/repo.git", home, undefined, { ref: "main", git });

    const paths = resolveTargetPaths(home);
    expect(states.map((state) => state.id)).toEqual(["skill:restricted"]);
    expect(await readCodexPolicy(path.join(paths.agentsSkillsDir, "restricted"))).toEqual({
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
