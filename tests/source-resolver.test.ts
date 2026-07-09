import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isHttpsGitSource, resolveSourceInput, sanitizeRemoteSourceIdentity, type GitRunner } from "../src/source-resolver.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("source resolver", () => {
  it("detects HTTPS Git sources only", () => {
    expect(isHttpsGitSource("https://github.com/org/repo.git")).toBe(true);
    expect(isHttpsGitSource("http://github.com/org/repo.git")).toBe(false);
    expect(isHttpsGitSource("git@github.com:org/repo.git")).toBe(false);
    expect(isHttpsGitSource("/tmp/repo")).toBe(false);
  });

  it("sanitizes remote identities and includes refs", () => {
    expect(
      sanitizeRemoteSourceIdentity("https://token:secret@github.com/org/repo.git?access_token=abc#frag", "release/v1")
    ).toBe("git+https://github.com/org/repo.git#ref=release%2Fv1");
  });

  it("resolves local sources to real paths and rejects refs", async () => {
    const repo = await makeTempDir("agent-installer-local-");
    const source = await resolveSourceInput(repo);

    expect(source.scanRoot).toBe(await fs.realpath(repo));
    expect(source.sourceIdentity).toBe(await fs.realpath(repo));
    await expect(resolveSourceInput(repo, { ref: "main" })).rejects.toThrow("--ref can only be used");
  });

  it("clones remote sources with the provided ref and cleans up the checkout", async () => {
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const git: GitRunner = async (args, cwd) => {
      calls.push(cwd === undefined ? { args } : { args, cwd });
      if (args[0] === "clone") {
        await fs.mkdir(args[4] ?? "", { recursive: true });
      }
    };

    const source = await resolveSourceInput("https://user:token@github.com/org/repo.git", { ref: "v1.2.0", git });
    expect(source.sourceIdentity).toBe("git+https://github.com/org/repo.git#ref=v1.2.0");
    expect(calls).toEqual([
      { args: ["clone", "--depth", "1", "https://user:token@github.com/org/repo.git", source.scanRoot] },
      { args: ["fetch", "--depth", "1", "origin", "v1.2.0"], cwd: source.scanRoot },
      { args: ["checkout", "--detach", "FETCH_HEAD"], cwd: source.scanRoot }
    ]);

    await expect(fs.access(source.scanRoot)).resolves.toBeUndefined();
    await source.cleanup();
    await expect(fs.access(source.scanRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes temporary checkouts when Git fails", async () => {
    let scanRoot = "";
    const git: GitRunner = async (args) => {
      if (args[0] === "clone") {
        scanRoot = args[4] ?? "";
        await fs.mkdir(scanRoot, { recursive: true });
        return;
      }

      throw new Error("missing ref");
    };

    await expect(resolveSourceInput("https://github.com/org/repo.git", { ref: "missing", git })).rejects.toThrow("missing ref");
    await expect(fs.access(scanRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
