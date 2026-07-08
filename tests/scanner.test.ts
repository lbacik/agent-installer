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

  it("discovers skills nested below skills up to the default max depth", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "skills", "engineering", "code-review"), { recursive: true });
    await fs.writeFile(path.join(repo, "skills", "engineering", "code-review", "SKILL.md"), "# Code Review\n", "utf8");

    const result = await scanSourceRepository(repo);

    expect(result).toEqual([
      expect.objectContaining({ kind: "skill", name: "code-review", relativeSourcePath: "skills/engineering/code-review" })
    ]);
  });

  it("ignores skills deeper than the configured max depth", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "skills", "one", "two", "three", "deep-skill"), { recursive: true });
    await fs.writeFile(path.join(repo, "skills", "one", "two", "three", "deep-skill", "SKILL.md"), "# Deep\n", "utf8");

    await expect(scanSourceRepository(repo)).resolves.toEqual([]);
    await expect(scanSourceRepository(repo, { skillMaxDepth: 4 })).resolves.toEqual([
      expect.objectContaining({ kind: "skill", name: "deep-skill", relativeSourcePath: "skills/one/two/three/deep-skill" })
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

  it("errors when recursive skill discovery finds duplicate skill names", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "skills", "engineering", "review"), { recursive: true });
    await fs.mkdir(path.join(repo, "skills", "deprecated", "review"), { recursive: true });
    await fs.writeFile(path.join(repo, "skills", "engineering", "review", "SKILL.md"), "# Review\n", "utf8");
    await fs.writeFile(path.join(repo, "skills", "deprecated", "review", "SKILL.md"), "# Old Review\n", "utf8");

    await expect(scanSourceRepository(repo)).rejects.toThrow('Duplicate skill name "review"');
  });
});
