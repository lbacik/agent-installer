import { checkbox, confirm } from "@inquirer/prompts";
import { PassThrough } from "node:stream";
import pc from "picocolors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { promptForManagedArtifactRemovals, promptForSelections } from "../src/interactive.js";
import type { ArtifactState, ManagedEntry, RemovedArtifactState } from "../src/types.js";

vi.mock("@inquirer/prompts", () => ({
  checkbox: vi.fn(),
  confirm: vi.fn()
}));

type PromptContext = { signal?: AbortSignal };
type MockPrompt = Mock<(config: unknown, context?: PromptContext) => Promise<unknown> & { cancel: () => void }>;

const checkboxMock = checkbox as unknown as MockPrompt;
const confirmMock = confirm as unknown as MockPrompt;

function promptPromise<T>(promise: Promise<T>): Promise<T> & { cancel: () => void } {
  return Object.assign(promise, { cancel: vi.fn() });
}

function promptAbortError(): Error {
  const error = new Error("Prompt aborted");
  error.name = "AbortPromptError";
  return error;
}

function makeState(id: string, status: ArtifactState["status"], conflictReason?: string): ArtifactState {
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
    managedEntry,
    ...(conflictReason === undefined ? {} : { conflictReason })
  };
}

const removedManagedEntry: ManagedEntry = {
  id: "prompt:old",
  kind: "prompt",
  name: "old",
  sourceRoot: "/repo",
  relativeSourcePath: "prompts/old.md",
  basePath: "/home/.agents/old",
  exposurePath: "/home/.claude/old",
  sourceHash: "source-hash",
  installedHash: "installed-hash",
  installedAt: "2026-07-08T00:00:00.000Z"
};

const removedEntry: RemovedArtifactState = {
  id: "prompt:old",
  kind: "prompt",
  name: "old",
  basePath: "/home/.agents/old",
  exposurePath: "/home/.claude/old",
  managedEntry: removedManagedEntry,
  status: "source-missing"
};

