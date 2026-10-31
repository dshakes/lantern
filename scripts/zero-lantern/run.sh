#!/usr/bin/env bash
# zero-lantern — finish the PAL rename (ADR 0032): remove every remaining use of
# the previous brand from code, docs, file names and generated code.
#
#   scripts/zero-lantern/run.sh            # run every step, then verify
#   scripts/zero-lantern/run.sh 30 60      # run only these steps (then verify)
#
# Each step is idempotent: re-running on a tree that is already renamed is a
# no-op, so the codemod can be re-run after every `git merge origin/master`.
# Each step verifies its own postcondition and exits non-zero if it is not met.
#
# Steps:
#   10 remove-compat   delete the env-compat layers, legacy aliases and shims
#   20 move-paths      git mv every tracked path containing the old name
#   30 rewrite         ordered content rewrite over every tracked text file
#   40 dedupe          collapse the now-identical dual reads (PAL_X || PAL_X)
#   50 migration       add (or renumber) the DB rename migration
#   60 codegen         regenerate gen/go from the protos, refresh Cargo.lock
#   70 assets          install the rewritten ADR 0032 and the strict allowlist
#   80 format          gofmt / cargo fmt / ruff format on the touched files
#   90 verify          brand-check --enforce + proto reproducibility
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
cd "$root"
export ZL_ROOT="$root" ZL_HERE="$here"

steps=("$@")
[[ ${#steps[@]} -gt 0 ]] || steps=(10 20 30 40 50 60 70 80)

for s in "${steps[@]}"; do
  script="$(ls "$here"/"$s"-*.sh 2>/dev/null | head -1)"
  [[ -n "$script" ]] || { echo "zero-lantern: no step $s" >&2; exit 2; }
  echo "==> step $(basename "$script")"
  bash "$script"
done
echo "==> step 90-verify.sh"
bash "$here/90-verify.sh"
