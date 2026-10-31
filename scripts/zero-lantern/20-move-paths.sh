#!/usr/bin/env bash
# Step 20 — git mv every tracked path whose name contains the old brand
# (packages/proto/<old>/v1 -> packages/proto/pal/v1, gen/go/<old>/v1, launchd
# plists, diagrams, the ADR 0032 file name). Collisions abort: step 10 already
# removed the legacy twins (cmd/<old>, the python shim).
source "${ZL_HERE:?}/lib.sh"

newname() {
  perl -pe 's/0032-rename-lantern-to-pal/0032-rename-to-pal/g; s/lantern/pal/g; s/Lantern/PAL/g; s/LANTERN/PAL/g'
}

moved=0
while IFS= read -r -d '' f; do
  case "$f" in scripts/zero-lantern/*) continue ;; esac
  n="$(printf '%s' "$f" | newname)"
  [[ "$n" != "$f" ]] || continue
  [[ ! -e "$n" ]] || zl_fail "cannot move $f: $n already exists"
  mkdir -p "$(dirname "$n")"
  git mv -k -- "$f" "$n"
  moved=$((moved + 1))
done < <(git ls-files -z | perl -0ne 'print if /lantern/i')

# Remove now-empty directories left behind.
find . -path ./.git -prune -o -type d -empty -iname '*lantern*' -print 2>/dev/null | while read -r d; do rmdir -p "$d" 2>/dev/null || true; done
zl_note "moved $moved paths"

left="$(git ls-files | grep -i lantern | grep -v -E '^scripts/zero-lantern/' || true)"
[[ -z "$left" ]] || zl_fail "paths still carry the old name:
$left"
