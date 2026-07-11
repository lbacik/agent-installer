# agent-installer

`agent-installer` is a local TypeScript CLI for installing agent artifacts from a repository into Codex and Claude Code.

It is built for repositories that keep:

- skills in `skills/`
- reusable prompt or command files in `prompts/` or `commands/`

The CLI scans that repository, shows what is available, and installs the selected items into the expected local directories.

## What It Supports

- Codex skills
- Claude Code skills
- Claude Code command-style prompts

Current scope:

- local directories or HTTPS Git repositories
- convention-based scanning
- no manifest file

## Expected Repository Layout

```text
my-agent-repo/
  skills/
    review/
      SKILL.md
    engineering/
      code-review/
        SKILL.md
  prompts/
    commit-message.md
  commands/
    release-notes.md
```

Rules:

- a skill is valid only if its directory contains `SKILL.md`
- skill directories may be nested below `skills/`; the default scan depth is 3 directory levels below `skills/`
- a skill's install name is the basename of the directory containing `SKILL.md`
- duplicate skill names are rejected, even if they appear in different nested categories
- prompt and command files must be Markdown files
- `prompts/foo.md` and `commands/foo.md` cannot both exist

## Installation

Install directly from GitHub:

```bash
pnpm add -g github:lbacik/agent-installer
```

Or with npm:

```bash
npm install -g github:lbacik/agent-installer
```

For local development, install dependencies:

```bash
pnpm install
```

Build the CLI:

```bash
pnpm build
```

Run it during development:

```bash
pnpm dev
```

## Usage

From inside a source repository:

```bash
agent-installer
```

Or point it at a repository explicitly:

```bash
agent-installer /path/to/repo
```

Or point it at an HTTPS Git repository:

```bash
agent-installer https://github.com/org/agents.git
```

### Commands

Interactive install:

```bash
agent-installer [path]
```

Install interactively from a remote ref:

```bash
agent-installer https://github.com/org/agents.git --ref main
```

Limit the visible interactive list length:

```bash
agent-installer [path] --list-length 12
```

Show scan results only:

```bash
agent-installer scan [path]
```

Show scan results for a remote tag, branch, or commit:

```bash
agent-installer scan https://github.com/org/agents.git --ref v1.2.0
```

Scan deeper nested skill catalogs:

```bash
agent-installer scan [path] --skill-max-depth 5
```

Install or update everything found:

```bash
agent-installer install [path] --all
```

Install or update everything found from a remote ref:

```bash
agent-installer install https://github.com/org/agents.git --ref main --all
```

Remove managed entries by id:

```bash
agent-installer uninstall skill:review prompt:commit-message
```

Interactively list installed managed entries. Unselect entries to uninstall them:

```bash
agent-installer list
```

Limit the visible interactive list length:

```bash
agent-installer list --list-length 12
```

## Typical Workflow

1. Change into a repository that contains `skills/`, `prompts/`, or `commands/`.
2. Run `agent-installer`.
3. Review the discovered items and their statuses.
4. Keep selected items installed, update changed ones, or remove managed items that should no longer remain installed.

For remote HTTPS Git repositories, the CLI uses the installed `git` command and the user's existing HTTPS credential helpers. Remote checkouts are temporary and are removed after the command completes.

## Development

Useful commands:

```bash
pnpm typecheck
pnpm test
pnpm build
```

`AGENTS.md` is the maintainer and agent-facing document for repository rules, internal structure, and implementation invariants.
