# `~/.agents` as the canonical managed store

The installer copies all managed artifacts into `~/.agents` first, then exposes Claude Code entries through per-artifact symlinks in `~/.claude`. This keeps one owned source of truth for updates and uninstall, while avoiding direct duplication across tool-specific directories.
