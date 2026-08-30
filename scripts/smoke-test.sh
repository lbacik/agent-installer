#!/usr/bin/env bash
#
# Verifies the shape of the published package, not the source tree.
#
# The unit tests import from src/ and therefore cannot catch the failures that
# only appear after publishing: a path missing from "files", a lost shebang on
# the bin entry, or a runtime dependency left in devDependencies. This packs the
# tarball, installs it into a clean project, and drives the CLI as a user would.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$repo_root"
# npm pack runs the prepare script, so dist/ is rebuilt from current sources.
tarball="$work/$(npm pack --pack-destination "$work" | tail -1)"

mkdir -p "$work/consumer"
cd "$work/consumer"
npm init -y > /dev/null
npm install --no-audit --no-fund "$tarball" > /dev/null

cli="$work/consumer/node_modules/.bin/agent-installer"
if [ ! -x "$cli" ]; then
  echo "smoke: bin entry agent-installer was not installed or is not executable" >&2
  exit 1
fi

# A source repository holding one artifact of each supported kind.
fixture="$work/fixture"
mkdir -p "$fixture/skills/demo" "$fixture/prompts"
cat > "$fixture/skills/demo/SKILL.md" <<'MD'
---
name: demo
description: Demo skill used by the package smoke test.
---

Demo body.
MD
printf '# Demo prompt\n\nBody.\n' > "$fixture/prompts/demo-prompt.md"

# HOME is redirected so the smoke test can never read or write the real
# ~/.agents or ~/.claude store, on a runner or on a developer machine.
export HOME="$work/home"
mkdir -p "$HOME"

"$cli" --help > /dev/null

output="$("$cli" scan "$fixture")"
echo "$output"

for expected in "skill:demo" "prompt:demo-prompt"; do
  if ! printf '%s\n' "$output" | grep -q "$expected"; then
    echo "smoke: scan output did not report $expected" >&2
    exit 1
  fi
done

echo "smoke: packed CLI installed and scanned the fixture repository"
