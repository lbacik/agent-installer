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
  it("starts a fresh version 3 state file when none exists", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const state = await loadState(resolveTargetPaths(home));
    expect(state).toEqual({ version: 3, entries: [] });
  });

  it("migrates a version 1 state file straight through to version 3", async () => {
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
    expect(state.version).toBe(3);
    expect(state.entries[0]).toMatchObject({
      sourceRoot: "git+https://github.com/org/repo.git",
      requestedRef: "release/v1",
      exposures: [{ path: "/home/user/.claude/skills/review", targetName: null }]
    });
    expect(state.entries[0]?.resolvedCommit).toBeUndefined();
    expect(state.entries[1]).toMatchObject({
      sourceRoot: "/local/repo",
      exposures: [{ path: "/home/user/.claude/commands/commit-message.md", targetName: null }]
    });
    expect(state.entries[1]?.requestedRef).toBeUndefined();

    const persisted = JSON.parse(await fs.readFile(paths.stateFile, "utf8"));
    expect(persisted.version).toBe(3);
    expect(persisted.entries[0].exposurePath).toBeUndefined();
  });

  it("migrates a version 2 state file to version 3, wrapping exposurePath into a legacy exposure record", async () => {
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
    expect(state.version).toBe(3);
    expect(state.entries[0]).toMatchObject({
      requestedRef: "main",
      resolvedCommit: "a".repeat(40),
      exposures: [{ path: "/home/user/.claude/skills/review", targetName: null }]
    });
    expect((state.entries[0] as unknown as { exposurePath?: unknown }).exposurePath).toBeUndefined();

    const persisted = JSON.parse(await fs.readFile(paths.stateFile, "utf8"));
    expect(persisted.version).toBe(3);
  });

  it("loads a version 3 state file as-is", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    await fs.mkdir(paths.stateDir, { recursive: true });
    await fs.writeFile(
      paths.stateFile,
      JSON.stringify({
        version: 3,
        entries: [
          {
            id: "skill:review",
            kind: "skill",
            name: "review",
            sourceRoot: "git+https://github.com/org/repo.git",
            relativeSourcePath: "skills/review",
            basePath: "/home/user/.agents/skills/review",
            exposures: [],
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
    expect(state.entries[0]).toMatchObject({ requestedRef: "main", resolvedCommit: "a".repeat(40), exposures: [] });
  });

  it("round-trips a saved state through loadState unchanged", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    const written: import("../src/state.js").InstallerState = {
      version: 3,
      entries: [
        {
          id: "skill:review",
          kind: "skill",
          name: "review",
          sourceRoot: "/local/repo",
          relativeSourcePath: "skills/review",
          basePath: "/home/user/.agents/skills/review",
          exposures: [{ path: "/home/user/.claude/skills/review", targetName: "claude" }],
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
    await fs.writeFile(paths.stateFile, JSON.stringify({ version: 99, entries: [] }), "utf8");

    await expect(loadState(paths)).rejects.toThrow(/version/i);
  });

  it("never leaves state.json partially written, and a retry resumes cleanly", async () => {
    const home = await makeTempDir("agent-installer-home-");
    const paths = resolveTargetPaths(home);
    const goodState: import("../src/state.js").InstallerState = { version: 3, entries: [] };
    await saveState(paths, goodState);

    // Simulate a crash between writing the temp file and renaming it into place: the
    // temp file exists with different content, but state.json itself was never touched.
    const staleTempFile = path.join(paths.stateDir, ".state.json.stale.tmp");
    await fs.writeFile(staleTempFile, "{not valid json", "utf8");

    expect(await loadState(paths)).toEqual(goodState);
    expect(await fs.readFile(paths.stateFile, "utf8")).toBe(`${JSON.stringify(goodState, null, 2)}\n`);

    const nextState: import("../src/state.js").InstallerState = {
      version: 3,
      entries: [
        {
          id: "skill:review",
          kind: "skill",
          name: "review",
          sourceRoot: "/local/repo",
          relativeSourcePath: "skills/review",
          basePath: "/home/user/.agents/skills/review",
          exposures: [],
          sourceHash: "source-hash",
          installedHash: "installed-hash",
          installedAt: "2026-07-08T00:00:00.000Z"
        }
      ]
    };
    await saveState(paths, nextState);
    expect(await loadState(paths)).toEqual(nextState);
  });
});
