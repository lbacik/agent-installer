import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.ts");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], home: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [CLI_ENTRY, ...args], {
      env: { ...process.env, HOME: home }
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1
    };
  }
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("--version / -v", () => {
  it("prints the package.json version and exits 0 for --version", async () => {
    const home = await makeTempDir("agent-installer-cli-home-");
    const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };

    const result = await runCli(["--version"], home);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it("prints the package.json version and exits 0 for -v", async () => {
    const home = await makeTempDir("agent-installer-cli-home-");
    const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };

    const result = await runCli(["-v"], home);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });
});
