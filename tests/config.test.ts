import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ConfigurationError } from "../src/errors.js";
import { installAllFromSource } from "../src/install.js";
import { resolveTargetPaths } from "../src/paths.js";
import type { GitRunner } from "../src/source-resolver.js";
import { withResolvedArtifactStates } from "../src/source-workflow.js";
import { saveState } from "../src/state.js";
import type { ManagedEntry } from "../src/types.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeConfig(configFile: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, content, "utf8");
}

describe("loadConfig", () => {
  it("returns null when config.yaml does not exist", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await expect(loadConfig(paths)).resolves.toBeNull();
  });

  it("loads a minimal valid config", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, `version: 1\ntargets:\n  team:\n    skills: /abs/team-skills\n`);

    await expect(loadConfig(paths, home)).resolves.toEqual({
      version: 1,
      targets: { team: { skills: "/abs/team-skills" } }
    });
  });

  it("aborts with a parse error naming the file on invalid YAML syntax", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, "version: 1\ntargets: [this is: not valid\n");

    const error = await loadConfig(paths, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain(paths.configFile);
  });

  it("aborts naming the file and the offending key on an unknown top-level key", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, `version: 1\nextra: true\ntargets:\n  team:\n    skills: /abs/team-skills\n`);

    const error = await loadConfig(paths, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain(paths.configFile);
    expect((error as Error).message).toContain("extra");
  });

  it("aborts naming the file and the offending key on an unknown target-level key", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, `version: 1\ntargets:\n  team:\n    skills: /abs/team-skills\n    bogus: true\n`);

    const error = await loadConfig(paths, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain("bogus");
  });

  it("rejects a target that sets neither skills nor prompts", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, `version: 1\ntargets:\n  team: {}\n`);

    const error = await loadConfig(paths, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toMatch(/must set at least one/);
  });

  it("rejects a bare relative path", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, `version: 1\ntargets:\n  team:\n    skills: relative/dir\n`);

    const error = await loadConfig(paths, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toMatch(/absolute or start with "~\/"/);
  });

  it("rejects an unsupported version", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, `version: 2\ntargets:\n  team:\n    skills: /abs/team-skills\n`);

    const error = await loadConfig(paths, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
  });

  it("rejects two targets with an identical resolved path for the same kind", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(
      paths.configFile,
      `version: 1\ntargets:\n  a:\n    skills: /abs/shared\n  b:\n    skills: /abs/shared\n`
    );

    const error = await loadConfig(paths, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain("/abs/shared");
  });

  it("allows two targets with an identical resolved path for different kinds", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(
      paths.configFile,
      `version: 1\ntargets:\n  a:\n    skills: /abs/shared\n  b:\n    prompts: /abs/shared\n`
    );

    await expect(loadConfig(paths, home)).resolves.not.toBeNull();
  });

  it("rejects two targets with nested paths regardless of kind or direction", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(
      paths.configFile,
      `version: 1\ntargets:\n  a:\n    skills: /abs/shared\n  b:\n    prompts: /abs/shared/nested\n`
    );

    const error = await loadConfig(paths, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toMatch(/must not nest/);
  });

  it("rejects a target path that resolves to the base store", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, `version: 1\ntargets:\n  a:\n    skills: ${paths.agentsRoot}\n`);

    const error = await loadConfig(paths, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toMatch(/base store/);
  });

  it("rejects a target path that nests inside the base store's metadata directory", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(
      paths.configFile,
      `version: 1\ntargets:\n  a:\n    prompts: ${path.join(paths.stateDir, "nested")}\n`
    );

    const error = await loadConfig(paths, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toMatch(/base store/);
  });

  it("expands a ~/-prefixed path using the redirected home", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, `version: 1\ntargets:\n  a:\n    skills: ~/exposed-skills\n`);

    await expect(loadConfig(paths, home)).resolves.toEqual({
      version: 1,
      targets: { a: { skills: "~/exposed-skills" } }
    });
  });

  it("rejects a bare ~ with no trailing slash", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, `version: 1\ntargets:\n  a:\n    skills: "~"\n`);

    const error = await loadConfig(paths, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toMatch(/absolute or start with "~\/"/);
  });
});

describe("config validated before touching a remote source", () => {
  it("withResolvedArtifactStates rejects a malformed config before cloning a remote source", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, `version: 1\ntargets:\n  team: {}\n`);

    let cloned = false;
    const git: GitRunner = async (args) => {
      if (args[0] === "clone") {
        cloned = true;
      }

      return "";
    };

    await expect(
      withResolvedArtifactStates("https://github.com/lbacik/agents", home, undefined, { git }, async () => undefined)
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(cloned).toBe(false);
  });

  it("installAllFromSource rejects a malformed config before cloning a remote source", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, `version: 1\ntargets:\n  team: {}\n`);

    let cloned = false;
    const git: GitRunner = async (args) => {
      if (args[0] === "clone") {
        cloned = true;
      }

      return "";
    };

    await expect(
      installAllFromSource("https://github.com/lbacik/agents", home, undefined, { git })
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(cloned).toBe(false);
  });
});

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn()
}));

type MockPrompt = Mock<(config: unknown, context?: unknown) => Promise<unknown>>;

