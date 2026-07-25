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

# Shared wiring defaults, also sourced by the `make run-*` targets so the two
# cannot drift. Only fills values that are unset, so a plist's
# EnvironmentVariables still wins.
# shellcheck source=./service-env.sh
. "$REPO_ROOT/scripts/launchd/service-env.sh"

# Shared launch helpers (wait_port / run_go / run_rust).
# shellcheck source=./lib.sh
. "$REPO_ROOT/scripts/launchd/lib.sh"

case "$SVC" in
  gateway)
    wait_port 6379 redis
    wait_port 50051 control-plane
    run_rust gateway lantern-gateway
    ;;
  model-router)
    wait_port 6379 redis
    run_rust model-router lantern-model-router
    ;;
  runtime-manager)
    wait_port 9000 minio
    # The scheduler is where this node self-registers. Waiting avoids a burst
    # of failed first beats at boot; the heartbeat's own backoff covers a late
    # scheduler, so this only ever delays, never blocks.
    wait_port 8085 runtime-scheduler
    run_rust runtime-manager lantern-runtime-manager
    ;;
  surface-gateway)
    wait_port 6379 redis
    wait_port 50051 control-plane
    run_rust surface-gateway lantern-surface-gateway
    ;;
  runtime-scheduler)
    echo "[$(date +%T)] starting runtime-scheduler on :50055 (grpc) / :8085 (rest)"
    run_go runtime-scheduler ./cmd/scheduler
    ;;
  workflow-engine)
    wait_port 5432 postgres
    wait_port 6379 redis
    echo "[$(date +%T)] starting workflow-engine on :50052"
    run_go workflow-engine ./cmd/server workflow-engine
    ;;
  *)
    echo "unknown service: $SVC" >&2
    exit 1
    ;;
esac
