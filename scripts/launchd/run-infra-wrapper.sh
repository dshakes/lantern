#!/usr/bin/env bash
# Bring up Lantern infra (Postgres, Redis, MinIO) via docker-compose.
# Waits for Docker Desktop to be ready before issuing the up command —
# at login, Docker Desktop and this script race, and Docker often
# isn't accepting connections in the first 10-20 seconds.

set -euo pipefail
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
cd "$REPO_ROOT"

# Guard: if Docker Desktop isn't set to auto-start at login, launch it
# ourselves so the stack is self-sufficient on reboot. `open -a Docker`
# is a no-op-ish focus if it's already running, so only fire it when the
# daemon isn't reachable. Best-effort — never fail the script on this.
docker_launched=""
launch_docker_if_needed() {
  docker info >/dev/null 2>&1 && return 0
  [[ -n "$docker_launched" ]] && return 0
  docker_launched=1
  echo "[$(date +%T)] docker not reachable — launching Docker Desktop…"
  open --background -a Docker 2>/dev/null \
    || echo "[$(date +%T)] WARN: could not 'open -a Docker' (is Docker Desktop installed?)" >&2
}

# Wait up to 150s for Docker — a cold Docker Desktop launch at reboot can
# take well over 60s before the daemon accepts connections.
launch_docker_if_needed
for i in {1..75}; do
  if docker info >/dev/null 2>&1; then
    echo "[$(date +%T)] docker ready (after ${i}x2s)"
    break
  fi
  if [[ $i -eq 75 ]]; then
    echo "[$(date +%T)] docker NEVER became ready after launch attempt — is Docker Desktop installed?" >&2
    exit 1
  fi
  # Re-attempt the launch once at ~20s in case the first open was eaten
  # during the login storm.
  [[ $i -eq 10 ]] && launch_docker_if_needed
  sleep 2
done

# Bring up the compose stack. -d = detached, --wait = block until healthy.
echo "[$(date +%T)] starting docker compose…"
docker compose -f infra/docker/docker-compose.yml up -d --wait postgres redis minio 2>&1 \
  || docker compose -f infra/docker/docker-compose.yml up -d postgres redis minio

echo "[$(date +%T)] infra up: postgres :5432, redis :6379, minio :9000"
