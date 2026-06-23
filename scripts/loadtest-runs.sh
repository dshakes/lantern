#!/usr/bin/env bash
#
# loadtest-runs.sh — basic concurrency load test on the run create+route path.
# Boots the real control-plane binary, then fires N run-creates at concurrency C
# through the public REST API and reports success rate + wall-clock throughput.
# This is a LOCAL single-node smoke of concurrency, not a cluster soak test.
#
# Usage:  bash scripts/loadtest-runs.sh        # defaults N=120 C=24
#         N=300 C=40 bash scripts/loadtest-runs.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DC="docker compose -f $ROOT/infra/docker/docker-compose.yml"
PSQL="$DC exec -T postgres psql -U lantern -d lantern"
DB_URL="postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable"
N="${N:-120}"; C="${C:-24}"
CP_BIN="/tmp/lantern-cp-load"; CP_LOG="/tmp/lantern-cp-load.log"; CP_PID=""

cleanup() { [ -n "$CP_PID" ] && kill "$CP_PID" 2>/dev/null || true; }
trap cleanup EXIT
fail() { echo "❌ LOADTEST FAIL: $*"; tail -20 "$CP_LOG" 2>/dev/null || true; exit 1; }
jget() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }

echo "==> infra + build + boot control-plane"
$DC up -d postgres redis minio-init >/dev/null 2>&1 || true
for i in $(seq 1 30); do $PSQL -c "SELECT 1" >/dev/null 2>&1 && break; [ "$i" = 30 ] && fail "pg not ready"; sleep 1; done
( cd "$ROOT/services/control-plane" && CGO_ENABLED=0 GOTOOLCHAIN=go1.26.4 go build -o "$CP_BIN" ./cmd/server ) || fail "build"
bash "$ROOT/scripts/kill-port.sh" 8080 50051 >/dev/null 2>&1 || true
DATABASE_URL="$DB_URL" REDIS_URL="redis://localhost:6379" S3_ENDPOINT="http://localhost:9000" \
  JWT_SECRET="lantern-dev-jwt-secret-do-not-use-in-production" LOG_LEVEL="warn" \
  "$CP_BIN" >"$CP_LOG" 2>&1 &
CP_PID=$!
for i in $(seq 1 45); do curl -fsS "http://localhost:8080/healthz" >/dev/null 2>&1 && break; [ "$i" = 45 ] && fail "cp not healthy"; sleep 1; done

TOKEN=$(curl -fsS -X POST "http://localhost:8080/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"admin@lantern.dev","password":"lantern"}' | jget token)
[ -n "$TOKEN" ] || fail "login"
curl -fsS -X POST "http://localhost:8080/v1/agents" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"load-agent","description":"loadtest"}' >/dev/null 2>&1 || true

echo "==> firing $N run-creates at concurrency $C"
WORKDIR="$(mktemp -d)"; trap 'rm -rf "$WORKDIR"; cleanup' EXIT
one() { # writes the HTTP code to a file
  local i="$1"
  curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:8080/v1/runs" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"agentName":"load-agent","input":{"prompt":"load '"$i"'"}}' > "$WORKDIR/$i"
}
export -f one; export TOKEN WORKDIR
start=$(python3 -c 'import time;print(time.time())')
seq 1 "$N" | xargs -P "$C" -I{} bash -c 'one "$@"' _ {}
end=$(python3 -c 'import time;print(time.time())')

ok2xx=0; rl429=0; other=0
for f in "$WORKDIR"/*; do
  code=$(cat "$f")
  case "$code" in
    20*) ok2xx=$((ok2xx+1)) ;;
    429) rl429=$((rl429+1)) ;;
    *)   other=$((other+1)) ;;
  esac
done
elapsed=$(python3 -c "print(f'{$end-$start:.2f}')")
rps=$(python3 -c "print(f'{$N/($end-$start):.0f}')")

echo ""
echo "==> results"
echo "   total:        $N (concurrency $C)"
echo "   2xx created:  $ok2xx"
echo "   429 limited:  $rl429   (per-tenant spawn-storm guard — expected under burst)"
echo "   other/errors: $other"
echo "   wall-clock:   ${elapsed}s   (~${rps} req/s)"

# Pass criteria: no 5xx / connection errors. 429s are the rate limiter working
# as designed, not a failure.
if [ "$other" -ne 0 ]; then
  fail "$other requests returned a non-2xx/429 status (5xx or connection error)"
fi
echo ""
echo "✅ LOADTEST PASS — control-plane accepted $((ok2xx+rl429))/$N concurrent run-creates with zero 5xx/connection errors"
