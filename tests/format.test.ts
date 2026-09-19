import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLegacyExposureNotice,
  collectLegacyNotices,
  formatArtifactLine,
  formatConflictLine,
  formatExposureBreakdown,
  formatInteractiveStartupArtifactLines,
  formatManagedEntryLines,
  formatOperationLine
} from "../src/format.js";
import type { ArtifactState, ExposureState, ManagedEntry } from "../src/types.js";

function stripAnsi(line: string | undefined): string {
  return (line ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

function makeState(
  id: string,
  status: ArtifactState["status"],
  conflictReason?: string,
  conflictPath?: string,
  exposures: ExposureState[] = []
): ArtifactState {
  const [kind, name] = id.split(":") as [ArtifactState["artifact"]["kind"], string];

  return {
    artifact: {
      kind,
      name,
      sourcePath: `/repo/${kind === "skill" ? "skills" : "prompts"}/${name}`,
      sourceRoot: "/repo",
      relativeSourcePath: kind === "skill" ? `skills/${name}` : `prompts/${name}.md`
    },
    id,
    basePath: `/home/.agents/${kind === "skill" ? `skills/${name}` : `prompts/${name}.md`}`,
    sourceHash: "source-hash",
    installedHash: status === "new" ? null : "installed-hash",
    status,
    managedEntry: null,
    exposurePlan: [],
    exposures,
    ...(conflictReason === undefined ? {} : { conflictReason }),
    ...(conflictPath === undefined ? {} : { conflictPath })
  };
}

describe("formatManagedEntryLines", () => {
  it("aligns source paths in a second column instead of printing the base store path", () => {
    const entry: ManagedEntry = {
      id: "skill:review",
      kind: "skill",
      name: "review",
      sourceRoot: "/source/repo",
      relativeSourcePath: "skills/review",
      basePath: "/home/user/.agents/skills/review",
      exposures: [],
      sourceHash: "source-hash",
      installedHash: "installed-hash",
      installedAt: "2026-07-08T00:00:00.000Z"
    };

    expect(formatManagedEntryLines([entry])).toEqual([`skill:review  ${path.join("/source/repo", "skills/review")}`]);
  });

  it("prints remote source paths without filesystem path joining", () => {
    const entry: ManagedEntry = {
      id: "skill:review",
      kind: "skill",
      name: "review",
      sourceRoot: "git+https://github.com/org/repo.git",
      relativeSourcePath: "skills/review",
      basePath: "/home/user/.agents/skills/review",
      exposures: [],
      sourceHash: "source-hash",
      installedHash: "installed-hash",
      installedAt: "2026-07-08T00:00:00.000Z"
    };

    expect(formatManagedEntryLines([entry])).toEqual(["skill:review  git+https://github.com/org/repo.git/skills/review"]);
  });

  it("reports requested ref and resolved commit provenance when present", () => {
    const entry: ManagedEntry = {
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
    };

    expect(formatManagedEntryLines([entry])).toEqual([
      `skill:review  git+https://github.com/org/repo.git/skills/review  (ref=main commit=${"a".repeat(7)})`
    ]);
  });

  it("pads artifact ids so all source paths start in the same column", () => {
    const entries: ManagedEntry[] = [
      {
        id: "skill:review",
        kind: "skill",
        name: "review",
        sourceRoot: "/source/repo",
        relativeSourcePath: "skills/review",
        basePath: "/home/user/.agents/skills/review",
        exposures: [],
        sourceHash: "source-hash",
        installedHash: "installed-hash",
        installedAt: "2026-07-08T00:00:00.000Z"
      },
      {
        id: "prompt:commit-message",
        kind: "prompt",
        name: "commit-message",
        sourceRoot: "/source/repo",
        relativeSourcePath: "prompts/commit-message.md",
        basePath: "/home/user/.agents/prompts/commit-message.md",
        exposures: [],
        sourceHash: "source-hash",
        installedHash: "installed-hash",
        installedAt: "2026-07-08T00:00:00.000Z"
      }
    ];

    expect(formatManagedEntryLines(entries)).toEqual([
      "skill:review           /source/repo/skills/review",
      "prompt:commit-message  /source/repo/prompts/commit-message.md"
    ]);
  });
});

describe("formatInteractiveStartupArtifactLines", () => {
  it("does not print conflicts before the interactive selection list", () => {
    const lines = formatInteractiveStartupArtifactLines([
      makeState("skill:ask-matt", "new"),
      makeState("prompt:commit-message", "installed-different"),
      makeState("skill:review", "conflict", "A target path already exists but is not managed by this installer.")
    ]);

    expect(lines).toEqual([]);
  });
});

describe("formatOperationLine", () => {
  it("prints the operation and artifact id", () => {
    expect(formatOperationLine("created", "skill:review")).toBe("created skill:review");
    expect(formatOperationLine("updated", "skill:review")).toBe("updated skill:review");
    expect(formatOperationLine("removed", "skill:review")).toBe("removed skill:review");
  });
});

describe("formatArtifactLine exposure breakdown", () => {
  it("leaves the line unchanged for a single exposure that agrees with the aggregate", () => {
    const state = makeState("skill:review", "installed-same", undefined, undefined, [
      { targetName: "claude", path: "/home/.claude/skills/review", status: "installed-same" }
    ]);

    expect(formatArtifactLine(state)).not.toMatch(/claude/);
    expect(formatArtifactLine(state)).toMatch(/skill:review/);
  });

  it("leaves the line unchanged with no exposures at all", () => {
    expect(stripAnsi(formatArtifactLine(makeState("skill:review", "new")))).not.toMatch(/\[/);
  });

  it("appends a bracketed breakdown when multiple targets are configured", () => {
    const state = makeState("skill:review", "installed-different", undefined, undefined, [
      { targetName: "claude", path: "/home/.claude/skills/review", status: "installed-same" },
      { targetName: "vscode", path: "/home/.vscode/skills/review", status: "new" }
    ]);

    expect(formatArtifactLine(state)).toMatch("[claude: same, vscode: new]");
  });

  it("appends a breakdown when a single exposure diverges from the aggregate", () => {
    const state = makeState("skill:review", "installed-different", undefined, undefined, [
      {
        targetName: "claude",
        path: "/home/.claude/skills/review",
        status: "conflict",
        conflictReason: "taken",
        conflictPath: "/home/.claude/skills/review"
      }
    ]);

    expect(formatArtifactLine(state)).toMatch("[claude: conflict]");
  });
});

describe("formatExposureBreakdown", () => {
  it("labels a legacy exposure by its null target name", () => {
    expect(formatExposureBreakdown([{ targetName: null, path: "/legacy/review", status: "installed-same" }])).toBe(
      "[legacy: same]"
    );
  });
});

describe("legacy exposure notices", () => {
  it("points the notice at config init", () => {
    const notice = buildLegacyExposureNotice("skill:review", "/home/.claude/skills/review");

    expect(notice).toMatch(/skill:review/);
    expect(notice).toMatch(/config init/);
  });

  it("collects one notice per legacy exposure", () => {
    const states = [
      makeState("skill:review", "installed-same", undefined, undefined, [
        { targetName: null, path: "/home/.claude/skills/review", status: "installed-same" }
      ]),
      makeState("prompt:commit-message", "installed-same", undefined, undefined, [
        { targetName: "claude", path: "/home/.claude/commands/commit-message.md", status: "installed-same" }
      ])
    ];

    expect(collectLegacyNotices(states)).toHaveLength(1);
    expect(collectLegacyNotices(states)[0]).toMatch(/skill:review/);
    expect(collectLegacyNotices([])).toEqual([]);
  });
});

describe("formatManagedEntryLines exposure breakdown", () => {
  function makeEntry(id: string): ManagedEntry {
    const [kind, name] = id.split(":") as [ManagedEntry["kind"], string];
    return {
      id,
      kind,
      name,
      sourceRoot: "/source/repo",
      relativeSourcePath: kind === "skill" ? `skills/${name}` : `prompts/${name}.md`,
      basePath: `/home/user/.agents/${name}`,
      exposures: [],
      sourceHash: "source-hash",
      installedHash: "installed-hash",
      installedAt: "2026-07-08T00:00:00.000Z"
    };
  }

  it("appends a breakdown only when more than one exposure is present", () => {
    const entries = [makeEntry("skill:review")];
    const single = new Map([
      ["skill:review", [{ targetName: "claude", path: "/c/review", status: "installed-same" as const }]]
    ]);
    expect(stripAnsi(formatManagedEntryLines(entries, single)[0])).not.toMatch(/\[/);

    const multi = new Map([
      [
        "skill:review",
        [
          { targetName: "claude", path: "/c/review", status: "installed-same" as const },
          { targetName: "team", path: "/t/review", status: "new" as const }
        ]
      ]
    ]);
    expect(formatManagedEntryLines(entries, multi)[0]).toMatch("[claude: same, team: new]");
  });
});

describe("formatConflictLine", () => {
  it("prints the artifact id and its base-store target path", () => {
    const state = makeState("skill:review", "conflict", "A target path already exists but is not managed by this installer.");

    expect(formatConflictLine(state)).toBe("skill:review -> /home/.agents/skills/review");
  });

  it("prints conflictPath instead of basePath when the state sets it", () => {
    const state = makeState(
      "skill:review",
      "conflict",
      'Exposure path already exists and does not point to "/home/.agents/skills/review".',
      "/home/.claude/skills/review"
    );

    expect(formatConflictLine(state)).toBe("skill:review -> /home/.claude/skills/review");
  });
});
