# Install outcome and schema v3

Install success JSON (schema v2) lists only mutated artifacts in `installed`/`updated`. An artifact reconciled as
`installed-same` appears in no bucket, so "unchanged" and "not processed" look identical. Exposure-level conflicts
skipped under `--allow-conflicts` never reach the JSON, and on abort `refused` lists only base-path conflicts. When
a run fails partway through, the error JSON reports `installed: []` even though earlier artifacts were already
written and persisted.

The install flow now returns an Install Outcome value covering every requested artifact — disposition, exposure
results, freshly verified content identity, overlays, and structured failures — and the v3 JSON report
(`install --json --json-schema 3`) renders from that value alone, with no further filesystem reads. Base-store
results are reported independently of tool exposures: conflicts, failures, and missing provenance in the base store
can never read as complete verified success, and exposure-only trouble degrades `exposureOutcome` without touching
`outcome`. This value is the seed later generalized to `scan`/`list`/`sync` and the human renderer.

Alternatives considered:

- Extend the v2 buckets in place: breaks every existing consumer's exhaustive handling of the five arrays, and still
  leaves "unchanged" indistinguishable without a new bucket — at which point it is a new schema anyway.
- Default the new report on: forces all JSON consumers to migrate at once, including coding-agent, which rejects
  unsupported interface versions. The opt-in flag keeps v2 byte-for-byte unchanged while consumers adopt v3.

The trade-off is two schemas to maintain; v2 stays frozen while v3 is the surface new consumers build on. Selection
is explicit (`--json-schema 2|3`, default 2, `--json` required), unsupported combinations fail before any work
starts, and exit codes are unchanged: `--allow-conflicts` skips still exit 0, with `outcome` carrying the verdict.
