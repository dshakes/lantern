#!/usr/bin/env bash
# Step 70 — install the hand-written replacements: ADR 0032 rewritten as a
# completed decision (it cannot be produced by the mechanical rewrite, which
# would turn "rename X to PAL" into "rename PAL to PAL"), and the strict brand
# allowlist (only the gate, the codemod and the DB rename migration).
source "${ZL_HERE:?}/lib.sh"

cp "$ZL_HERE/assets/adr-0032.md" docs/adr/0032-rename-to-pal.md
cp "$ZL_HERE/assets/brand-allowlist.txt" scripts/brand-allowlist.txt
git add docs/adr/0032-rename-to-pal.md scripts/brand-allowlist.txt

cmp -s "$ZL_HERE/assets/adr-0032.md" docs/adr/0032-rename-to-pal.md || zl_fail "ADR 0032 not installed"
zl_note "ADR 0032 and strict allowlist installed"
