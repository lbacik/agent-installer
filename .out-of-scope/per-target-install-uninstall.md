# Per-target scoping for install and uninstall

`install` and `uninstall` do not accept a target selector (such as
`--only-target <name>`). They always act on every `config.yaml` target that
declares the artifact's kind. Selecting a subset of targets is `sync`'s job.

## Why this is out of scope

`config.yaml` is the declaration of desired exposures (ADR 0004). Each
configured target that declares an artifact's kind is supposed to hold one
exposure symlink for it, and reconciliation enforces that: a missing configured
exposure makes the artifact `installed-different`, not `installed-same`.

A per-target scope on these two commands works against that model:

- **`uninstall --only-target X`** would remove an exposure that the config
  still asks for. The artifact would then show as drifted, and the next
  `install` or `sync` would put the symlink back. To stop exposing artifacts
  at a target, change the config and let `sync` converge:

  ```sh
  # remove target X from config.yaml, or drop its `skills`/`prompts` key
  agent-installer sync --target X
  ```

  `sync --target` accepts a name that is no longer in `config.yaml` as long as
  a recorded exposure still references it, so you can clean up orphans by name.

- **`install --only-target X`**: `sync --target X` already covers the exposure
  part. It creates missing exposures and moves stale ones for managed
  artifacts, without contacting the source. The only new behavior would be
  "update base-store content, but refresh exposures at X only". That leaves
  every other target reported as drifted, which is a state the tool should
  not create on purpose.

So targets are not consumers you install into one by one. They are where the
single canonical install is exposed, and the config alone decides that.

## Prior requests

- #44: "Support --only-target to select exposure targets for install/uninstall"
