#!/usr/bin/env bash
# Step 30 — ordered content rewrite over every tracked text file that still
# mentions the old brand. Order matters (most specific first):
#   1. one-off prose removals (README origin story, "still carries the old name")
#   2. X-<Old>-Header        -> X-Pal-Header      (HTTP header casing)
#   3. <Old>Identifier       -> PalIdentifier     (CamelCase continuation)
#      fooOldBar             -> fooPalBar
#   4. <Old> (word)          -> PAL               (brand in prose / UI)
#   5. OLD_ENV / OLD         -> PAL_ENV / PAL
#   6. old (any other case)  -> pal               (module path, proto package,
#      lanternv1, headers, paths, labels, metrics, DB role, ...)
# Symlinks and binaries are skipped (git grep -I, [[ -L ]]).
source "${ZL_HERE:?}/lib.sh"

list="$(zl_files_matching lantern)"
[[ -n "$list" ]] || { zl_note "nothing to rewrite"; exit 0; }
zl_note "$(printf '%s\n' "$list" | wc -l | tr -d ' ') files to rewrite"

printf '%s\n' "$list" | tr '\n' '\0' | xargs -0 -n 200 perl -0pi "$ZL_HERE/rewrite.pl"

# Postcondition: only the allowlisted keeps remain (brand-check is allowlist-aware).
bash scripts/brand-check.sh --enforce >/dev/null 2>&1 || { bash scripts/brand-check.sh >&2 || true; zl_fail "content still mentions the old name outside the allowlist"; }
zl_note "content rewritten"
