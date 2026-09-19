# `~/.agents` as the canonical managed store

The installer copies all managed artifacts into `~/.agents` first, then exposes them through per-artifact symlinks in whatever directories the user names in `~/.agents/agent-installer/config.yaml` (Claude Code's `~/.claude/skills` and `~/.claude/commands` are one such target, not a hardcoded destination). This keeps one owned source of truth for updates and uninstall, while avoiding direct duplication across tool-specific directories.
