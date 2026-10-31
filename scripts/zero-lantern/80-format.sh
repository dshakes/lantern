#!/usr/bin/env bash
# Step 80 — re-format only what the rename touched. Import paths changed
# (github.com/dshakes/pal sorts differently), identifiers changed length and
# step 10 left imports unused, so: goimports (gofmt + unused-import removal),
# cargo fmt per crate, ruff (import order + format) on touched Python files.
source "${ZL_HERE:?}/lib.sh"

# Mid-merge, compare with the incoming master itself (so files master changed
# but this branch did not are left alone); otherwise with the merge base.
base="$(git rev-parse -q --verify MERGE_HEAD || git merge-base HEAD "${ZL_BASE:-origin/master}")"
changed() { git diff --name-only --diff-filter=AMR "$base" -- "$@" | while read -r f; do [[ -f "$f" ]] && printf '%s\n' "$f"; done; }

tools="${ZL_TOOLS:-${XDG_CACHE_HOME:-$HOME/.cache}/zero-lantern/bin}"
[[ -x "$tools/goimports" ]] || GOBIN="$tools" go install golang.org/x/tools/cmd/goimports@v0.38.0

gofiles="$(changed '*.go' | grep -v '^gen/' || true)"
if [[ -n "$gofiles" ]]; then
  printf '%s\n' "$gofiles" | tr '\n' '\0' | xargs -0 "$tools/goimports" -w
  printf '%s\n' "$gofiles" | tr '\n' '\0' | xargs -0 gofmt -l | grep . && zl_fail "gofmt still unhappy"
fi

for m in services/*/Cargo.toml packages/*/Cargo.toml; do
  [[ -f "$m" ]] || continue
  [[ -n "$(changed "$(dirname "$m")")" ]] || continue
  cargo fmt --manifest-path "$m"
done

pyfiles="$(changed '*.py' || true)"
if [[ -n "$pyfiles" ]] && command -v ruff >/dev/null; then
  printf '%s\n' "$pyfiles" | tr '\n' '\0' | xargs -0 ruff check -q --fix --select I,F401 || true
  printf '%s\n' "$pyfiles" | tr '\n' '\0' | xargs -0 ruff format -q
fi
zl_note "formatted"
