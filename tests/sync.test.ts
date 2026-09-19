import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installAllFromSource } from "../src/install.js";
import { resolveTargetPaths } from "../src/paths.js";
import { loadState, saveState } from "../src/state.js";
import {
  SyncConflictError,
  UnmatchedSyncSelectorsError,
  UnmatchedSyncTargetsError,
  syncExposures
} from "../src/sync.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const repo = await makeTempDir("agent-installer-sync-repo-");
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("sync: config target added", () => {
  it("creates missing symlinks for already-installed artifacts of the kinds the new target configures", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    const claudeSkills = path.join(home, "claude-skills");
    const claudePrompts = path.join(home, "claude-prompts");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n    prompts: ${claudePrompts}\n`);

    const result = await syncExposures({}, home);

    expect(result.actions.filter((a) => a.action === "create").map((a) => a.id).sort()).toEqual([
      "prompt:commit-message",
      "skill:review"
    ]);
    expect(await fs.readlink(path.join(claudeSkills, "review"))).toBe(path.join(paths.agentsSkillsDir, "review"));
    expect(await fs.readlink(path.join(claudePrompts, "commit-message.md"))).toBe(
      path.join(paths.agentsPromptsDir, "commit-message.md")
    );

    const state = await loadState(paths);
    const skillEntry = state.entries.find((entry) => entry.id === "skill:review");
    expect(skillEntry?.exposures).toEqual([{ path: path.join(claudeSkills, "review"), targetName: "claude" }]);
  });

  it("--dry-run prints planned creates without touching the filesystem or state", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    const claudeSkills = path.join(home, "claude-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n`);

    const result = await syncExposures({ dryRun: true }, home);

    expect(result.dryRun).toBe(true);
    expect(result.actions.find((a) => a.id === "skill:review")).toMatchObject({ action: "create", targetName: "claude" });
    await expect(fs.access(path.join(claudeSkills, "review"))).rejects.toMatchObject({ code: "ENOENT" });

    const state = await loadState(paths);
    expect(state.entries.find((entry) => entry.id === "skill:review")?.exposures).toEqual([]);
  });
});

describe("sync: config target moved", () => {
  it("removes the old-path symlink, creates the new-path symlink, and updates exposures[]", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    const oldSkills = path.join(home, "old-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${oldSkills}\n`);
    await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });

    const newSkills = path.join(home, "new-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${newSkills}\n`);

    const result = await syncExposures({}, home);

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: "skill:review",
        targetName: "claude",
        action: "move",
        path: path.join(newSkills, "review"),
        previousPath: path.join(oldSkills, "review")
      })
    ]);
    await expect(fs.access(path.join(oldSkills, "review"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readlink(path.join(newSkills, "review"))).toBe(path.join(paths.agentsSkillsDir, "review"));

    const state = await loadState(paths);
    expect(state.entries.find((entry) => entry.id === "skill:review")?.exposures).toEqual([
      { path: path.join(newSkills, "review"), targetName: "claude" }
    ]);
  });
});

describe("sync: config target removed/narrowed", () => {
  it("auto-removes the orphaned symlink and record, leaving base-store content untouched", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    const claudeSkills = path.join(home, "claude-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n`);
    await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });

    await fs.rm(paths.configFile);

    const result = await syncExposures({}, home);

    expect(result.actions).toEqual([
      expect.objectContaining({ id: "skill:review", targetName: "claude", action: "remove-orphan" })
    ]);
    await expect(fs.access(path.join(claudeSkills, "review"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(paths.agentsSkillsDir, "review", "SKILL.md"), "utf8")).toContain("# Review");

    const state = await loadState(paths);
    expect(state.entries.find((entry) => entry.id === "skill:review")?.exposures).toEqual([]);
  });

  it("auto-removes an exposure whose target narrows to no longer declare that kind", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    const claudeSkills = path.join(home, "claude-skills");
    const claudePrompts = path.join(home, "claude-prompts");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n    prompts: ${claudePrompts}\n`);
    await installAllFromSource(repo, home);

    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    prompts: ${claudePrompts}\n`);

    const result = await syncExposures({}, home);

    expect(result.actions.filter((a) => a.action !== "match")).toEqual([
      expect.objectContaining({ id: "skill:review", targetName: "claude", action: "remove-orphan" })
    ]);
    await expect(fs.access(path.join(claudeSkills, "review"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readlink(path.join(claudePrompts, "commit-message.md"))).toBe(
      path.join(paths.agentsPromptsDir, "commit-message.md")
    );
  });
});

