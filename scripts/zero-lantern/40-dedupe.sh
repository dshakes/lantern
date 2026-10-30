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
source "${ZL_HERE:?}/lib.sh"

list="$(git grep -I -l -E 'PAL_|\(pal\|pal\)' -- . "${ZL_EXCLUDES[@]}" || true)"
[[ -n "$list" ]] || exit 0
printf '%s\n' "$list" | while IFS= read -r f; do [[ -L "$f" ]] || printf '%s\0' "$f"; done |
  xargs -0 -n 200 perl -0pi -e '
  1 while s/\$\{(PAL_\w+):([-=])\$\{\1:-((?:[^{}]|\$\{[^{}]*\})*)\}\}/\${$1:$2$3}/g;
  s/\$\{(PAL_\w+):-\$\{\1\}\}/\${$1}/g;
  s/\(\s*(process\.env\.PAL_\w+)\s*(?:\|\||\?\?)\s*\1\s*\)/$1/g;
  s/(process\.env\.PAL_\w+)\s*(?:\|\||\?\?)\s*\1\b/$1/g;
  s/\(\s*(os\.environ\.get\("PAL_\w+")\)\s+or\s+\1(, [^()]*(?:\([^()]*\)[^()]*)*)?\)\s*\)/$1.($2 \/\/ "").")"/ge;
  s/(os\.environ\.get\("PAL_\w+")\)\s+or\s+\1(, [^()]*(?:\([^()]*\)[^()]*)*)?\)/$1.($2 \/\/ "").")"/ge;
  s/cmp\.Or\((os\.Getenv\("PAL_\w+"\)), \1\)/$1/g;
  s/getenv\(("PAL_\w+"), getenv\(\1, ([^()]*)\)\)/getenv($1, $2)/g;
  s/getenv\(("PAL_\w+"), os\.Getenv\(\1\)\)/os.Getenv($1)/g;
  s/(\.Values\.[\w.]+\.env\.PAL_\w+) \| default \1\b/$1/g;
  s/\b((?:vars|secrets)\.PAL_\w+) \|\| \1\b/$1/g;
  s/\(pal\|pal\)/pal/g;
'

left="$(git grep -n -I -E '\$\{(PAL_[A-Z0-9_]+):[-=]\$\{\1[:}]|process\.env\.(PAL_[A-Z0-9_]+) *(\|\||\?\?) *process\.env\.\3\b|\(pal\|pal\)' -- . "${ZL_EXCLUDES[@]}" || true)"
[[ -z "$left" ]] || zl_fail "dual reads left:
$left"
zl_note "dual reads collapsed"
