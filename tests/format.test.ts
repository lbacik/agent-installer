import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatInteractiveStartupArtifactLines, formatManagedEntryLine } from "../src/format.js";
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

describe("formatManagedEntryLine", () => {
  it("prints the managed entry source path instead of the base store path", () => {
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

    expect(formatManagedEntryLine(entry)).toBe(`skill:review -> ${path.join("/source/repo", "skills/review")}`);
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

    expect(formatManagedEntryLine(entry)).toBe("skill:review -> git+https://github.com/org/repo.git#ref=v1/skills/review");
  });
});

describe("formatInteractiveStartupArtifactLines", () => {
  it("prints conflicts but omits newly discovered artifacts", () => {
    const lines = formatInteractiveStartupArtifactLines([
      makeState("skill:ask-matt", "new"),
      makeState("prompt:commit-message", "installed-different"),
      makeState("skill:review", "conflict", "A target path already exists but is not managed by this installer.")
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("conflict skill:review <- skills/review");
    expect(lines[0]).toContain("A target path already exists");
    expect(lines.join("\n")).not.toContain("skill:ask-matt");
  });
});
