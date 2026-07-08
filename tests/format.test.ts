import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatManagedEntryLine } from "../src/format.js";
import type { ManagedEntry } from "../src/types.js";

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
});
