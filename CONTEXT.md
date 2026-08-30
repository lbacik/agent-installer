# Agent Installer

Installs user-authored agent artifacts from a local source repository into canonical local targets for Codex and Claude Code.

## Language

**Artifact**:
A managed item discovered in a source repository and installed into local agent directories.
_Avoid_: asset, package item

**Skill**:
A directory-based artifact whose entry point is `SKILL.md`. The skill name is the basename of the directory that contains the entry point.
_Avoid_: prompt pack, plugin

**Prompt**:
A Markdown file installed into the base store and exposed to Claude Code as a command entry.
_Avoid_: template, note

**Command**:
The Claude Code-facing exposure of a prompt artifact.
_Avoid_: prompt file

**Base Store**:
The canonical managed copy of installed artifacts under `~/.agents`.
_Avoid_: cache, mirror

**Tool Exposure**:
A tool-specific path or symlink that makes a base-store artifact visible to Codex or Claude Code.
_Avoid_: duplicate copy

**Managed Artifact**:
An artifact whose installed files and metadata are owned by this CLI and may be updated or removed by it.
_Avoid_: user file

**Source Repository**:
The local directory or remote Git repository scanned for installable artifacts.
_Avoid_: registry, remote package

**Source Identity**:
The stable identifier used to scope managed state for a source repository. Local sources use the real local path; remote Git sources use a sanitized URL plus optional ref.
_Avoid_: checkout path, cache key

**Invocation Policy**:
Whether a tool may select a skill implicitly. Claude Code declares it in `SKILL.md` frontmatter as `disable-model-invocation`; Codex declares it in the skill's `agents/openai.yaml` as `policy.allow_implicit_invocation`.
_Avoid_: autoload, auto-invoke

**Overlay**:
Content the installer materializes into the base-store copy of an artifact, either adding a file the source repository does not have or replacing one it does, such as the Codex invocation policy translated from Claude frontmatter. An overlay is part of the artifact's hashed content, so an unchanged managed copy still reconciles as installed-same.
_Avoid_: patch, generated cache

**Source Path**:
The display provenance for an artifact inside its source repository, shown as the source identity plus the artifact's relative source path. For remote Git sources, this is not necessarily a live filesystem path after installation.
_Avoid_: destination, install path
