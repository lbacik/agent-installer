Status: supersedes ADR 0001 (exposure paths only)

# Configurable multi-target tool exposure

Exposure used to be implicit and Claude-only: installing an artifact created per-artifact symlinks under `~/.claude` with no configuration involved.

Exposure locations are now named, user-configured targets in `~/.agents/agent-installer/config.yaml`. Each target declares an optional skills directory and/or prompts directory, and every configured target receives the same installed artifacts for the kinds it declares. `~/.agents` stays the sole fixed canonical store.

Exposure is therefore opt-in: with no `config.yaml`, installation produces base-store-only artifacts, including no implicit Claude exposure. Existing pre-config exposures are preserved untouched. Edits to `config.yaml` are reconciled on demand with `agent-installer sync`, without contacting a source repository.
