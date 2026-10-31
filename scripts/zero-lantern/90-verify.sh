#!/usr/bin/env bash
# Step 90 — postconditions of the whole codemod (cheap; the full build/test
# matrix is CI's job and the PR's validation section):
#   * brand-check --enforce passes (no old name outside the strict allowlist)
#   * no tracked path carries the old name
#   * gen/go/pal/v1 is exactly what protoc regenerates (no hand drift)
#   * no Go file still imports the old module path, no proto the old package
source "${ZL_HERE:?}/lib.sh"

bash scripts/brand-check.sh --enforce >/dev/null || { bash scripts/brand-check.sh; zl_fail "brand-check failed"; }

[[ -z "$(git ls-files | grep -i lantern | grep -v '^scripts/zero-lantern/' || true)" ]] || zl_fail "paths carry the old name"

before="$(git diff --stat -- gen/go/pal/v1)"
bash "$ZL_HERE/60-codegen.sh" >/dev/null
after="$(git diff --stat -- gen/go/pal/v1)"
[[ "$before" == "$after" ]] || zl_fail "gen/go/pal/v1 drifted from the protos"

[[ -z "$(git grep -l 'packages/palenv\|pal_env::' -- '*.go' '*.rs' '*go.mod' '*Cargo.toml' || true)" ]] || zl_fail "compat package references remain"
zl_note "verified: brand gate clean, paths clean, codegen reproducible"
