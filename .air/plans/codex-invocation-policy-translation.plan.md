## Goal

Make every installed skill whose Claude frontmatter sets `disable-model-invocation: true` automatically receive the equivalent Codex policy, `agents/openai.yaml -> policy.allow_implicit_invocation: false`, while preserving correct reconciliation, safe updates, and existing Claude exposure.

## Approach

Treat Claude’s top-level boolean as a portable invocation-intent signal and materialize a deterministic Codex-only overlay in the canonical skill copy. This is automatic—per the confirmed product decision—not a CLI option, so interactive, scan, and non-interactive install flows cannot drift. The expected hash must include that overlay; otherwise a healthy generated install would always be classified as changed because the current reconciliation compares the source tree’s hash directly with the installed tree’s hash.

The overlay will be narrowly scoped: only a literal boolean `true` enables it; no frontmatter or false/non-boolean values leave the skill unchanged. If source authors already provide `agents/openai.yaml`, merge the required policy while retaining their other Codex metadata; invalid source YAML should stop before install rather than risk corrupting it. Claude’s explicit disable setting takes precedence over a contradictory source Codex invocation policy, because it is the portable source signal being translated.

## File Changes

- **Create:** `src/skill-invocation-policy.ts` — parse a skill’s YAML frontmatter; compute the optional Codex YAML overlay; merge it into an existing `agents/openai.yaml`; and expose the overlay content/paths to installation and hashing code.
- **Modify:** [install.ts](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/src/install.ts?type=file&root=%252F) (current copy, hashing, and reconciliation flow at lines 25-190) — materialize the overlay after copying a skill and compare the installed tree with the transformed expected hash.
- **Modify:** [hash.ts](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/src/hash.ts?type=file&root=%252F) (skill directory hashing at lines 6-45) — support a deterministic in-memory file replacement/addition so the expected source hash includes generated or merged `agents/openai.yaml` without mutating the source repository.
- **Modify:** [package.json](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/package.json?type=file&root=%252F) (dependencies and verification scripts at lines 17-41) and [pnpm-lock.yaml](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/pnpm-lock.yaml?type=file&root=%252F) — add the direct YAML dependency used for standards-compliant frontmatter and OpenAI metadata handling, and lock it.
- **Modify:** [install.test.ts](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/tests/install.test.ts?type=file&root=%252F) (lifecycle coverage at lines 19-191) — add behavioral coverage for translation, merge precedence, unchanged detection, removal, and malformed source metadata.
- **Modify:** [README.md](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/README.md?type=file&root=%252F) (capability and layout documentation at lines 12-47 and workflow at lines 169-176) — document the cross-runtime mapping, output file, automatic behavior, and author precedence rules.

No CLI file change is planned: [cli.ts](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/src/cli.ts?type=file&root=%252F) already routes interactive, scan, and `install --all` through the same resolved-artifact state flow (lines 57-144), so the transformation belongs beneath that boundary. No ADR is planned: this is a reversible compatibility rule, documented in the public README, rather than a new persistence or ownership architecture.

## Implementation Steps

### Task 1: Define portable invocation-policy handling

1. Add `src/skill-invocation-policy.ts` with a single skill-focused API that reads `SKILL.md`, recognizes only top-level YAML frontmatter `disable-model-invocation: true`, and returns no overlay for all other cases.
2. In the same module, use the YAML library to construct or update the installed skill’s `agents/openai.yaml`: set `policy.allow_implicit_invocation` to boolean `false`, retain unrelated keys such as `interface` and `dependencies`, and return deterministic serialized bytes.
3. Make invalid existing source `agents/openai.yaml` a descriptive source configuration error when translation is required; do not overwrite it. Source frontmatter that does not contain the recognized boolean remains backward-compatible and is not newly validated.

### Task 2: Reconcile transformed skills correctly

1. Extend [hash.ts](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/src/hash.ts?type=file&root=%252F) so directory hashing can accept an optional normalized relative-path-to-content overlay: replace an existing source file’s content or add a virtual file, while continuing to exclude the installer marker.
2. In [install.ts](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/src/install.ts?type=file&root=%252F), calculate the expected skill hash from the source plus the policy overlay before assigning `new`, `installed-same`, or `installed-different`.
3. Update the existing copy path in [install.ts](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/src/install.ts?type=file&root=%252F) to copy first, then write the same overlay into the canonical `.agents/skills/<name>` directory before calculating `installedHash` and saving state. Prompts remain untouched.
4. Preserve current ownership and symlink behavior: [paths.ts](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/src/paths.ts?type=file&root=%252F) continues to expose each whole skill directory to Claude (lines 36-54), so Claude and Codex see the same canonical artifact and uninstall removes the generated file with its containing managed directory.
5. Add `yaml` to direct runtime dependencies in [package.json](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/package.json?type=file&root=%252F), then update the lockfile using pnpm.

### Task 3: Lock the observable behavior with behavioral tests

