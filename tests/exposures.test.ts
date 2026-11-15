import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { collectArtifactStates, installAllFromSource } from "../src/install.js";
import { managedEntryToJson } from "../src/json-report.js";
import { resolveTargetPaths } from "../src/paths.js";
import { loadState, saveState } from "../src/state.js";
import { scanSourceRepository } from "../src/source.js";
import { syncExposures } from "../src/sync.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const repo = await makeTempDir("agent-installer-exposures-repo-");
  await fs.mkdir(path.join(repo, "skills", "review"), { recursive: true });
  await fs.writeFile(path.join(repo, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
  return repo;
}

async function writeConfigYaml(home: string, yaml: string): Promise<void> {
  const paths = resolveTargetPaths(home);
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.writeFile(paths.configFile, yaml, "utf8");
}

async function addLegacyExposure(home: string): Promise<string> {
  const paths = resolveTargetPaths(home);
  const legacyDir = path.join(home, "legacy-skills");
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

  return legacyPath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("scan/list parity with legacy drift", () => {
  for (const legacy of ["intact", "broken"] as const) {
    for (const withConfig of [true, false] as const) {
      it(`agrees on the aggregate with a ${legacy} legacy link ${withConfig ? "with" : "without"} config.yaml`, async () => {
        const repo = await makeRepo();
        const home = await makeTempDir("agent-installer-exposures-home-");
        const skillsDir = path.join(home, "claude-skills");
        if (withConfig) {
          await writeConfigYaml(home, `version: 1\ntargets:\n  claude:\n    skills: ${skillsDir}\n`);
        }

        await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });
        const legacyPath = await addLegacyExposure(home);
        if (legacy === "broken") {
          await fs.rm(legacyPath);
        }

        const paths = resolveTargetPaths(home);
        const config = withConfig
          ? { version: 1 as const, targets: { claude: { skills: skillsDir } } }
          : await loadConfig(paths, home);

        const artifacts = await scanSourceRepository(repo);
        const { states } = await collectArtifactStates(artifacts, home, await fs.realpath(repo));
        const scanState = states.find((state) => state.id === "skill:review");
        expect(scanState).toBeDefined();

        const state = await loadState(paths);
        const entry = state.entries.find((candidate) => candidate.id === "skill:review");
        expect(entry).toBeDefined();
        const listRecord = await managedEntryToJson(entry!, withConfig ? config : null, home);

        const expectedLegacyStatus = legacy === "intact" ? "installed-same" : "installed-different";

        // The aggregates agree, and a legacy link never moves them: content and
        // every desired exposure match, so the artifact stays installed-same
        // even when the legacy link is broken.
        expect(scanState!.status).toBe("installed-same");
        expect(listRecord.status).toBe("installed-same");
        expect(listRecord.status).toBe(scanState!.status);

        // The drift is still visible on the legacy exposure's own entry.
        expect(scanState!.exposures).toContainEqual({
          targetName: null,
          path: legacyPath,
          status: expectedLegacyStatus
        });
        expect(listRecord.exposures).toContainEqual({
          targetName: null,
          path: legacyPath,
          status: expectedLegacyStatus
        });
      });
    }
  }
});

describe("sync with an equivalently spelled target directory", () => {
  it("plans match (not move) and changes nothing when the directory is a symlinked alias", async () => {
    const repo = await makeRepo();
    const home = await makeTempDir("agent-installer-exposures-home-");
    const paths = resolveTargetPaths(home);
    const oldSkills = path.join(home, "old-skills");
    await writeConfigYaml(home, `version: 1\ntargets:\n  claude:\n    skills: ${oldSkills}\n`);
    await installAllFromSource(repo, home, undefined, undefined, { only: ["skill:review"] });

    const oldExposurePath = path.join(oldSkills, "review");
    expect(await fs.readlink(oldExposurePath)).toBe(path.join(paths.agentsSkillsDir, "review"));

    // Re-spell the same directory through a symlinked alias: same location,
    // different string.
    const aliasSkills = path.join(home, "alias-skills");
    await fs.symlink(oldSkills, aliasSkills);
    await writeConfigYaml(home, `version: 1\ntargets:\n  claude:\n    skills: ${aliasSkills}\n`);

    const planned = await syncExposures({ dryRun: true }, home);
    expect(planned.actions).toEqual([
      expect.objectContaining({ id: "skill:review", targetName: "claude", action: "match" })
    ]);

    const stateBefore = await loadState(paths);
    const applied = await syncExposures({}, home);
    expect(applied.actions).toEqual([
      expect.objectContaining({ id: "skill:review", targetName: "claude", action: "match" })
    ]);

    // A real sync changes nothing: the record keeps its spelling and the
    // on-disk link still resolves to the base copy through either spelling.
    const stateAfter = await loadState(paths);
    expect(stateAfter.entries).toEqual(stateBefore.entries);
    expect(await fs.readlink(oldExposurePath)).toBe(path.join(paths.agentsSkillsDir, "review"));
    expect(await fs.readlink(path.join(aliasSkills, "review"))).toBe(path.join(paths.agentsSkillsDir, "review"));
  });
});
