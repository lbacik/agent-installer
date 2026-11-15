# Content identity

Every install reconciles Base Store copies against a freshly verified content identity: a named hash algorithm, a
digest, and the complete per-file inventory the digest was computed from. The v3 install report (`install
--json --json-schema 3`) carries that identity per requested artifact, and the state file records the algorithm and
overlays alongside the hashes.

## Algorithms

- Skills use `agent-installer-tree-v2` (ADR 0005): a length-framed SHA-256 tree encoding over the skill directory.
- Prompts use `sha256`: plain SHA-256 over the raw file bytes.

Hashes of different algorithms are never compared with each other. A skill entry migrated from state v3 is labelled
`agent-installer-tree-v1` (the pre-framing encoding) until the next install writes or refreshes it, and `list`
compares an entry's own two stored hashes -- which always share one algorithm -- so a migrated entry never reports
drift merely because its algorithm label changed. Reconciliation itself recomputes both the expected and the
installed identities with the current algorithm on every run, so no reinstall is forced by the encoding change.

## `agent-installer-tree-v2` byte encoding

The digest is SHA-256 over the concatenation of:

1. the domain separator `agent-installer-tree-v2` followed by a NUL byte;
2. for every content file, in UTF-8 byte order of its `/`-separated relative path:
   `path <path-byte-length> NUL <path bytes> NUL mode <x|-> NUL content <content-byte-length> NUL <content bytes>
   NUL`,
   where lengths are decimal ASCII byte counts and the mode records only whether any executable bit is set.

Every path and every content byte string is length-prefixed and NUL-delimited, so distinct trees can never produce
the same byte stream. In particular the pre-v1 framing fed path, flag, and raw bytes into one stream with no length
framing, so the trees `{a: "Xb\n-\nY"}` and `{a: "X", b: "Y"}` hashed identically; under v2 they differ.

## Inclusion and exclusion rules

- The walk covers regular content files only: dotfiles and nested files are included.
- The installer ownership marker is excluded: `.agent-installer.json` inside a skill directory never contributes to
  the digest or the inventory. A prompt's marker is a sibling file (`<name>.md.agent-installer.json`) and is never
  hashed either, since prompts hash the single artifact file.
- Symlinks inside skill directories are refused: a symlink encountered during the walk aborts the run with a
  source-configuration error instead of hashing link-target-dependent bytes.
- Only the executable bit is hashed, not the full POSIX mode, so digests do not depend on the process umask or on
  group/other permission noise. A prompt inventory entry always reports `executable: false`: the prompt digest is
  over file bytes alone.

## The `files[]` inventory

`files[]` is a complete inventory of the Base Store copy's regular content files, produced by the same fresh walk as
the digest, so the inventory and `installedHash` always describe the same bytes. Each entry carries `path` (the
`/`-separated path relative to the artifact root; a prompt has a single entry, the file name), `sha256` over the raw
file bytes, and `executable`. Entries sort by UTF-8 byte order of `path` -- byte order, not UTF-16 code-unit order,
so non-ASCII and non-BMP names order deterministically across runtimes. Overlay-generated files are included (they
are part of the hashed content); the ownership marker is the only exclusion.

## The prompt `sha256` rule

A prompt's content identity is `{algorithm: "sha256", digest: <hex of the file bytes>, files: [<single entry>]}`. No
overlay kind applies to prompts: prompt state entries always record `overlays: []`, and prompt reports always carry
an empty `overlays[]`.

## Expected hash versus pristine upstream

`expectedHash` is the source files **plus any installer overlays** (see below). It is not a pristine upstream-tree
hash: for a skill whose Codex invocation policy was materialized, the expected digest covers the generated or merged
`agents/openai.yaml` exactly as it lands in the Base Store. After writing, install rehashes the Base Store copy and
compares it with the expected hash; a mismatch fails the artifact with code `verification-failed`. Consumers must
never present `expectedHash` as the hash of the upstream source tree.

## Offline verification

`verify --only <artifact-id>` rehashes each selected Base Store copy with the
same walker and rules described above and compares the fresh digest against
the recorded installed hash of the recorded algorithm -- never against the
current source, which is never contacted. A skill entry still recorded as
`agent-installer-tree-v1` cannot be verified this way: the pre-framing digest
is collidable (ADR 0005), so it is refused with `unsupported-algorithm` until
a reinstall at the recorded commit re-records it as `agent-installer-tree-v2`.
The `files[]` inventory in a verify report comes from the same fresh walk as
the reported `installedHash`, exactly like the install report.

## Overlay registry

Installer transformations applied to an artifact before hashing and writing. Exactly one overlay exists today:

| id | version | paths | effect |
| -- | ------- | ----- | ------ |
| `codex-invocation-policy` | 1 | `["agents/openai.yaml"]` | `added` when the source has no `agents/openai.yaml` (the file is generated); `modified` when an authored one is merged |

`effect` is per-run: it depends on the source (whether an authored `agents/openai.yaml` was present), so it cannot
be derived offline and is recorded in state v4 alongside each managed entry. Skill entries migrated from state v3
record `overlays: null` (unknown) until the next install writes or refreshes them; prompt entries record `[]`.
