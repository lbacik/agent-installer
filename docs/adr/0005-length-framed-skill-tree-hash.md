# Length-framed skill tree hash

The skill tree hash feeds path, executable flag, and raw file bytes into one SHA-256 stream with newline separators
and no length framing. Distinct trees can therefore produce the same byte stream: the single-file tree
`{a: "Xb\n-\nY"}` hashes identically to the two-file tree `{a: "X", b: "Y"}` (reproduced during triage). The digest is
also reported as a bare hex string with no algorithm label, while it silently includes installer overlay files, so
consumers can mistake it for a pristine upstream-tree hash.

Skill content now hashes with the `agent-installer-tree-v2` encoding (specified in `docs/content-identity.md`): a
domain separator followed by length-prefixed, NUL-delimited path/mode/content records in UTF-8 byte order of the
relative path. Length framing makes distinct trees produce distinct byte streams by construction. The algorithm
travels with the digest as a `content.algorithm` identifier, the per-file inventory comes from the same walk, and
the registry in `docs/content-identity.md` states that the expected hash includes overlays.

Alternatives considered:

- Keep the v1 byte stream and label it: fixes the missing identifier but leaves the collision (however unlikely to
  occur naturally) in the digest used for reconciliation and drift detection.
- Hash a canonical archive (tarball) of the tree: equivalent collision resistance, but adds an archive format and its
  metadata normalization to the trust boundary for no consumer benefit.

The trade-off is a state migration: persisted entries record their hash algorithm (state v4), and entries migrated
from v3 are read as `agent-installer-tree-v1` until the next install writes or refreshes them. Hashes of different
algorithms are never compared, so no reinstall is forced.
