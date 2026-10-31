#!/usr/bin/env bash
# Step 10 — remove the transition compat layers (ADR 0032 steps 1-9). After the
# rename there is one name per thing, so every "read PAL_X, fall back to the
# old name" helper, deprecated alias and legacy shim goes. Runs BEFORE the
# content rewrite: otherwise `OldClient = PalClient` would become
# `PalClient = PalClient` and the shim package would collide with `pal/`.
source "${ZL_HERE:?}/lib.sh"

# --- whole files / packages ---------------------------------------------------
zl_rm \
  packages/palenv \
  packages/pal-env-rs \
  packages/bridge-core/src/env-compat.ts \
  packages/bridge-core/src/env-compat.test.ts \
  packages/sdk-python/pal/_env.py \
  packages/sdk-python/tests/test_env.py \
  packages/sdk-python/tests/test_compat.py \
  packages/sdk-python/lantern \
  packages/sdk-ts/src/deprecated.ts \
  packages/sdk-ts/src/runtime/deprecated.ts \
  packages/sdk-ts/__tests__/deprecated-aliases.test.ts \
  packages/cli/cmd/lantern \
  services/control-plane/cmd/server/legacy_env_test.go \
  scripts/env-read-check.sh

# --- line-level surgery (compat.pl; idempotent: no match = no change) ---------
list="$(git grep -I -l -E 'palenv|pal_env|pal-env-rs|env-compat|bridgeEnv|_env\.get\(|from pal import _env|Lantern[A-Z]|deprecated\.js|lantern-run|legacyBinaryName|TestInvokedAs|install_symlink|env-read-check' -- . "${ZL_EXCLUDES[@]}" || true)"
[[ -z "$list" ]] || printf '%s\n' "$list" | while IFS= read -r f; do [[ -L "$f" ]] || printf '%s\0' "$f"; done |
  xargs -0 -n 200 perl -0pi "$ZL_HERE/compat.pl"

# --- postcondition ------------------------------------------------------------
left="$(git grep -n -E 'palenv\.(Bridge|Get)\(|pal_env::var|env-compat|bridgeEnv\(|from pal import _env|legacyBinaryName|env-read-check\.sh' -- . "${ZL_EXCLUDES[@]}" ':!:docs/**' ':!:*.md' ':!:*.mdx' | perl -ne 'print unless /^[^:]+:\d+:\s*(\/\/|#|\*|test\()/' || true)"
[[ -z "$left" ]] || zl_fail "compat references remain:
$left"
zl_note "compat layers removed"