describe("promptForSelections", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns selected install and remove ids when prompts complete", async () => {
    checkboxMock.mockImplementation(() => promptPromise(Promise.resolve(["skill:review"])));
    confirmMock.mockImplementation(() => promptPromise(Promise.resolve(true)));

    const result = await promptForSelections(
      [makeState("skill:review", "new"), makeState("prompt:commit-message", "installed-same")],
      [removedEntry]
    );

    expect(result).toEqual({
      cancelled: false,
      installIds: ["skill:review"],
      removeIds: ["prompt:commit-message", "prompt:old"]
    });
  });

  it("disables list looping and uses the configured list length", async () => {
    checkboxMock.mockImplementation(() => promptPromise(Promise.resolve([])));

    await promptForSelections(
      [
        makeState("skill:one", "new"),
        makeState("skill:two", "new"),
        makeState("skill:three", "new"),
        makeState("skill:four", "new")
      ],
      [],
      { listLength: 2 }
    );

    expect(checkboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        loop: false,
        pageSize: 2
      }),
      expect.any(Object)
    );
  });

  it("shows conflicts in the selection list with a red marker and keeps them disabled", async () => {
    checkboxMock.mockImplementation(() => promptPromise(Promise.resolve([])));

    await promptForSelections(
      [
        makeState("skill:review", "new"),
        makeState("prompt:commit-message", "conflict", "A target path already exists but is not managed by this installer.")
      ],
      []
    );

    expect(checkboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({
          style: expect.objectContaining({
            disabledChoice: expect.any(Function)
          })
        }),
        choices: expect.arrayContaining([
          expect.objectContaining({
            name: expect.stringContaining(`${pc.red("●")} prompt:commit-message [conflict]`),
            value: "prompt:commit-message",
            checked: false,
            disabled: "A target path already exists but is not managed by this installer."
          })
        ])
      }),
      expect.any(Object)
    );

    const checkboxConfig = checkboxMock.mock.calls[0]?.[0] as { theme?: { style?: { disabledChoice?: (text: string) => string } } };
    expect(checkboxConfig.theme?.style?.disabledChoice?.("● prompt:commit-message [conflict] reason")).toContain(
      " ● prompt:commit-message [conflict] reason"
    );
  });

  it("uses the terminal height for the default list length", async () => {
    checkboxMock.mockImplementation(() => promptPromise(Promise.resolve([])));

    await promptForSelections(
      [
        makeState("skill:one", "new"),
        makeState("skill:two", "new"),
        makeState("skill:three", "new"),
        makeState("skill:four", "new"),
        makeState("skill:five", "new")
      ],
      [],
      { output: Object.assign(new PassThrough(), { rows: 7 }) }
    );

    expect(checkboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pageSize: 3
      }),
      expect.any(Object)
    );
  });

  it("cancels without selections when escape is pressed in the artifact prompt", async () => {
    const input = new PassThrough();
    checkboxMock.mockImplementation((_config, context) =>
      promptPromise(
        Promise.resolve().then(() => {
          input.emit("keypress", "", { name: "escape" });
          if (context?.signal?.aborted) {
            throw promptAbortError();
          }

          return ["skill:review"];
        })
      )
    );

    const result = await promptForSelections([makeState("skill:review", "new")], [], { input });

    expect(result).toEqual({ cancelled: true });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("cancels when escape is reported by sequence instead of name", async () => {
    const input = new PassThrough();
    checkboxMock.mockImplementation((_config, context) =>
      promptPromise(
        Promise.resolve().then(() => {
          input.emit("keypress", "\x1B", { sequence: "\x1B" });
          if (context?.signal?.aborted) {
            throw promptAbortError();
          }

          return ["skill:review"];
        })
      )
    );

    const result = await promptForSelections([makeState("skill:review", "new")], [], { input });

    expect(result).toEqual({ cancelled: true });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("cancels without cleanup removals when escape is pressed in the cleanup prompt", async () => {
    const input = new PassThrough();
    checkboxMock.mockImplementation(() => promptPromise(Promise.resolve([])));
    confirmMock.mockImplementation((_config, context) =>
      promptPromise(
        Promise.resolve().then(() => {
          input.emit("keypress", "", { name: "escape" });
          if (context?.signal?.aborted) {
            throw promptAbortError();
          }

          return true;
        })
      )
    );

    const result = await promptForSelections([makeState("skill:review", "installed-same")], [removedEntry], { input });

    expect(result).toEqual({ cancelled: true });
    expect(input.listenerCount("keypress")).toBe(0);
  });
});

describe("promptForManagedArtifactRemovals", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("preselects every managed artifact and returns the unselected ids", async () => {
    checkboxMock.mockImplementation(() => promptPromise(Promise.resolve(["skill:review"])));

    const result = await promptForManagedArtifactRemovals([
      removedManagedEntry,
      {
        ...removedManagedEntry,
        id: "skill:review",
        kind: "skill",
        name: "review",
        relativeSourcePath: "skills/review"
      }
    ]);

    expect(result).toEqual({ cancelled: false, removeIds: ["prompt:old"] });
    expect(checkboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select managed artifacts that should remain installed",
        choices: expect.arrayContaining([
          expect.objectContaining({ name: "prompt:old    /repo/prompts/old.md", checked: true }),
          expect.objectContaining({ name: "skill:review  /repo/skills/review", checked: true })
        ])
      }),
      expect.any(Object)
    );
  });

  it("cancels without removals when escape is pressed", async () => {
    const input = new PassThrough();
    checkboxMock.mockImplementation((_config, context) =>
      promptPromise(
        Promise.resolve().then(() => {
          input.emit("keypress", "", { name: "escape" });
          if (context?.signal?.aborted) {
            throw promptAbortError();
          }

          return [];
        })
      )
    );

    const result = await promptForManagedArtifactRemovals([removedManagedEntry], { input });

    expect(result).toEqual({ cancelled: true });
    expect(input.listenerCount("keypress")).toBe(0);
  });
});