describe("runConfigInit", () => {
  let inputMock: MockPrompt;
  let selectMock: MockPrompt;
  let confirmMock: MockPrompt;

  beforeEach(async () => {
    const prompts = await import("@inquirer/prompts");
    inputMock = prompts.input as unknown as MockPrompt;
    selectMock = prompts.select as unknown as MockPrompt;
    confirmMock = prompts.confirm as unknown as MockPrompt;
    inputMock.mockReset();
    selectMock.mockReset();
    confirmMock.mockReset();
  });

  it("writes a config.yaml built from a custom target", async () => {
    const { runConfigInit } = await import("../src/config-init.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    const skillsDir = path.join(await makeTempDir("agent-installer-target-"), "skills");

    selectMock.mockResolvedValueOnce("custom");
    inputMock
      .mockResolvedValueOnce("team") // target name
      .mockResolvedValueOnce(skillsDir) // skills dir
      .mockResolvedValueOnce("") // prompts dir (skip)
      .mockResolvedValueOnce(""); // next target name (finish)

    await runConfigInit(paths);

    const written = await fs.readFile(paths.configFile, "utf8");
    expect(written).toContain("team:");
    expect(written).toContain(skillsDir);
  });

  it("does not create config.yaml when no targets are entered", async () => {
    const { runConfigInit } = await import("../src/config-init.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);

    inputMock.mockResolvedValueOnce(""); // blank name immediately

    await runConfigInit(paths);

    await expect(fs.access(paths.configFile)).rejects.toThrow();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an existing config.yaml without confirmation or --force", async () => {
    const { runConfigInit } = await import("../src/config-init.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, "version: 1\ntargets:\n  old:\n    skills: /abs/old\n");

    confirmMock.mockResolvedValueOnce(false);

    await runConfigInit(paths);

    const stillThere = await fs.readFile(paths.configFile, "utf8");
    expect(stillThere).toContain("old:");
    expect(inputMock).not.toHaveBeenCalled();
  });

  it("overwrites an existing config.yaml with --force, skipping the confirmation", async () => {
    const { runConfigInit } = await import("../src/config-init.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await writeConfig(paths.configFile, "version: 1\ntargets:\n  old:\n    skills: /abs/old\n");
    const skillsDir = path.join(await makeTempDir("agent-installer-target-"), "skills");

    selectMock.mockResolvedValueOnce("custom");
    inputMock
      .mockResolvedValueOnce("new")
      .mockResolvedValueOnce(skillsDir)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    await runConfigInit(paths, { force: true });

    expect(confirmMock).not.toHaveBeenCalled();
    const written = await fs.readFile(paths.configFile, "utf8");
    expect(written).toContain("new:");
    expect(written).not.toContain("old:");
  });

  it("prefills the claude preset with known defaults when no legacy exposure exists", async () => {
    const { runConfigInit } = await import("../src/config-init.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);

    selectMock.mockResolvedValueOnce("claude");
    inputMock
      .mockResolvedValueOnce("claude") // target name
      .mockImplementationOnce(async (config: unknown) => (config as { default?: string }).default ?? "") // skills: accept default
      .mockImplementationOnce(async (config: unknown) => (config as { default?: string }).default ?? "") // prompts: accept default
      .mockResolvedValueOnce(""); // finish

    await runConfigInit(paths);

    expect(inputMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ default: paths.claudeSkillsDir }), {});
    expect(inputMock).toHaveBeenNthCalledWith(3, expect.objectContaining({ default: paths.claudeCommandsDir }), {});

    const written = await fs.readFile(paths.configFile, "utf8");
    expect(written).toContain(paths.claudeSkillsDir);
    expect(written).toContain(paths.claudeCommandsDir);
  });

  it("prefills the claude preset with a detected legacy exposure directory when one exists", async () => {
    const { runConfigInit } = await import("../src/config-init.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    const legacySkillsDir = path.join(home, ".claude-legacy", "skills");

    const legacyEntry: ManagedEntry = {
      id: "skill:review",
      kind: "skill",
      name: "review",
      sourceRoot: "/repo",
      relativeSourcePath: "skills/review",
      basePath: path.join(paths.agentsSkillsDir, "review"),
      exposures: [{ path: path.join(legacySkillsDir, "review"), targetName: null }],
      sourceHash: "hash",
      installedHash: "hash",
      installedAt: "2026-07-08T00:00:00.000Z"
    };
    await saveState(paths, { version: 3, entries: [legacyEntry] });

    selectMock.mockResolvedValueOnce("claude");
    inputMock
      .mockResolvedValueOnce("claude")
      .mockImplementationOnce(async (config: unknown) => (config as { default?: string }).default ?? "")
      .mockImplementationOnce(async (config: unknown) => (config as { default?: string }).default ?? "")
      .mockResolvedValueOnce("");

    await runConfigInit(paths);

    expect(inputMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ default: legacySkillsDir }), {});

    const written = await fs.readFile(paths.configFile, "utf8");
    expect(written).toContain(legacySkillsDir);
  });

  it("skips a target that ends up with neither directory set", async () => {
    const { runConfigInit } = await import("../src/config-init.js");
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    const skillsDir = path.join(await makeTempDir("agent-installer-target-"), "skills");

    selectMock.mockResolvedValueOnce("custom").mockResolvedValueOnce("custom");
    inputMock
      .mockResolvedValueOnce("empty") // target name
      .mockResolvedValueOnce("") // skills (skip)
      .mockResolvedValueOnce("") // prompts (skip)
      .mockResolvedValueOnce("kept") // second target name
      .mockResolvedValueOnce(skillsDir)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(""); // finish

    await runConfigInit(paths);

    const written = await fs.readFile(paths.configFile, "utf8");
    expect(written).not.toContain("empty:");
    expect(written).toContain("kept:");
  });
});
