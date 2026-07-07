import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanSourceRepository } from "../src/source.js";

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-installer-scan-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("scanSourceRepository", () => {
  it("discovers skills and prompt artifacts from conventional directories", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "skills", "review"), { recursive: true });
    await fs.writeFile(path.join(repo, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await fs.mkdir(path.join(repo, "prompts"), { recursive: true });
    await fs.writeFile(path.join(repo, "prompts", "commit-message.md"), "write a commit\n", "utf8");

    const result = await scanSourceRepository(repo);

    expect(result).toEqual([
      expect.objectContaining({ kind: "prompt", name: "commit-message", relativeSourcePath: "prompts/commit-message.md" }),
      expect.objectContaining({ kind: "skill", name: "review", relativeSourcePath: "skills/review" })
    ]);
  });

  it("ignores skill folders without SKILL.md", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "skills", "draft"), { recursive: true });

    const result = await scanSourceRepository(repo);

    expect(result).toEqual([]);
  });

  it("errors when prompts and commands share the same name", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "prompts"), { recursive: true });
    await fs.mkdir(path.join(repo, "commands"), { recursive: true });
    await fs.writeFile(path.join(repo, "prompts", "foo.md"), "from prompts\n", "utf8");
    await fs.writeFile(path.join(repo, "commands", "foo.md"), "from commands\n", "utf8");

    await expect(scanSourceRepository(repo)).rejects.toThrow('Duplicate prompt or command name "foo"');
  });
});
