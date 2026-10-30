#!/usr/bin/env bash
#
# validate-docs-live.sh — hit every docs route on the deployed GitHub Pages site
# and assert it returns 200 with real content (not a 404 shell). Proves the
# deployed docs serve correctly end-to-end. Does NOT judge visual layout — that
# still needs a human eyeball (`make site-dev`).
#
# Usage:  bash scripts/validate-docs-live.sh [BASE_URL]
#         BASE_URL defaults to the project Pages URL.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${1:-https://dshakes.github.io/pal/docs}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

pass=0; fail=0; faillist=""
while IFS= read -r f; do
  r="${f#./docs/}"; r="${r%.mdx}"; r="${r%.md}"; r="${r%index}"; r="${r%/}"
  [ "$f" = "./docs/index.mdx" ] && r=""
  url="$BASE/$r/"; [ -z "$r" ] && url="$BASE/"
  code=$(curl -s -o "$TMP" -w "%{http_code}" -L "$url")
  size=$(wc -c < "$TMP" | tr -d ' ')
  if [ "$code" = "200" ] && [ "$size" -gt 800 ]; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); faillist="$faillist\n  $code ${size}b  $url"
  fi
done < <(cd "$ROOT/site/src/content/docs" && find . \( -name "*.md" -o -name "*.mdx" \) | sort)

echo "docs live check ($BASE): $pass OK / $fail bad"
if [ "$fail" -gt 0 ]; then
  printf "%b\n" "$faillist"
  echo "❌ some docs routes do not serve correctly"
  exit 1
fi
echo "✅ every docs route serves 200 with real content"
