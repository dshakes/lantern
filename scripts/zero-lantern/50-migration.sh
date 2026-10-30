#!/usr/bin/env bash
# Step 50 — install the DB rename migration (assets/pal_brand_rename.*.sql) as
# the next free control-plane migration number. Migrations are append-only, so
# existing files are never edited for semantics; this one renames what a
# pre-rename database still carries (role, namespaces, persisted values).
#
# Idempotent: if the migration is already installed under a number no other
# migration uses, it is refreshed in place. If a migration merged from master
# took the same number, ours is moved to the next free one.
source "${ZL_HERE:?}/lib.sh"

dir=services/control-plane/internal/db/migrations
name=pal_brand_rename

cur="$(ls "$dir" | sed -n "s/^\([0-9]\{4\}\)_${name}\.up\.sql$/\1/p" | head -1)"
if [[ -n "$cur" ]]; then
  clash="$(ls "$dir" | grep -E "^${cur}_" | grep -v "_${name}\." || true)"
  if [[ -n "$clash" ]]; then
    zl_note "migration $cur clashes with: $clash — renumbering"
    git rm -q -- "$dir/${cur}_${name}.up.sql" "$dir/${cur}_${name}.down.sql"
    cur=""
  fi
fi
if [[ -z "$cur" ]]; then
  last="$(ls "$dir" | sed -n 's/^\([0-9]\{4\}\)_.*\.up\.sql$/\1/p' | sort -n | tail -1)"
  cur="$(printf '%04d' $((10#$last + 1)))"
fi
cp "$ZL_HERE/assets/${name}.up.sql" "$dir/${cur}_${name}.up.sql"
cp "$ZL_HERE/assets/${name}.down.sql" "$dir/${cur}_${name}.down.sql"
git add -- "$dir/${cur}_${name}.up.sql" "$dir/${cur}_${name}.down.sql"

# Postcondition: exactly one copy, highest-or-unique number, no duplicate versions.
n="$(ls "$dir" | grep -c "_${name}\.up\.sql$")"
[[ "$n" == 1 ]] || zl_fail "expected one ${name} migration, found $n"
dups="$(ls "$dir" | sed -n 's/^\([0-9]\{4\}\)_.*\.up\.sql$/\1/p' | sort | uniq -d)"
[[ -z "$dups" ]] || zl_fail "duplicate migration versions: $dups"
zl_note "migration ${cur}_${name} installed"
