#!/usr/bin/env bash
# Run the webhook-example e2e suite (e2e/examples) on a throwaway fixture stack:
# own Postgres database, connector-replay + llm-replay, and a control-plane on
# its own ports. Never touches the dev stack on :8080 or the shared `lantern` DB.
#   scripts/e2e-examples.sh [go test args...]
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"

DB=${E2E_EXAMPLES_DB:-lantern_e2e_examples}
API_PORT=${E2E_EXAMPLES_API_PORT:-18480}
GRPC_PORT=${E2E_EXAMPLES_GRPC_PORT:-18451}
CONN_PORT=${E2E_EXAMPLES_CONNECTOR_PORT:-19191}
LLM_PORT=${E2E_EXAMPLES_LLM_PORT:-19192}
export PGPASSWORD=lantern

tmp=$(mktemp -d)
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  dropdb -h localhost -U lantern --if-exists --force "$DB" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

dropdb -h localhost -U lantern --if-exists --force "$DB"
createdb -h localhost -U lantern "$DB"

python3 - "$tmp/rules.json" <<'PY'
import json, sys
rules = []
for ex in ("pr-triage-webhook", "incident-responder"):
    rules += json.load(open(f"examples/{ex}/fixtures/llm-rules.json"))
json.dump(rules, open(sys.argv[1], "w"))
PY

cd services/control-plane
go build -o "$tmp/connector-replay" ./cmd/connector-replay
go build -o "$tmp/llm-replay" ./cmd/llm-replay
go build -o "$tmp/server" ./cmd/server

"$tmp/connector-replay" -addr "127.0.0.1:$CONN_PORT" >"$tmp/connector.log" 2>&1 & pids+=($!)
"$tmp/llm-replay" -addr "127.0.0.1:$LLM_PORT" -rules "$tmp/rules.json" >"$tmp/llm.log" 2>&1 & pids+=($!)

conn="http://127.0.0.1:$CONN_PORT"; llm="http://127.0.0.1:$LLM_PORT"
env \
  DATABASE_URL="postgres://lantern:lantern@localhost:5432/$DB?sslmode=disable" \
  REDIS_URL="redis://localhost:6379/${E2E_EXAMPLES_REDIS_DB:-$((RANDOM % 14 + 1))}" \
  HTTP_ADDR=":$API_PORT" LISTEN_ADDR=":$GRPC_PORT" LOG_LEVEL=warn \
  LANTERN_CONNECTOR_BASEURL_SLACK="$conn" LANTERN_CONNECTOR_BASEURL_GITHUB="$conn" \
  LANTERN_CONNECTOR_BASEURL_SENTRY="$conn" LANTERN_CONNECTOR_BASEURL_PAGERDUTY="$conn" \
  LANTERN_LLM_BASEURL_OPENAI="$llm" LANTERN_LLM_BASEURL_ANTHROPIC="$llm" \
  OPENAI_API_KEY=fixture-key \
  "$tmp/server" >"$tmp/server.log" 2>&1 & pids+=($!)

for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1 && break
  kill -0 "${pids[2]}" 2>/dev/null || { tail -30 "$tmp/server.log"; echo "control-plane exited" >&2; exit 1; }
  sleep 1
done

if [ -n "${E2E_EXAMPLES_SERVE:-}" ]; then   # debugging: keep the stack up, no tests
  echo "stack up: LANTERN_E2E_API_URL=http://127.0.0.1:$API_PORT (ctrl-c to stop)"; wait "${pids[2]}"; exit
fi
cd "$root/e2e/examples"
LANTERN_E2E_API_URL="http://127.0.0.1:$API_PORT" \
LANTERN_E2E_CONNECTOR_REPLAY_URL="$conn" LANTERN_E2E_LLM_REPLAY_URL="$llm" \
  go test -tags e2e -count=1 -p 1 -v "${@:-./...}" || { echo "--- control-plane log tail ---"; tail -40 "$tmp/server.log"; exit 1; }
