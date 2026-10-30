#!/usr/bin/env bash
# Run the webhook-example e2e suite (e2e/examples) on a throwaway fixture stack:
# own Postgres database, connector-replay + llm-replay, and a control-plane on
# its own ports. Never touches the dev stack on :8080 or the shared `lantern` DB.
#   scripts/e2e-examples.sh [go test args...]
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"

DB=${E2E_EXAMPLES_DB:-pal_e2e_examples}
API_PORT=${E2E_EXAMPLES_API_PORT:-18480}
GRPC_PORT=${E2E_EXAMPLES_GRPC_PORT:-18451}
CONN_PORT=${E2E_EXAMPLES_CONNECTOR_PORT:-19191}
LLM_PORT=${E2E_EXAMPLES_LLM_PORT:-19192}
GW_PORT=${E2E_EXAMPLES_GATEWAY_PORT:-18444}
TG_PORT=${E2E_EXAMPLES_TELEGRAM_PORT:-19193}   # fixture Telegram Bot API (the Go test listens here)
RDB=${E2E_EXAMPLES_REDIS_DB:-$((RANDOM % 14 + 1))}
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
for path in ("pr-triage-webhook/fixtures/llm-rules.json",
             "incident-responder/fixtures/llm-rules.json",
             "support-desk/rules.json",
             "eval-gated-deploy/fixtures/llm-rules.json"):
    rules += json.load(open(f"examples/{path}"))
rules += json.load(open("e2e/examples/testdata/llm-rules.json"))   # digest + telegram
json.dump(rules, open(sys.argv[1], "w"))
PY

cd services/control-plane
go build -o "$tmp/connector-replay" ./cmd/connector-replay
go build -o "$tmp/llm-replay" ./cmd/llm-replay
go build -o "$tmp/server" ./cmd/server
(cd ../surface-gateway && cargo build --quiet && cp target/debug/lantern-surface-gateway "$tmp/gateway")

"$tmp/connector-replay" -addr "127.0.0.1:$CONN_PORT" >"$tmp/connector.log" 2>&1 & pids+=($!)
"$tmp/llm-replay" -addr "127.0.0.1:$LLM_PORT" -rules "$tmp/rules.json" >"$tmp/llm.log" 2>&1 & pids+=($!)

conn="http://127.0.0.1:$CONN_PORT"; llm="http://127.0.0.1:$LLM_PORT"
env \
  DATABASE_URL="postgres://lantern:lantern@localhost:5432/$DB?sslmode=disable" \
  REDIS_URL="redis://localhost:6379/$RDB" \
  HTTP_ADDR=":$API_PORT" LISTEN_ADDR=":$GRPC_PORT" LOG_LEVEL=warn \
  LANTERN_CONNECTOR_BASEURL_SLACK="$conn" LANTERN_CONNECTOR_BASEURL_GITHUB="$conn" \
  LANTERN_CONNECTOR_BASEURL_SENTRY="$conn" LANTERN_CONNECTOR_BASEURL_PAGERDUTY="$conn" \
  LANTERN_CONNECTOR_BASEURL_GOOGLE="$conn" LANTERN_RECOVERY_INTERVAL=2s \
  LANTERN_LLM_BASEURL_OPENAI="$llm" LANTERN_LLM_BASEURL_ANTHROPIC="$llm" \
  OPENAI_API_KEY=fixture-key \
  "$tmp/server" >"$tmp/server.log" 2>&1 & pids+=($!)

# surface-gateway (telegram-assistant): real binary, Bot API pointed at the Go test's fixture.
env LISTEN_ADDR="127.0.0.1:$GW_PORT" REDIS_URL="redis://localhost:6379/$RDB" \
  CONTROL_PLANE_ADDR="http://127.0.0.1:$GRPC_PORT" LOG_LEVEL=warn \
  TELEGRAM_BOT_TOKEN="123:e2e" TELEGRAM_SECRET_TOKEN="e2e-telegram-secret" \
  TELEGRAM_API_BASE_URL="http://127.0.0.1:$TG_PORT" \
  LANTERN_TENANT_ID="00000000-0000-0000-0000-000000000001" LANTERN_AGENT_NAME="e2e-assistant" \
  "$tmp/gateway" >"$tmp/gateway.log" 2>&1 & pids+=($!)

for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1 && break
  kill -0 "${pids[2]}" 2>/dev/null || { tail -30 "$tmp/server.log"; echo "control-plane exited" >&2; exit 1; }
  sleep 1
done

if [ -n "${E2E_EXAMPLES_SERVE:-}" ]; then   # debugging: keep the stack up, no tests
  echo "stack up: LANTERN_E2E_API_URL=http://127.0.0.1:$API_PORT (ctrl-c to stop)"; wait "${pids[2]}"; exit
fi
cd "$root/e2e/examples"
# TestDataAnalystSandbox needs a real runtime (scheduler + manager); this stack has
# only the stub scheduler, so it runs from `make test-e2e-analyst` (see its README).
LANTERN_E2E_API_URL="http://127.0.0.1:$API_PORT" \
LANTERN_E2E_CONNECTOR_REPLAY_URL="$conn" LANTERN_E2E_LLM_REPLAY_URL="$llm" \
DATABASE_URL="postgres://lantern:lantern@localhost:5432/$DB?sslmode=disable" \
LANTERN_E2E_REPLAY_URL="$conn" LANTERN_E2E_GATEWAY_URL="http://127.0.0.1:$GW_PORT" \
LANTERN_E2E_TELEGRAM_FIXTURE_ADDR="127.0.0.1:$TG_PORT" LANTERN_E2E_TELEGRAM_SECRET="e2e-telegram-secret" \
  go test -tags e2e -count=1 -p 1 -v -skip 'TestDataAnalystSandbox' "${@:-./...}" || { echo "--- control-plane log tail ---"; tail -40 "$tmp/server.log" "$tmp/gateway.log"; exit 1; }
