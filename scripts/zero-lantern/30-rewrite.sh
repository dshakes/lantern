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

left="$(git grep -I -i -l lantern -- . "${ZL_EXCLUDES[@]}" | grep -v -E '^(services/control-plane/internal/handlers/signals(_test)?\.go|apps/web/app/api/signals/route\.ts)$' || true)"
[[ -z "$left" ]] || zl_fail "content still mentions the old name:
$left"
zl_note "content rewritten"
