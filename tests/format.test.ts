import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatInteractiveStartupArtifactLines, formatManagedEntryLines, formatOperationLine } from "../src/format.js";
import type { ArtifactState, ManagedEntry } from "../src/types.js";

function makeState(id: string, status: ArtifactState["status"], conflictReason?: string): ArtifactState {
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
    exposurePath: `/home/.claude/${kind === "skill" ? `skills/${name}` : `commands/${name}.md`}`,
    sourceHash: "source-hash",
    installedHash: status === "new" ? null : "installed-hash",
    status,
    managedEntry: null,
    ...(conflictReason === undefined ? {} : { conflictReason })
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
      exposurePath: "/home/user/.claude/skills/review",
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
      sourceRoot: "git+https://github.com/org/repo.git#ref=v1",
      relativeSourcePath: "skills/review",
      basePath: "/home/user/.agents/skills/review",
      exposurePath: "/home/user/.claude/skills/review",
      sourceHash: "source-hash",
      installedHash: "installed-hash",
      installedAt: "2026-07-08T00:00:00.000Z"
    };

    expect(formatManagedEntryLines([entry])).toEqual(["skill:review  git+https://github.com/org/repo.git#ref=v1/skills/review"]);
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
        exposurePath: "/home/user/.claude/skills/review",
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
        exposurePath: "/home/user/.claude/commands/commit-message.md",
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