describe("sync: legacy exposures", () => {
  it("never touches a targetName: null exposure, only surfaces it as a notice", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });

    const legacyDir = path.join(home, "legacy-claude-skills");
    await fs.mkdir(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, "review");
    await fs.symlink(path.join(paths.agentsSkillsDir, "review"), legacyPath);

    const state = await loadState(paths);
    await saveState(paths, {
      ...state,
      entries: state.entries.map((entry) =>
        entry.id === "skill:review" ? { ...entry, exposures: [{ path: legacyPath, targetName: null }] } : entry
      )
    });

    const result = await syncExposures({}, home);

    expect(result.legacyNotices).toEqual([{ id: "skill:review", path: legacyPath }]);
    expect(result.actions).toEqual([]);
    expect(await fs.readlink(legacyPath)).toBe(path.join(paths.agentsSkillsDir, "review"));

    const after = await loadState(paths);
    expect(after.entries.find((entry) => entry.id === "skill:review")?.exposures).toEqual([
      { path: legacyPath, targetName: null }
    ]);
  });
});

describe("sync: ownership revalidation", () => {
  it("skips removing an orphan a foreign file has replaced, retains the record, and reports it", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    const claudeSkills = path.join(home, "claude-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n`);
    await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });

    const exposurePath = path.join(claudeSkills, "review");
    await fs.rm(exposurePath);
    await fs.writeFile(exposurePath, "not ours anymore\n", "utf8");
    await fs.rm(paths.configFile);

    const result = await syncExposures({}, home);

    expect(result.skippedOrphanRemovals).toEqual([{ id: "skill:review", path: exposurePath, targetName: "claude" }]);
    expect(await fs.readFile(exposurePath, "utf8")).toBe("not ours anymore\n");

    const state = await loadState(paths);
    expect(state.entries.find((entry) => entry.id === "skill:review")?.exposures).toEqual([
      { path: exposurePath, targetName: "claude" }
    ]);
  });

  it("still removes an orphan record that was already deleted out from under it, with nothing to report", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    const claudeSkills = path.join(home, "claude-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n`);
    await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });

    await fs.rm(path.join(claudeSkills, "review"));
    await fs.rm(paths.configFile);

    const result = await syncExposures({}, home);

    expect(result.skippedOrphanRemovals).toEqual([]);
    const state = await loadState(paths);
    expect(state.entries.find((entry) => entry.id === "skill:review")?.exposures).toEqual([]);
  });

  it("does not create a duplicate exposure record when a moved target's stale old path was replaced by a foreign file", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    const oldSkills = path.join(home, "old-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${oldSkills}\n`);
    await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });

    const oldExposurePath = path.join(oldSkills, "review");
    await fs.rm(oldExposurePath);
    await fs.writeFile(oldExposurePath, "not ours anymore\n", "utf8");

    const newSkills = path.join(home, "new-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${newSkills}\n`);

    const result = await syncExposures({}, home);

    expect(result.skippedOrphanRemovals).toEqual([{ id: "skill:review", path: oldExposurePath, targetName: "claude" }]);
    expect(await fs.readFile(oldExposurePath, "utf8")).toBe("not ours anymore\n");
    await expect(fs.access(path.join(newSkills, "review"))).rejects.toMatchObject({ code: "ENOENT" });

    const state = await loadState(paths);
    expect(state.entries.find((entry) => entry.id === "skill:review")?.exposures).toEqual([
      { path: oldExposurePath, targetName: "claude" }
    ]);
  });
});

describe("sync: link-only update reconciliation", () => {
  it("reports installed-different for an unchanged source once a target's resolved path moves", async () => {
    const { collectArtifactStates } = await import("../src/install.js");
    const { scanSourceRepository } = await import("../src/source.js");

    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    const oldSkills = path.join(home, "old-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${oldSkills}\n`);
    await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });

    const newSkills = path.join(home, "new-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${newSkills}\n`);

    const artifacts = await scanSourceRepository(repo);
    const { states } = await collectArtifactStates(artifacts, home);
    const reviewState = states.find((state) => state.id === "skill:review");
    expect(reviewState?.status).toBe("installed-different");
    expect(reviewState?.sourceHash).toBe(reviewState?.installedHash);

    await syncExposures({}, home);

    const resynced = await collectArtifactStates(await scanSourceRepository(repo), home);
    expect(resynced.states.find((state) => state.id === "skill:review")?.status).toBe("installed-same");
  });
});