1. Extend the fixture builder in [install.test.ts](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/tests/install.test.ts?type=file&root=%252F) to create a skill whose `SKILL.md` has Claude frontmatter, then install it and assert that the canonical copy contains `agents/openai.yaml` with `policy.allow_implicit_invocation === false`.
2. Rescan that unchanged source and assert `installed-same`; this proves the transformed expected hash and installed hash agree.
3. Change the source setting from true to false (or remove it), rescan for `installed-different`, update, and assert the generated Codex file is absent unless it exists in the source. This proves stale derived policy is removed by normal replacement.
4. Add a source `agents/openai.yaml` fixture containing UI/dependency metadata and a contradictory policy; install and assert unrelated fields remain while the resulting policy is false. Also cover an already-false source policy so it remains semantically stable.
5. Add the safety case: with Claude disable true and malformed source `agents/openai.yaml`, the flow rejects with an actionable error and leaves the target unmanaged/unmodified.
6. Retain an ordinary skill with no frontmatter in the same tests and assert it still installs unchanged, protecting existing artifact behavior.

### Task 4: Document the compatibility contract

1. Update [README.md](air-file://fa4gdtr0k6vlh47r196i/Volumes/Sources/js/ts/ai-skill-installer/README.md?type=file&root=%252F) to state that skills remain source directories with `SKILL.md`, and add a short compatibility section mapping Claude `disable-model-invocation: true` to Codex `agents/openai.yaml` policy false.
2. State that mapping is automatic in all install modes, never writes into the source repository, preserves other authored Codex metadata, and uses the Claude setting as precedence when both hosts’ invocation declarations disagree.
3. Include a minimal source example and distinguish the output path as a generated managed-copy detail, so authors know not to add a CLI flag to obtain semantic parity.

## Acceptance Criteria

- Installing a skill whose frontmatter contains top-level boolean `disable-model-invocation: true` creates a canonical `agents/openai.yaml` with `policy.allow_implicit_invocation: false`.
- An explicit Codex skill invocation remains possible; the installed policy only disables implicit invocation, matching the Codex behavior documented by OpenAI.
- Installing a skill with no recognized Claude setting produces the same canonical files and hashes as before this change.
- A scan immediately after installing a translated skill returns `installed-same`, not `installed-different`.
- Changing or removing the Claude true setting makes the next scan report `installed-different`; updating removes a previously generated-only policy file.
- When a source `agents/openai.yaml` exists, its unrelated keys survive installation and the final invocation policy is false when Claude’s setting is true.
- When a translation-required source `agents/openai.yaml` is malformed, installation fails before modifying the managed target.
- Interactive install, `scan`, remote-source resolution, and `install --all` all use the same reconciliation result without adding a new CLI flag.
- Existing prompt installation, Claude per-artifact symlinks, source-scoped cleanup, and unmanaged-conflict rejection continue to pass their current behavioral tests.
- `pnpm typecheck`, `pnpm test`, and `pnpm build` complete successfully.

## Verification Steps

1. Run `pnpm typecheck` to validate the new policy module and hash/install type changes.
2. Run `pnpm test`; verify the new translated-skill lifecycle tests and all existing scanner, install, interactive, format, and source-workflow tests pass.
3. Run `pnpm build` to verify the CLI bundle includes the new runtime YAML dependency.
4. In an isolated temporary home and source fixture, exercise:
   - a true setting → generated policy and `installed-same` on immediate scan;
   - true → false/remove → `installed-different`, update, and generated file removal;
   - authored `agents/openai.yaml` with extra metadata → metadata retained and policy forced false;
   - malformed authored YAML → clear failure and no managed copy;
   - a plain skill and a prompt → no behavior regression.
5. Manually inspect that a Claude exposure remains a per-skill symlink to the canonical `.agents` directory, consistent with the base-store-first ADR.

## Risks & Mitigations

- **False update status caused by generated content:** hash the source plus the exact virtual overlay used during installation, and add the immediate-rescan regression test.
- **Overwriting author-provided Codex metadata:** parse and mutate only the policy node; preserve unrelated YAML data. Reject malformed YAML instead of replacing it.
- **Semantic disagreement between host declarations:** define and document the portable Claude disable flag as authoritative only when it is literal boolean true; otherwise preserve the source’s Codex configuration unchanged.
- **Dependency or YAML serialization churn:** make `yaml` a direct pinned runtime dependency, test semantic parsing rather than incidental whitespace, and record the generated output in the existing managed hash.
- **Accidentally widening scope to prompts or global Codex configuration:** keep the implementation limited to skill directories and their per-skill `agents/openai.yaml`; do not modify `~/.codex/config.toml`, CLI flags, artifact types, or the canonical-store architecture.

## Research Basis

OpenAI’s current skill documentation identifies `agents/openai.yaml` as optional skill metadata and specifies that `policy.allow_implicit_invocation: false` disables description-based invocation while explicit `$skill` invocation remains available. It also confirms that Codex loads user-local skills from `$HOME/.agents/skills` and follows symlinked skill folders. See [Build skills](https://developers.openai.com/codex/skills/).