#!/usr/bin/env bash
# Step 40 — collapse the dual reads the rewrite made identical. During the
# transition code read "PAL_X, else the old name"; after step 30 both halves
# say PAL_X. Each rule only fires when both sides are textually the same
# variable, so it cannot change behaviour:
#   ${PAL_X:-${PAL_X:-d}}            -> ${PAL_X:-d}        (shell, also := and nested)
#   (process.env.PAL_X || process.env.PAL_X)   -> process.env.PAL_X   (|| and ??)
#   os.environ.get("PAL_X") or os.environ.get("PAL_X", d) -> os.environ.get("PAL_X", d)
#   cmp.Or(os.Getenv("PAL_X"), os.Getenv("PAL_X"))       -> os.Getenv("PAL_X")
#   getenv("PAL_X", getenv("PAL_X", d))                   -> getenv("PAL_X", d)
#   .Values.a.env.PAL_X | default .Values.a.env.PAL_X     -> .Values.a.env.PAL_X
#   vars.PAL_X || vars.PAL_X / secrets.PAL_X || secrets.PAL_X
#   (pal|pal)                                             -> pal
#   "PAL_X", "PAL_X" (adjacent list entries)              -> "PAL_X"
source "${ZL_HERE:?}/lib.sh"

list="$(git grep -I -l -E 'PAL_|pal' -- . "${ZL_EXCLUDES[@]}" || true)"
[[ -n "$list" ]] || exit 0
printf '%s\n' "$list" | while IFS= read -r f; do [[ -L "$f" ]] || printf '%s\0' "$f"; done |
  xargs -0 -n 200 perl -0pi "$ZL_HERE/dedupe.pl"

left="$(git grep -n -I -E '\$\{(PAL_[A-Z0-9_]+):[-=]\$\{\1[:}]|process\.env\.(PAL_[A-Z0-9_]+) *(\|\||\?\?) *process\.env\.\3\b|\(pal\|pal\)' -- . "${ZL_EXCLUDES[@]}" || true)"
[[ -z "$left" ]] || zl_fail "dual reads left:
$left"
zl_note "dual reads collapsed"
