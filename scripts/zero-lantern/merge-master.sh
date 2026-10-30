#!/usr/bin/env bash
# merge-master.sh — merge the latest master into the rename branch without
# hand-resolving rename conflicts, then re-run the codemod.
#
#   scripts/zero-lantern/merge-master.sh [ref]      # default origin/master
#
# A file both sides touched conflicts only because this branch renamed what
# master edited. So for each conflicted file the base and master ("theirs")
# stages are run through the SAME rename + dedupe rules first, and the 3-way
# merge is redone on the rewritten stages: what is left is a real conflict
# (a hand fix here vs a change there on the same lines) and is reported.
# Generated/derived files are not merged at all — they are rebuilt by the
# codemod (gen/go, Cargo.lock) or re-installed from assets (ADR 0032, the
# allowlist). Ends by running every codemod step; does NOT commit.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
cd "$root"
ref="${1:-origin/master}"

[[ -z "$(git status --porcelain)" ]] || { echo "merge-master: working tree not clean" >&2; exit 2; }
git fetch -q origin
git merge --no-ff --no-commit "$ref" >/dev/null 2>&1 || true

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unresolved=()

ours_wins='^(scripts/brand-(check\.sh|allowlist\.txt)|docs/adr/0032-[^/]*\.md|scripts/zero-lantern/.*)$'
regen='^(gen/go/.*\.pb\.go|.*/Cargo\.lock)$'

while IFS= read -r p; do
  [[ -n "$p" ]] || continue
  has() { git cat-file -e ":$1:$p" 2>/dev/null; }
  if [[ "$p" =~ $ours_wins ]]; then
    if has 2; then git checkout --ours -- "$p" && git add -- "$p"; else git rm -q -- "$p"; fi
    continue
  fi
  if [[ "$p" =~ $regen ]]; then
    # Take master's copy; step 60 regenerates (gen/go is replaced wholesale,
    # Cargo.lock re-resolved after the rewrite renames the crates).
    if has 3; then git checkout --theirs -- "$p" && git add -- "$p"; else git rm -q -- "$p"; fi
    continue
  fi
  if ! has 2; then
    if has 1; then
      # Deleted here (a compat layer / legacy twin step 10 removes) while
      # master changed it: it stays deleted.
      git rm -q -- "$p" 2>/dev/null || true
    else
      # Added by master (e.g. a file landing in a directory this branch
      # renamed): take it; steps 20/30 rename it below.
      git checkout --theirs -- "$p" && git add -- "$p"
    fi
    continue
  fi
  if ! has 3; then
    if has 1; then git rm -q -- "$p"; else git add -- "$p"; fi
    continue
  fi
  if ! has 1; then
    # Both added: rewrite theirs and 2-way it against ours with an empty base.
    : > "$tmp/base"
  else
    git show ":1:$p" > "$tmp/base"
  fi
  git show ":2:$p" > "$tmp/ours"
  git show ":3:$p" > "$tmp/theirs"
  ZL_PATH="$p" perl -0pi "$here/compat.pl" "$tmp/base" "$tmp/theirs"
  ZL_PATH="$p" perl -0pi "$here/rewrite.pl" "$tmp/base" "$tmp/theirs"
  perl -0pi "$here/dedupe.pl" "$tmp/base" "$tmp/theirs"
  if git merge-file -L ours -L base -L master -p "$tmp/ours" "$tmp/base" "$tmp/theirs" > "$tmp/merged"; then
    cat "$tmp/merged" > "$p"
    git add -- "$p"
  else
    cat "$tmp/merged" > "$p"
    unresolved+=("$p")
  fi
done < <(git diff --name-only --diff-filter=U)

if [[ ${#unresolved[@]} -gt 0 ]]; then
  echo "merge-master: real conflicts left (resolve, git add, then re-run run.sh):" >&2
  printf '  %s\n' "${unresolved[@]}" >&2
  exit 1
fi

bash "$here/run.sh"
echo "merge-master: merged $ref and re-ran the codemod; review, build, then commit."
