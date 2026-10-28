#!/usr/bin/env bash
# Boots a PRIVATE fixture stack (own DB, own ports, fixture LLM + SaaS) and runs
# the Wave 2 example e2e suites (e2e/examples). Never touches :8080 / the shared
# `lantern` DB. Needs Postgres + Redis from `make dev-infra`; no provider keys.
#
#   scripts/e2e-examples-stack.sh            # run, then tear down
#   KEEP_DB=1 scripts/e2e-examples-stack.sh  # keep the DB between runs
#   KEEP_LOGS=1 ...                          # keep service logs (path printed)
#   HOLD=1 ...                               # leave the stack up and print the test env
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${E2E_EXAMPLES_DB:-lantern_e2e_ex_$$}"
PG="postgres://lantern:lantern@localhost:5432"
# Free ports are picked per run so parallel stacks (other agents, CI) never collide.
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
CP_HTTP=$(free_port) CP_GRPC=$(free_port) REPLAY=$(free_port) LLM=$(free_port) GW=$(free_port) TG_FIXTURE=$(free_port)
REDIS_URL="${E2E_EXAMPLES_REDIS:-redis://localhost:6379/9}" # DB 9, not the bridges' DB 0
TMP="$(mktemp -d)"
PIDS=()

cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  if [ -z "${KEEP_DB:-}" ]; then
    PGPASSWORD=lantern dropdb -h localhost -U lantern --if-exists "$DB" 2>/dev/null || true
  fi
  if [ -n "${KEEP_LOGS:-}" ]; then echo "logs in $TMP"; else rm -r -f "$TMP"; fi
}
trap cleanup EXIT

PGPASSWORD=lantern psql -h localhost -U lantern -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
  || PGPASSWORD=lantern createdb -h localhost -U lantern "$DB"

wait_http() {
  for _ in $(seq 1 120); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "timeout waiting for $1" >&2
  exit 1
}

echo "==> building"
(cd "$ROOT/services/control-plane" &&
  go build -o "$TMP/control-plane" ./cmd/server &&
  go build -o "$TMP/connector-replay" ./cmd/connector-replay &&
  go build -o "$TMP/llm-replay" ./cmd/llm-replay)
(cd "$ROOT/services/surface-gateway" && cargo build --quiet && cp target/debug/lantern-surface-gateway "$TMP/surface-gateway")

echo "==> fixtures"
"$TMP/connector-replay" -addr "127.0.0.1:$REPLAY" >"$TMP/connector-replay.log" 2>&1 &
PIDS+=($!)
"$TMP/llm-replay" -addr "127.0.0.1:$LLM" -rules "$ROOT/e2e/examples/testdata/llm-rules.json" >"$TMP/llm-replay.log" 2>&1 &
PIDS+=($!)

echo "==> control-plane :$CP_HTTP (db $DB)"
DATABASE_URL="$PG/$DB?sslmode=disable" REDIS_URL="$REDIS_URL" S3_ENDPOINT="http://localhost:9000" \
  HTTP_ADDR="127.0.0.1:$CP_HTTP" LISTEN_ADDR="127.0.0.1:$CP_GRPC" LOG_LEVEL=info \
  OPENAI_API_KEY=sk-fixture \
  LANTERN_LLM_BASEURL_OPENAI="http://127.0.0.1:$LLM" LANTERN_LLM_BASEURL_ANTHROPIC="http://127.0.0.1:$LLM" \
  LANTERN_CONNECTOR_BASEURL_SLACK="http://127.0.0.1:$REPLAY" LANTERN_CONNECTOR_BASEURL_GITHUB="http://127.0.0.1:$REPLAY" \
  LANTERN_CONNECTOR_BASEURL_GOOGLE="http://127.0.0.1:$REPLAY" \
  LANTERN_RECOVERY_INTERVAL=2s \
  "$TMP/control-plane" >"$TMP/control-plane.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$CP_HTTP/healthz"

echo "==> surface-gateway :$GW"
LISTEN_ADDR="127.0.0.1:$GW" REDIS_URL="$REDIS_URL" CONTROL_PLANE_ADDR="http://127.0.0.1:$CP_GRPC" \
  TELEGRAM_BOT_TOKEN="123:e2e" TELEGRAM_SECRET_TOKEN="e2e-telegram-secret" \
  TELEGRAM_API_BASE_URL="http://127.0.0.1:$TG_FIXTURE" \
  LANTERN_TENANT_ID="00000000-0000-0000-0000-000000000001" LANTERN_AGENT_NAME="e2e-assistant" \
  "$TMP/surface-gateway" >"$TMP/surface-gateway.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$GW/healthz"

echo "==> e2e/examples"
cd "$ROOT/e2e/examples"
if [ -n "${HOLD:-}" ]; then
  echo "HOLD=1: stack is up. Ctrl-C to stop."
  echo "export LANTERN_E2E_API_URL=http://127.0.0.1:$CP_HTTP DATABASE_URL=$PG/$DB?sslmode=disable LANTERN_E2E_REPLAY_URL=http://127.0.0.1:$REPLAY LANTERN_E2E_GATEWAY_URL=http://127.0.0.1:$GW LANTERN_E2E_TELEGRAM_FIXTURE_ADDR=127.0.0.1:$TG_FIXTURE LANTERN_E2E_TELEGRAM_SECRET=e2e-telegram-secret"
  echo "logs: $TMP"
  KEEP_LOGS=1
  wait
fi
rc=0
LANTERN_E2E_API_URL="http://127.0.0.1:$CP_HTTP" DATABASE_URL="$PG/$DB?sslmode=disable" \
  LANTERN_E2E_REPLAY_URL="http://127.0.0.1:$REPLAY" LANTERN_E2E_GATEWAY_URL="http://127.0.0.1:$GW" \
  LANTERN_E2E_TELEGRAM_FIXTURE_ADDR="127.0.0.1:$TG_FIXTURE" LANTERN_E2E_TELEGRAM_SECRET="e2e-telegram-secret" \
  go test -tags e2e -count=1 -p 1 -v ./... || rc=$?
if [ "$rc" -ne 0 ]; then
  tail -n 40 "$TMP/control-plane.log" "$TMP/surface-gateway.log" >&2
  KEEP_LOGS=1
fi
exit "$rc"
