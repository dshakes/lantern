#!/usr/bin/env bash
# Bring up Lantern infra (Postgres, Redis, MinIO) via docker-compose.
# Waits for Docker Desktop to be ready before issuing the up command —
# at login, Docker Desktop and this script race, and Docker often
# isn't accepting connections in the first 10-20 seconds.

set -euo pipefail
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
cd "$REPO_ROOT"

# Wait up to 60s for Docker to be reachable.
for i in {1..30}; do
  if docker info >/dev/null 2>&1; then
    echo "[$(date +%T)] docker ready (after ${i}x2s)"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "[$(date +%T)] docker NEVER became ready — is Docker Desktop running?" >&2
    exit 1
  fi
  sleep 2
done

# Bring up the compose stack. -d = detached, --wait = block until healthy.
echo "[$(date +%T)] starting docker compose…"
docker compose -f infra/docker/docker-compose.yml up -d --wait postgres redis minio 2>&1 \
  || docker compose -f infra/docker/docker-compose.yml up -d postgres redis minio

echo "[$(date +%T)] infra up: postgres :5432, redis :6379, minio :9000"
