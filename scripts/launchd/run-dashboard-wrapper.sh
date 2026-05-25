#!/usr/bin/env bash
# Run the Lantern Next.js dashboard. Waits for the API to be reachable
# so we don't show "API offline" banners during boot.

set -euo pipefail
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
cd "$REPO_ROOT/apps/web"

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
