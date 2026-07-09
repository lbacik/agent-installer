import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installArtifacts } from "../src/install.js";
import { resolveTargetPaths } from "../src/paths.js";
import { withResolvedArtifactStates } from "../src/source-workflow.js";
import type { GitRunner } from "../src/source-resolver.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("withResolvedArtifactStates", () => {
  it("keeps remote checkouts available until install work finishes, then cleans up", async () => {
    const home = await makeTempDir("agent-installer-home-");
    let checkoutRoot = "";
    const git: GitRunner = async (args) => {
      if (args[0] !== "clone") {
        return;
      }

      checkoutRoot = args[4] ?? "";
      await fs.mkdir(path.join(checkoutRoot, "prompts"), { recursive: true });
      await fs.writeFile(path.join(checkoutRoot, "prompts", "git-diff-stat.md"), "summarize diff stats\n", "utf8");
    };

    await withResolvedArtifactStates(
      "https://github.com/lbacik/agents",
      home,
      undefined,
      { git },
      async ({ states }) => {
        expect(states.map((state) => state.id)).toEqual(["prompt:git-diff-stat"]);
        await expect(fs.access(states[0]?.artifact.sourcePath ?? "")).resolves.toBeUndefined();
        await installArtifacts(states, home);
      }
    );

    const paths = resolveTargetPaths(home);
    await expect(fs.access(checkoutRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(paths.agentsPromptsDir, "git-diff-stat.md"), "utf8")).resolves.toContain(
      "summarize diff stats"
    );
  });
});
