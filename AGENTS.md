# AGENTS

## Purpose

This repository contains `agent-installer`, a TypeScript CLI that installs local agent artifacts for:

- Codex
- Claude Code

The tool scans a local repository, copies managed artifacts into `~/.agents`, and exposes Claude-compatible entries through per-artifact symlinks in `~/.claude`.

## Artifact Model

There are two artifact kinds:

- `skill`: a directory under `skills/<name>` that contains `SKILL.md`
- `prompt`: a Markdown file under `prompts/<name>.md` or `commands/<name>.md`

Current behavior:

- Codex support is skills only.
- Claude Code support is skills plus prompt-backed commands.
- If both `prompts/foo.md` and `commands/foo.md` exist, scanning fails with a duplicate-name error.

## Source Conventions

The CLI scans the current working directory by default. A source path may also be passed explicitly.

Expected layout:

```text
repo/
  skills/
    review/
      SKILL.md
  prompts/
    commit-message.md
  commands/
    release-notes.md
```

There is no manifest in v1. Discovery is convention-based.

## Managed Layout

Canonical copies live under `~/.agents`:

- `~/.agents/skills/<name>/...`
- `~/.agents/prompts/<name>.md`

Generated managed content:

- `~/.agents/skills/<name>/agents/openai.yaml` is materialized when the source `SKILL.md` frontmatter sets the top-level boolean `disable-model-invocation: true`. It carries `policy.allow_implicit_invocation: false` so Codex matches the Claude invocation intent. The source repository is never modified.
- When such a skill also ships an authored `agents/openai.yaml`, the managed copy retains that file (unrelated keys, sibling `policy` keys, and comments) and only overrides `policy.allow_implicit_invocation`. The file is re-serialized, so formatting may be normalized; an empty `policy:` key is filled in rather than rejected. The Claude setting takes precedence over a conflicting authored policy. Authored metadata that is not a YAML mapping, or whose `policy` is not a mapping, aborts with a source-configuration error before the managed target is created or changed. Skills whose frontmatter does not enable the translation are never validated.

Claude exposure paths:

- `~/.claude/skills/<name>` -> symlink to `~/.agents/skills/<name>`
- `~/.claude/commands/<name>.md` -> symlink to `~/.agents/prompts/<name>.md`

State and ownership metadata:

- state file: `~/.agents/agent-installer/state.json`
- marker files:
  - skill: `<basePath>/.agent-installer.json`
  - prompt: `<basePath>.agent-installer.json`

Do not change the base-store-first model without also revisiting [docs/adr/0001-agents-as-canonical-store.md](/Volumes/Sources/js/ts/ai-skill-installer/docs/adr/0001-agents-as-canonical-store.md:1).

## CLI Surface

Implemented commands:

- `agent-installer [path]`
  - interactive mode
  - scans the source, shows status, and lets the user keep or remove installed artifacts
- `agent-installer scan [path]`
  - prints discovered artifact status only
- `agent-installer install [path] --all`
  - non-interactive install or update of all eligible artifacts
- `agent-installer uninstall <ids...>`
  - removes managed artifacts by id, for example `skill:review`
- `agent-installer list`
  - prints managed entries from state

## Status Model

Artifacts are reconciled into these states:

- `new`
- `installed-same`
- `installed-different`
- `source-missing`
- `conflict`

Meaning:

- `new`: not installed yet
- `installed-same`: managed install matches the source content hash
- `installed-different`: managed install exists but source content changed
- `source-missing`: previously managed entry is no longer present in the currently scanned source repository
- `conflict`: target path exists but is not managed by this tool, or the Claude exposure symlink points elsewhere

Reconciliation has no status for an unusable source. A skill whose Claude frontmatter enables the Codex invocation-policy translation but whose authored `agents/openai.yaml` cannot be parsed aborts the whole run, including `scan`, with a source-configuration error, so no managed artifact is created or changed from an ambiguous configuration.

## Important Invariants

- `~/.agents` is the canonical store. Do not install directly into `~/.claude`.
- Never symlink the entire `~/.claude/skills` or `~/.claude/commands` directory.
- Only create per-artifact symlinks in `~/.claude`.
- Refuse unmanaged conflicts by default. Do not silently overwrite user-owned files.
- Source scoping matters for cleanup. `source-missing` must only apply to entries owned by the currently scanned repository.
- Hash comparisons define whether an artifact is unchanged or requires update.

## Project Structure

- [src/cli.ts](/Volumes/Sources/js/ts/ai-skill-installer/src/cli.ts:1): command parsing and top-level flows
- [src/source.ts](/Volumes/Sources/js/ts/ai-skill-installer/src/source.ts:1): source scanning
- [src/install.ts](/Volumes/Sources/js/ts/ai-skill-installer/src/install.ts:1): reconciliation, install, uninstall
- [src/state.ts](/Volumes/Sources/js/ts/ai-skill-installer/src/state.ts:1): persisted managed state
- [src/paths.ts](/Volumes/Sources/js/ts/ai-skill-installer/src/paths.ts:1): target-path resolution
- [src/hash.ts](/Volumes/Sources/js/ts/ai-skill-installer/src/hash.ts:1): content hashing, including the materialized overlay used for expected source hashes
- [src/skill-invocation-policy.ts](/Volumes/Sources/js/ts/ai-skill-installer/src/skill-invocation-policy.ts:1): Claude-to-Codex invocation policy translation
- [src/interactive.ts](/Volumes/Sources/js/ts/ai-skill-installer/src/interactive.ts:1): interactive selection UI

## Working Rules

- Keep the implementation Node-based and TypeScript-first.
- Prefer extending the existing scanner and reconciliation flow instead of adding parallel install logic.
- Keep tests behavioral. Exercise public flows rather than internal helpers where practical.
- Preserve ASCII-only file content unless there is a real need otherwise.

## Verification

Run these before closing work:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm test:package`

`pnpm test:package` packs the tarball, installs it into a clean project, and
runs the CLI against a fixture repository. It catches packaging faults the unit
tests cannot see, such as a path missing from `files`, a lost bin shebang, or a
runtime dependency left in `devDependencies`. It redirects `HOME`, so it never
touches the real `~/.agents` store.

Key tests live in:

- [tests/scanner.test.ts](/Volumes/Sources/js/ts/ai-skill-installer/tests/scanner.test.ts:1)
- [tests/install.test.ts](/Volumes/Sources/js/ts/ai-skill-installer/tests/install.test.ts:1)

## Release

CI runs typecheck, tests, build, and the package smoke test on Node 20, 22, and
24 for every pull request. Publishing is automated: pushing a `v*` tag runs
[.github/workflows/release.yml](/Volumes/Sources/js/ts/ai-skill-installer/.github/workflows/release.yml:1),
which publishes to npm through OIDC trusted publishing. There is no npm token in
the repository.

The release workflow refuses to publish unless the tag is an ancestor of `main`
and the tag name matches `version` in `package.json`.

`main` is protected by a repository ruleset: it takes pull requests only, and the
three `verify` checks must pass. So the version bump belongs on `develop` and
reaches `main` through a pull request. Do not run `pnpm version` on `main`; a
direct push there is rejected. Tag the merge commit on `main` afterwards.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `lbacik/agent-installer`, managed via the `gh` CLI. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See [docs/agents/domain.md](docs/agents/domain.md).
