import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTargetPaths } from "../src/paths.js";
import { loadState, saveState } from "../src/state.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("state", () => {
  it("starts a fresh version 2 state file when none exists", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const state = await loadState(resolveTargetPaths(home));
    expect(state).toEqual({ version: 2, entries: [] });
  });

  it("migrates a version 1 state file, splitting the ref fragment out of sourceRoot", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(paths.stateDir, { recursive: true });
    await fs.writeFile(
      paths.stateFile,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "skill:review",
            kind: "skill",
            name: "review",
            sourceRoot: "git+https://github.com/org/repo.git#ref=release%2Fv1",
            relativeSourcePath: "skills/review",
            basePath: "/home/user/.agents/skills/review",
            exposurePath: "/home/user/.claude/skills/review",
            sourceHash: "source-hash",
            installedHash: "installed-hash",
            installedAt: "2026-07-08T00:00:00.000Z"
          },
          {
            id: "prompt:commit-message",
            kind: "prompt",
            name: "commit-message",
            sourceRoot: "/local/repo",
            relativeSourcePath: "prompts/commit-message.md",
            basePath: "/home/user/.agents/prompts/commit-message.md",
            exposurePath: "/home/user/.claude/commands/commit-message.md",
            sourceHash: "source-hash",
            installedHash: "installed-hash",
            installedAt: "2026-07-08T00:00:00.000Z"
          }
        ]
      }),
      "utf8"
    );

    const state = await loadState(paths);
    expect(state.version).toBe(2);
    expect(state.entries[0]).toMatchObject({
      sourceRoot: "git+https://github.com/org/repo.git",
      requestedRef: "release/v1"
    });
    expect(state.entries[0]?.resolvedCommit).toBeUndefined();
    expect(state.entries[1]).toMatchObject({ sourceRoot: "/local/repo" });
    expect(state.entries[1]?.requestedRef).toBeUndefined();

    const persisted = JSON.parse(await fs.readFile(paths.stateFile, "utf8"));
    expect(persisted.version).toBe(2);
  });

  it("loads a version 2 state file as-is", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(paths.stateDir, { recursive: true });
    await fs.writeFile(
      paths.stateFile,
      JSON.stringify({
        version: 2,
        entries: [
          {
            id: "skill:review",
            kind: "skill",
            name: "review",
            sourceRoot: "git+https://github.com/org/repo.git",
            relativeSourcePath: "skills/review",
            basePath: "/home/user/.agents/skills/review",
            exposurePath: "/home/user/.claude/skills/review",
            sourceHash: "source-hash",
            installedHash: "installed-hash",
            installedAt: "2026-07-08T00:00:00.000Z",
            requestedRef: "main",
            resolvedCommit: "a".repeat(40)
          }
        ]
      }),
      "utf8"
    );

    const state = await loadState(paths);
    expect(state.entries[0]).toMatchObject({ requestedRef: "main", resolvedCommit: "a".repeat(40) });
  });

  it("round-trips a saved state through loadState unchanged", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    const written: import("../src/state.js").InstallerState = {
      version: 2,
      entries: [
        {
          id: "skill:review",
          kind: "skill",
          name: "review",
          sourceRoot: "/local/repo",
          relativeSourcePath: "skills/review",
          basePath: "/home/user/.agents/skills/review",
          exposurePath: "/home/user/.claude/skills/review",
          sourceHash: "source-hash",
          installedHash: "installed-hash",
          installedAt: "2026-07-08T00:00:00.000Z"
        }
      ]
    };

    await saveState(paths, written);
    expect(await loadState(paths)).toEqual(written);
  });

  it("fails with an explanatory error for an unrecognised state version", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(paths.stateDir, { recursive: true });
    await fs.writeFile(paths.stateFile, JSON.stringify({ version: 3, entries: [] }), "utf8");

    await expect(loadState(paths)).rejects.toThrow(/version/i);
  });
});
