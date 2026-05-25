#!/usr/bin/env bash
# Run the Lantern control-plane API. Waits for Postgres to be reachable
# before launching (launchd-spawned processes don't have a guarantee
# that the infra LaunchAgent finished, and we don't want a crash-loop
# at boot).

set -euo pipefail
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
cd "$REPO_ROOT/services/control-plane"

# Wait up to 90s for Postgres to accept TCP.
for i in {1..45}; do
  if nc -z localhost 5432 2>/dev/null; then
    echo "[$(date +%T)] postgres reachable (after ${i}x2s)"
    break
  fi
  if [[ $i -eq 45 ]]; then
    echo "[$(date +%T)] postgres never became reachable — is docker-compose up?" >&2
    exit 1
  fi
  sleep 2
done

echo "[$(date +%T)] starting control-plane API on :8080"
exec /opt/homebrew/bin/go run ./cmd/server
