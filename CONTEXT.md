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
The local directory scanned for installable artifacts.
_Avoid_: registry, remote package

**Source Path**:
The original path to an artifact inside its source repository, shown as the source repository plus the artifact's relative source path.
_Avoid_: destination, install path
