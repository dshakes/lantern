#!/usr/bin/env bash
# Run the Lantern Next.js dashboard. Waits for the API to be reachable
# so we don't show "API offline" banners during boot.

set -euo pipefail
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
cd "$REPO_ROOT/apps/web"

# Self-heal a corrupted dev build cache. When launchd restarts the dashboard
# after a crash/kill, the Next.js dev server can be left with half-written
# .next/**/*.tmp files, which make every request 500 ("ENOENT ... _buildManifest
# .js.tmp") until .next is cleared by hand. Clearing on each start guarantees a
# clean compile — cheap for an always-on service that restarts rarely.
echo "[$(date +%T)] clearing .next to avoid a stale/corrupted dev cache"
rm -rf .next

# Wait up to 60s for the API.
for i in {1..30}; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/healthz | grep -q 200; then
    echo "[$(date +%T)] api reachable (after ${i}x2s)"
    break
  fi
  sleep 2
done

# node_modules might not exist on a freshly-cloned repo.
if [[ ! -d node_modules ]]; then
  echo "[$(date +%T)] installing dashboard deps…"
  npm install --silent
fi

echo "[$(date +%T)] starting Next.js dashboard on :3001"
exec npm run dev
