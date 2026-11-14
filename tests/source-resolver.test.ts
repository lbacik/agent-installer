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

  it("sanitizes remote identities and drops credentials, query and fragment", () => {
    expect(sanitizeRemoteSourceIdentity("https://token:secret@github.com/org/repo.git?access_token=abc#frag")).toBe(
      "git+https://github.com/org/repo.git"
    );
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
    const resolvedCommit = "c".repeat(40);
    const git: GitRunner = async (args, cwd) => {
      calls.push(cwd === undefined ? { args } : { args, cwd });
      if (args[0] === "clone") {
        await fs.mkdir(args[4] ?? "", { recursive: true });
        return "";
      }

      if (args[0] === "rev-parse") {
        return `${resolvedCommit}\n`;
      }

      return "";
    };

    const source = await resolveSourceInput("https://user:token@github.com/org/repo.git", { ref: "v1.2.0", git });
    expect(source.sourceIdentity).toBe("git+https://github.com/org/repo.git");
    expect(source.requestedRef).toBe("v1.2.0");
    expect(source.resolvedCommit).toBe(resolvedCommit);
    expect(calls).toEqual([
      { args: ["clone", "--depth", "1", "https://user:token@github.com/org/repo.git", source.scanRoot] },
      { args: ["fetch", "--depth", "1", "origin", "v1.2.0"], cwd: source.scanRoot },
      { args: ["checkout", "--detach", "FETCH_HEAD"], cwd: source.scanRoot },
      { args: ["rev-parse", "HEAD"], cwd: source.scanRoot }
    ]);

    await expect(fs.access(source.scanRoot)).resolves.toBeUndefined();
    await source.cleanup();
    await expect(fs.access(source.scanRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves the checked-out commit even when no ref is requested", async () => {
    const resolvedCommit = "d".repeat(40);
    const git: GitRunner = async (args) => {
      if (args[0] === "clone") {
        await fs.mkdir(args[4] ?? "", { recursive: true });
        return "";
      }

      if (args[0] === "rev-parse") {
        return `${resolvedCommit}\n`;
      }

      return "";
    };

    const source = await resolveSourceInput("https://github.com/org/repo.git", { git });
    expect(source.requestedRef).toBeUndefined();
    expect(source.resolvedCommit).toBe(resolvedCommit);
    await source.cleanup();
  });

  it("removes temporary checkouts when Git fails", async () => {
    let scanRoot = "";
    const git: GitRunner = async (args) => {
      if (args[0] === "clone") {
        scanRoot = args[4] ?? "";
        await fs.mkdir(scanRoot, { recursive: true });
        return "";
      }

      throw new Error("missing ref");
    };

    await expect(resolveSourceInput("https://github.com/org/repo.git", { ref: "missing", git })).rejects.toThrow("missing ref");
    await expect(fs.access(scanRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts credentials from a failed clone diagnostic", async () => {
    const rawUrl = "https://USER:SECRET@github.com/org/repo.git?token=QSECRET#FRAGSECRET";
    const git: GitRunner = async (args) => {
      const scanRoot = args[4] ?? "/tmp/repo";
      // Mimic the default runner: the thrown message echoes the raw argv.
      throw new Error(
        `Command failed: git ${args.join(" ")}\nCloning into '${scanRoot}'...\nfatal: unable to access '${rawUrl}/': Failed to connect`
      );
    };

    const error = await resolveSourceInput(rawUrl, { git }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain("USER:");
    expect(message).not.toContain("SECRET");
    expect(message).not.toContain("QSECRET");
    expect(message).not.toContain("FRAGSECRET");
    expect(message).not.toContain("token=");
    expect(message).toMatch(/clone/);
    expect(message).toContain("git+https://github.com/org/repo.git");
    expect(message).toMatch(/Failed to connect/);
  });

  it("redacts credentials when the --ref fetch fails after a successful clone", async () => {
    const rawUrl = "https://USER:SECRET@github.com/org/repo.git?token=QSECRET";
    const git: GitRunner = async (args) => {
      if (args[0] === "clone") {
        await fs.mkdir(args[4] ?? "", { recursive: true });
        return "";
      }
      if (args[0] === "fetch") {
        throw new Error(`Command failed: git fetch ${args.slice(1).join(" ")} from '${rawUrl}': Authentication failed`);
      }
      return "";
    };

    const error = await resolveSourceInput(rawUrl, { ref: "v9.9.9", git }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain("USER:");
    expect(message).not.toContain("SECRET");
    expect(message).not.toContain("QSECRET");
    expect(message).toMatch(/fetch/);
    expect(message).toContain("git+https://github.com/org/repo.git");
    expect(message).toContain("v9.9.9");
    expect(message).toMatch(/Authentication failed/);
  });

  it("redacts credentials from a real unreachable clone without an injected runner", async () => {
    const rawUrl = "https://USER:SECRET@127.0.0.1:1/org/repo.git?token=QSECRET";
    const error = await resolveSourceInput(rawUrl).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain("USER:");
    expect(message).not.toContain("SECRET");
    expect(message).not.toContain("QSECRET");
    expect(message).toContain("git+https://127.0.0.1:1/org/repo.git");
  }, 30000);
});
