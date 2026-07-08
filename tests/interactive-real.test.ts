import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { promptForSelections } from "../src/interactive.js";
import type { ArtifactState, ManagedEntry, RemovedArtifactState } from "../src/types.js";

function makeState(id: string, status: ArtifactState["status"] = "new"): ArtifactState {
  const [kind, name] = id.split(":") as [ArtifactState["artifact"]["kind"], string];
  const managedEntry: ManagedEntry | null =
    status === "new"
      ? null
      : {
          id,
          kind,
          name,
          sourceRoot: "/repo",
          relativeSourcePath: kind === "skill" ? `skills/${name}` : `prompts/${name}.md`,
          basePath: `/home/.agents/${name}`,
          exposurePath: `/home/.claude/${name}`,
          sourceHash: "source-hash",
          installedHash: "installed-hash",
          installedAt: "2026-07-08T00:00:00.000Z"
        };

  return {
    artifact: {
      kind,
      name,
      sourcePath: `/repo/${name}`,
      sourceRoot: "/repo",
      relativeSourcePath: kind === "skill" ? `skills/${name}` : `prompts/${name}.md`
    },
    id,
    basePath: `/home/.agents/${name}`,
    exposurePath: `/home/.claude/${name}`,
    sourceHash: "source-hash",
    installedHash: status === "new" ? null : "installed-hash",
    status,
    managedEntry
  };
}

function makeRemovedState(): RemovedArtifactState {
  const managedEntry: ManagedEntry = {
    id: "skill:old",
    kind: "skill",
    name: "old",
    sourceRoot: "/repo",
    relativeSourcePath: "skills/old",
    basePath: "/home/.agents/old",
    exposurePath: "/home/.claude/old",
    sourceHash: "source-hash",
    installedHash: "installed-hash",
    installedAt: "2026-07-08T00:00:00.000Z"
  };

  return {
    id: "skill:old",
    kind: "skill",
    name: "old",
    basePath: "/home/.agents/old",
    exposurePath: "/home/.claude/old",
    managedEntry,
    status: "source-missing"
  };
}

describe("promptForSelections real prompt behavior", () => {
  it("cancels without changes when escape is pressed", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompt = promptForSelections([makeState("skill:review")], [], {
      input,
      output,
      listLength: 1,
      clearPromptOnDone: true
    });

    input.write("\x1B");

    await expect(prompt).resolves.toEqual({ cancelled: true });
  });

  it("cancels without cleanup changes when escape is pressed in the cleanup confirmation", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompt = promptForSelections([makeState("skill:review", "installed-same")], [makeRemovedState()], {
      input,
      output,
      listLength: 1,
      clearPromptOnDone: true
    });

    input.write("\r");
    input.write("\x1B");

    await expect(prompt).resolves.toEqual({ cancelled: true });
  });
});