describe("sync: --only selection", () => {
  it("syncs exactly the selected artifact and leaves the other untouched", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    const claudeSkills = path.join(home, "claude-skills");
    const claudePrompts = path.join(home, "claude-prompts");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n    prompts: ${claudePrompts}\n`);

    const result = await syncExposures({ only: ["skill:review"] }, home);

    expect(result.actions.map((a) => a.id)).toEqual(["skill:review"]);
    await expect(fs.access(path.join(claudePrompts, "commit-message.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws naming the unmatched selector and changes nothing", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    await installAllFromSource(repo, home);

    await expect(syncExposures({ only: ["skill:missing"] }, home)).rejects.toThrow(UnmatchedSyncSelectorsError);
    await expect(syncExposures({ only: ["skill:missing"] }, home)).rejects.toThrow(/skill:missing/);
  });
});

describe("sync: --target selection", () => {
  it("narrows reconciliation to the named target only, leaving other targets alone", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });

    const claudeSkills = path.join(home, "claude-skills");
    const teamSkills = path.join(home, "team-skills");
    await writeConfigYaml(
      paths,
      `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n  team:\n    skills: ${teamSkills}\n`
    );

    const result = await syncExposures({ targets: ["claude"] }, home);

    expect(result.actions).toEqual([expect.objectContaining({ id: "skill:review", targetName: "claude", action: "create" })]);
    await expect(fs.access(path.join(teamSkills, "review"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws naming an unknown target", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    await installAllFromSource(repo, home);

    await expect(syncExposures({ targets: ["ghost"] }, home)).rejects.toThrow(UnmatchedSyncTargetsError);
    await expect(syncExposures({ targets: ["ghost"] }, home)).rejects.toThrow(/ghost/);
  });

  it("accepts a target name that no longer exists in config.yaml but still owns a recorded exposure", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    const claudeSkills = path.join(home, "claude-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n`);
    await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });

    await fs.rm(paths.configFile);

    const result = await syncExposures({ targets: ["claude"] }, home);

    expect(result.actions).toEqual([expect.objectContaining({ id: "skill:review", targetName: "claude", action: "remove-orphan" })]);
  });
});

describe("sync: conflict handling", () => {
  it("aborts with zero changes when a touched pair conflicts with an unmanaged path", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    const claudeSkills = path.join(home, "claude-skills");
    await fs.mkdir(claudeSkills, { recursive: true });
    await fs.writeFile(path.join(claudeSkills, "review"), "user-owned\n", "utf8");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n`);

    await expect(syncExposures({}, home)).rejects.toThrow(SyncConflictError);
    await expect(syncExposures({}, home)).rejects.toThrow(/skill:review/);

    expect(await fs.readFile(path.join(claudeSkills, "review"), "utf8")).toBe("user-owned\n");
    const state = await loadState(paths);
    expect(state.entries.find((entry) => entry.id === "skill:review")?.exposures).toEqual([]);
  });

  it("syncs the eligible pairs and reports the skipped conflict with --allow-conflicts", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);

    const claudeSkills = path.join(home, "claude-skills");
    const claudePrompts = path.join(home, "claude-prompts");
    await fs.mkdir(claudeSkills, { recursive: true });
    await fs.writeFile(path.join(claudeSkills, "review"), "user-owned\n", "utf8");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n    prompts: ${claudePrompts}\n`);

    const result = await syncExposures({ allowConflicts: true }, home);

    expect(result.actions.find((a) => a.id === "skill:review")).toMatchObject({ action: "conflict" });
    expect(result.actions.find((a) => a.id === "prompt:commit-message")).toMatchObject({ action: "create" });
    expect(await fs.readFile(path.join(claudeSkills, "review"), "utf8")).toBe("user-owned\n");
    expect(await fs.readlink(path.join(claudePrompts, "commit-message.md"))).toBe(
      path.join(paths.agentsPromptsDir, "commit-message.md")
    );
  });

  it("includes conflicts in the --dry-run plan without aborting", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });

    const claudeSkills = path.join(home, "claude-skills");
    await fs.mkdir(claudeSkills, { recursive: true });
    await fs.writeFile(path.join(claudeSkills, "review"), "user-owned\n", "utf8");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n`);

    const result = await syncExposures({ dryRun: true }, home);

    expect(result.actions).toEqual([expect.objectContaining({ id: "skill:review", action: "conflict" })]);
  });
});

describe("sync: no source contact", () => {
  it("reconciles purely from state and config.yaml, requiring no source path argument", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-sync-home-");
    const paths = resolveTargetPaths(home);
    await installAllFromSource(repo, home);
    await fs.rm(repo, { recursive: true, force: true });

    const claudeSkills = path.join(home, "claude-skills");
    await writeConfigYaml(paths, `version: 1\ntargets:\n  claude:\n    skills: ${claudeSkills}\n`);

    const result = await syncExposures({}, home);

    expect(result.actions.find((a) => a.id === "skill:review")).toMatchObject({ action: "create" });
    expect(await fs.readlink(path.join(claudeSkills, "review"))).toBe(path.join(paths.agentsSkillsDir, "review"));
  });
});
