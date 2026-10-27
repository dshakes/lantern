#!/usr/bin/env bash
# Gate for docs/assets/diagrams: every diagram parses, carries the shared
# lx-style v1 block (docs/brand/diagram-template.svg), declares an accessible
# title, and prefixes its ids with its own file name so diagrams inlined into
# one page never collide.
set -euo pipefail
dir="${1:-docs/assets/diagrams}"
fail=0
for f in "$dir"/*.svg; do
  n=$(basename "$f" .svg)
  xmllint --noout "$f" || { echo "FAIL parse: $f"; fail=1; continue; }
  grep -q 'class="lx-style"' "$f" || { echo "FAIL no lx-style block: $f"; fail=1; }
  grep -q '<title id=' "$f" || { echo "FAIL no <title>: $f"; fail=1; }
  bad=$(grep -o ' id="[^"]*"' "$f" | sed 's/ id="//; s/"$//' | grep -v "^$n-" || true)
  [ -z "$bad" ] || { echo "FAIL ids not prefixed '$n-' in $f: $bad"; fail=1; }
done
[ "$fail" = 0 ] && echo "diagrams ok: $(ls "$dir"/*.svg | wc -l | tr -d ' ') files"
exit "$fail"
