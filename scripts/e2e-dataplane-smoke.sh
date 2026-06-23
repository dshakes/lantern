#!/usr/bin/env bash
#
# e2e-dataplane-smoke.sh — LIVE two-process proof of the data-plane tunnel + run
# routing. Boots the real control-plane and data-plane-agent BINARIES (not an
# in-process test), has the agent dial the control plane over gRPC, registers it,
# creates a run via the public REST API, and asserts the run was actually routed
# to the agent's plane and the DpRunAssignment was delivered over the tunnel.
#
# This is the "outside the unit tests" proof for docs/GA-READINESS.md gap #1.
#
# Usage:  bash scripts/e2e-dataplane-smoke.sh
# Needs:  docker compose (Postgres+Redis), Go (go1.26.4 via GOTOOLCHAIN), python3.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DC="docker compose -f $ROOT/infra/docker/docker-compose.yml"
PSQL="$DC exec -T postgres psql -U lantern -d lantern"
DB_URL="postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable"
TENANT="00000000-0000-0000-0000-000000000001"

CP_BIN="/tmp/lantern-cp-smoke"; AGENT_BIN="/tmp/lantern-dpa-smoke"
CP_LOG="/tmp/lantern-cp-smoke.log"; AGENT_LOG="/tmp/lantern-dpa-smoke.log"
CP_PID=""; AGENT_PID=""; PLANE_ID=""

cleanup() {
  [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null || true
  [ -n "$CP_PID" ] && kill "$CP_PID" 2>/dev/null || true
  [ -n "$PLANE_ID" ] && $PSQL -c "DELETE FROM data_planes WHERE id='$PLANE_ID'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo ""
  echo "❌ SMOKE FAIL: $*"
  echo "----- control-plane log (tail) -----"; tail -25 "$CP_LOG" 2>/dev/null || true
  echo "----- agent log (tail) -----";        tail -25 "$AGENT_LOG" 2>/dev/null || true
  exit 1
}

jget() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }

echo "==> [1/9] ensure infra (Postgres + Redis)"
$DC up -d postgres redis minio-init >/dev/null 2>&1 || true
for i in $(seq 1 30); do $PSQL -c "SELECT 1" >/dev/null 2>&1 && break; [ "$i" = 30 ] && fail "Postgres never ready"; sleep 1; done

echo "==> [2/9] build control-plane + data-plane-agent (CGO off)"
( cd "$ROOT/services/control-plane"   && CGO_ENABLED=0 GOTOOLCHAIN=go1.26.4 go build -o "$CP_BIN" ./cmd/server )  || fail "control-plane build"
( cd "$ROOT/services/data-plane-agent" && CGO_ENABLED=0 GOTOOLCHAIN=go1.26.4 go build -o "$AGENT_BIN" ./cmd/agent ) || fail "agent build"

echo "==> [3/9] free ports + start control-plane (:8080 REST, :50051 gRPC)"
bash "$ROOT/scripts/kill-port.sh" 8080 50051 8090 >/dev/null 2>&1 || true
DATABASE_URL="$DB_URL" REDIS_URL="redis://localhost:6379" S3_ENDPOINT="http://localhost:9000" \
  JWT_SECRET="lantern-dev-jwt-secret-do-not-use-in-production" LOG_LEVEL="info" \
  "$CP_BIN" >"$CP_LOG" 2>&1 &
CP_PID=$!
for i in $(seq 1 45); do curl -fsS "http://localhost:8080/healthz" >/dev/null 2>&1 && break; [ "$i" = 45 ] && fail "control-plane not healthy"; sleep 1; done
echo "    control-plane up (pid $CP_PID)"

echo "==> [4/9] login (dev admin)"
TOKEN=$(curl -fsS -X POST "http://localhost:8080/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"admin@lantern.dev","password":"lantern"}' | jget token) || fail "login request"
[ -n "$TOKEN" ] || fail "empty login token"

echo "==> [5/9] register a data plane (POST /v1/data-planes)"
DP_JSON=$(curl -fsS -X POST "http://localhost:8080/v1/data-planes" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"smoke-dp","cloud":"local","region":"local"}') || fail "register data plane"
PLANE_ID=$(echo "$DP_JSON" | jget id)
AGENT_TOKEN=$(echo "$DP_JSON" | jget agentToken)
[ -n "$PLANE_ID" ] && [ -n "$AGENT_TOKEN" ] || fail "data-plane response missing id/agentToken: $DP_JSON"
echo "    plane_id=$PLANE_ID  (bootstrap token issued once)"

echo "==> [6/9] start data-plane-agent — dials :50051 plaintext, registers, opens RunStream"
CONTROL_PLANE_ENDPOINT="localhost:50051" TENANT_ID="$TENANT" AGENT_TOKEN="$AGENT_TOKEN" \
  TLS_INSECURE_SKIP_VERIFY="true" HEARTBEAT_INTERVAL_SECONDS="5" LOG_LEVEL="info" \
  WORKFLOW_ENGINE_ADDR="localhost:50052" \
  "$AGENT_BIN" >"$AGENT_LOG" 2>&1 &
AGENT_PID=$!
for i in $(seq 1 30); do
  curl -fsS "http://localhost:8090/status" 2>/dev/null | grep -q '"connected":true' && break
  [ "$i" = 30 ] && fail "agent never connected to control plane"
  sleep 1
done
echo "    agent connected (pid $AGENT_PID)"

echo "==> [7/9] create an agent + a run via the public API"
curl -fsS -X POST "http://localhost:8080/v1/agents" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"smoke-agent","description":"e2e smoke"}' >/dev/null 2>&1 || true
RUN_JSON=$(curl -fsS -X POST "http://localhost:8080/v1/runs" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"agentName":"smoke-agent","input":{"prompt":"hello from smoke"}}') || fail "create run"
RUN_ID=$(echo "$RUN_JSON" | jget id)
[ -n "$RUN_ID" ] || fail "no run id in response: $RUN_JSON"
echo "    run_id=$RUN_ID"

echo "==> [8/9] assert the run was ROUTED to the plane (runs.data_plane_id == plane_id)"
DP=""
for i in $(seq 1 20); do
  DP=$($PSQL -tAc "SELECT data_plane_id FROM runs WHERE id='$RUN_ID'" 2>/dev/null | tr -d '[:space:]')
  [ "$DP" = "$PLANE_ID" ] && break
  sleep 0.5
done
[ "$DP" = "$PLANE_ID" ] || fail "run NOT routed to plane (data_plane_id='$DP', want '$PLANE_ID')"
echo "    routed ✓  data_plane_id=$DP"

echo "==> [9/9] assert the DpRunAssignment was delivered over the tunnel (agent log)"
for i in $(seq 1 10); do grep -q "run assignment received" "$AGENT_LOG" && break; [ "$i" = 10 ] && fail "agent never received the assignment"; sleep 0.5; done
echo "    assignment delivered ✓"

echo ""
echo "✅ SMOKE PASS — live two-process proof of tunnel + routing:"
echo "   • control-plane (pid $CP_PID) and data-plane-agent (pid $AGENT_PID) ran as separate binaries"
echo "   • agent dialed :50051, registered as plane $PLANE_ID, opened the bidi RunStream"
echo "   • POST /v1/runs → run $RUN_ID was pinned to data_plane_id=$PLANE_ID (routed, not inline)"
echo "   • the DpRunAssignment reached the agent over the tunnel"
