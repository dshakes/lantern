#!/usr/bin/env bash
# Generic launcher for the Lantern Rust/Go microservices that run as
# always-on LaunchAgents alongside the API, dashboard, and bridges.
#
# Usage: run-microservice.sh <service>
#   gateway | model-router | runtime-manager | surface-gateway
#   runtime-scheduler | workflow-engine
#
# Per-service env (ports, secrets, upstream addrs) lives in the matching
# dev.lantern.<service>.plist. This wrapper only handles: PATH setup,
# waiting for upstream deps to accept TCP (so we don't crash-loop at
# boot before Postgres/Redis/control-plane are reachable), building the
# Rust release binary if it's missing, and exec-ing the process.

set -euo pipefail

REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
SVC="${1:?usage: run-microservice.sh <service>}"

# launchd hands us a minimal PATH — restore go + cargo + homebrew.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:/opt/homebrew/opt/go/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Wait up to 120s for a TCP port; warn + continue if it never comes up
# (the service's own retry/backoff handles a late upstream).
wait_port() {
  local port="$1" name="$2"
  for i in {1..60}; do
    if nc -z localhost "$port" 2>/dev/null; then
      echo "[$(date +%T)] $name (:$port) reachable (after $((i*2))s)"
      return 0
    fi
    sleep 2
  done
  echo "[$(date +%T)] WARN: $name (:$port) not reachable after 120s — starting $SVC anyway" >&2
}

# Build the Rust release binary if absent, then exec it.
run_rust() {
  local pkg="$1"
  cd "$REPO_ROOT/services/$SVC"
  local bin="target/release/$pkg"
  if [[ ! -x "$bin" ]]; then
    echo "[$(date +%T)] $bin missing — building (first boot, this is slow)…"
    cargo build --release
  fi
  echo "[$(date +%T)] starting $SVC -> $bin"
  exec "$bin"
}

case "$SVC" in
  gateway)
    wait_port 6379 redis
    wait_port 50051 control-plane
    run_rust lantern-gateway
    ;;
  model-router)
    wait_port 6379 redis
    run_rust lantern-model-router
    ;;
  runtime-manager)
    wait_port 9000 minio
    run_rust lantern-runtime-manager
    ;;
  surface-gateway)
    wait_port 6379 redis
    wait_port 50051 control-plane
    run_rust lantern-surface-gateway
    ;;
  runtime-scheduler)
    cd "$REPO_ROOT/services/runtime-scheduler"
    echo "[$(date +%T)] starting runtime-scheduler on :50055 (grpc) / :8085 (rest)"
    exec go run ./cmd/scheduler
    ;;
  workflow-engine)
    wait_port 5432 postgres
    wait_port 6379 redis
    cd "$REPO_ROOT/services/workflow-engine"
    echo "[$(date +%T)] starting workflow-engine on :50052"
    exec go run ./cmd/server
    ;;
  *)
    echo "unknown service: $SVC" >&2
    exit 1
    ;;
esac
