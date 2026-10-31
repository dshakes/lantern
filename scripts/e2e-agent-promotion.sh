#!/usr/bin/env bash
# Real end-to-end for agent promotion (ADR 0054): a fresh control-plane on private
# ports with the llm-replay fixture, driven only through the `pal` CLI and the
# public REST API. Proves: eval gate blocks, order gate, prod proposal by an
# agent principal stays pending, an agent key cannot approve, a human approves,
# canary routes live runs, a failing canary auto-rolls back, rollback is
# idempotent, and the audit trail records every decision. No live provider key.
#
#   E2E_PROMO_PG_URL=postgres://u:p@127.0.0.1:PORT/db?sslmode=disable \
#   E2E_PROMO_REDIS_URL=redis://127.0.0.1:PORT/0 scripts/e2e-agent-promotion.sh
#
# The database must be a throwaway one (the server migrates it). Never point this
# at the shared dev/live database.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${E2E_PROMO_PG_URL:?throwaway Postgres URL required}"
API_PORT=${E2E_PROMO_API_PORT:-18461}
GRPC_PORT=${E2E_PROMO_GRPC_PORT:-18462}
LLM_PORT=${E2E_PROMO_LLM_PORT:-19462}
METRICS_PORT=${E2E_PROMO_METRICS_PORT:-19464}

tmp=$(mktemp -d)
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "E2E FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }
# E2E_PROMO_PSQL overrides the client, e.g. "docker exec -i my-pg psql -U pal pal_db"
sql() { if [ -n "${E2E_PROMO_PSQL:-}" ]; then $E2E_PROMO_PSQL -tAqc "$1"; else psql "$E2E_PROMO_PG_URL" -tAqc "$1"; fi; }

(cd services/control-plane && go build -o "$tmp/llm-replay" ./cmd/llm-replay && go build -o "$tmp/server" ./cmd/server)
mkdir -p "$tmp/bin"
(cd packages/cli && go build -o "$tmp/bin/pal" ./cmd/pal)

python3 - "$tmp/rules.json" <<'PY'
import json, sys
rules = json.load(open("examples/eval-gated-deploy/fixtures/llm-rules.json"))
json.dump(rules, open(sys.argv[1], "w"))
PY

"$tmp/llm-replay" -addr "127.0.0.1:$LLM_PORT" -rules "$tmp/rules.json" >"$tmp/llm.log" 2>&1 & pids+=($!)
llm="http://127.0.0.1:$LLM_PORT"
env DATABASE_URL="$E2E_PROMO_PG_URL" ${E2E_PROMO_REDIS_URL:+REDIS_URL="$E2E_PROMO_REDIS_URL"} \
  JWT_SECRET=promo-e2e-secret-not-for-prod-0123456789 \
  HTTP_ADDR="127.0.0.1:$API_PORT" LISTEN_ADDR="127.0.0.1:$GRPC_PORT" PAL_METRICS_ADDR="127.0.0.1:$METRICS_PORT" LOG_LEVEL=warn \
  PAL_LLM_BASEURL_OPENAI="$llm" PAL_LLM_BASEURL_ANTHROPIC="$llm" OPENAI_API_KEY=fixture-key \
  "$tmp/server" >"$tmp/server.log" 2>&1 & pids+=($!)
api="http://127.0.0.1:$API_PORT"
for _ in $(seq 1 60); do
  curl -fs "$api/healthz" >/dev/null 2>&1 && break
  kill -0 "${pids[1]}" 2>/dev/null || { tail -30 "$tmp/server.log"; fail "control-plane exited"; }
  sleep 1
done

tok=$(curl -fs -X POST "$api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@pal.local","password":"pal"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
auth=(-H "Authorization: Bearer $tok" -H 'content-type: application/json')

# An API key is an AGENT principal: it can propose, it cannot approve.
keyjson=$(curl -fs -X POST "$api/v1/api-keys" "${auth[@]}" -d '{"name":"onboarding-agent","scopes":["agents:write","agents:read","runs:read","runs:execute"]}')
agentkey=$(echo "$keyjson" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["rawKey"])')
[ -n "$agentkey" ] && [ "$agentkey" != None ] || fail "could not mint an api key: $keyjson"

export HOME="$tmp/home"; mkdir -p "$HOME"
export PATH="$tmp/bin:$PATH" PAL_API_URL="$api"
human() { PAL_API_KEY="$tok" pal "$@"; }          # human owner session
agentp() { PAL_API_KEY="$agentkey" pal "$@"; }    # agent principal

repo="$tmp/repo"; mkdir -p "$repo"; cd "$repo"
write_agent() {
  cat >agent.yaml <<YAML
name: shipping-assistant
version: "$1"
model: auto
system_prompt: |
  You are the shipping assistant for an online shop. Answer delivery questions in one short sentence.$2
limits:
  max_cost_usd: 0.50
egress: []
YAML
}
write_agent 0.1.0 ""
human deploy >/dev/null || fail "deploy v1"
human freeze shipping-assistant --label v1 >/dev/null || fail "freeze v1"
suite=$(curl -fs -X POST "$api/v1/eval-suites" "${auth[@]}" -d '{
  "agentName":"shipping-assistant","name":"promo","description":"e2e",
  "cases":[
   {"name":"standard-delivery","input":"How many days does standard delivery take?","assert":{"contains":"3-5 business days"}},
   {"name":"track-order","input":"Where can I track my parcel?","assert":{"contains":"Orders page"}}]}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
eval_run() { curl -fs -X POST "$api/v1/eval-suites/$suite/run" "${auth[@]}" -d "{\"branch\":\"$1\"}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["passed"], d["score"])'; }
current() { sql "select av.version from agents a join agent_versions av on av.id=a.current_version_id where a.name='shipping-assistant'"; }
prod_version() { sql "select version from agent_environments where agent_name='shipping-assistant' and env='prod'"; }

echo "== 1. gates"
v1=v1; echo "  v1=$v1 (frozen); live current=$(current)"
agentp promote shipping-assistant --to sandbox >/dev/null || fail "sandbox promote (no eval needed)"
out=$(agentp promote shipping-assistant --to staging 2>&1) && fail "staging without eval evidence must be blocked" || true
echo "$out" | grep -q "BLOCKED" && echo "$out" | grep -q "no hermetic eval" || fail "expected eval-gate message, got: $out"
ok "staging blocked without a hermetic eval"
out=$(agentp promote shipping-assistant --to prod 2>&1) && fail "prod before staging must be blocked" || true
echo "$out" | grep -q "earlier environment" || fail "expected order-gate message, got: $out"
ok "prod blocked until the version is in sandbox/staging"
[ "$(eval_run staging)" = "True 1" ] || [ "$(eval_run staging | cut -d' ' -f1)" = "True" ] || fail "eval v1 should pass"
agentp promote shipping-assistant --to staging >/dev/null || fail "staging after eval"
ok "staging promoted after a passing hermetic eval"

echo "== 2. prod needs a human"
out=$(agentp promote shipping-assistant --to prod --reason "first prod" 2>&1) || fail "agent proposal should be accepted: $out"
echo "$out" | grep -q pending_approval || fail "prod proposal must be pending: $out"
pid=$(echo "$out" | sed -n 's/.*id=\([0-9a-f-]\{36\}\).*/\1/p' | head -1)
[ -n "$pid" ] || fail "no promotion id in: $out"
[ -z "$(prod_version)" ] && ok "proposal changed nothing (no prod environment yet)"
out=$(agentp approve "$pid" 2>&1) && fail "agent key approved a prod promotion" || true
echo "$out" | grep -q "human" || fail "expected human_approval_required, got: $out"
ok "agent API key cannot approve"
human approve "$pid" --note "e2e" >/dev/null || fail "human approve"
[ "$(sql "select approver from agent_promotions where id='$pid'")" = "admin@pal.local" ] || fail "approver not recorded"
ok "human approved; approver recorded"
human approve "$pid" >/dev/null || fail "approve replay should be idempotent"
[ "$(sql "select count(*) from agent_promotion_audit where promotion_id='$pid' and action='approved'")" = 1 ] || fail "replay wrote a second approval row"
ok "approve replay is idempotent"

echo "== 3. canary"
write_agent 0.2.0 " Always mention tracking."
human deploy >/dev/null || fail "deploy v2 draft"
human freeze shipping-assistant --label v2 >/dev/null || fail "freeze v2"
v2=v2
[ "$(prod_version)" = "$v1" ] || fail "prod must still serve v1 after a deploy+freeze"
ok "deploy + freeze did not move prod"
[ "$(eval_run staging | cut -d' ' -f1)" = "True" ] || fail "eval v2 (draft == frozen v2)"
agentp promote shipping-assistant --to sandbox --version "$v2" >/dev/null || fail "sandbox v2"
agentp promote shipping-assistant --to staging --version "$v2" >/dev/null || fail "staging v2"
out=$(agentp promote shipping-assistant --to prod --version "$v2" --canary 30 --min-runs 10 2>&1) || fail "canary proposal: $out"
pid2=$(echo "$out" | sed -n 's/.*id=\([0-9a-f-]\{36\}\).*/\1/p' | head -1)
human approve "$pid2" >/dev/null || fail "approve canary"
[ "$(sql "select status from agent_environments where agent_name='shipping-assistant' and env='prod'")" = canary ] || fail "env not in canary"
v2_before=$(curl -fs "$llm/__requests" | grep -o "Always mention tracking" | wc -l | tr -d ' ')
for i in $(seq 1 40); do
  curl -fs -X POST "$api/v1/runs" "${auth[@]}" -d '{"agentName":"shipping-assistant","input":{"prompt":"How many days does standard delivery take?"}}' >/dev/null || true
done
sleep 3
n_canary=$(sql "select count(*) from runs r join agents a on a.id=r.agent_id where a.name='shipping-assistant' and r.labels->>'pal.variant'='canary'")
n_stable=$(sql "select count(*) from runs r join agents a on a.id=r.agent_id where a.name='shipping-assistant' and r.labels->>'pal.variant'='stable'")
echo "  routed: canary=$n_canary stable=$n_stable (30% split of 40 runs)"
[ "$n_canary" -ge 3 ] && [ "$n_stable" -ge 3 ] || fail "canary split not observed"
ok "live runs split between stable and canary"
# The canary side must execute the FROZEN v2 prompt, the stable side v1's (what the model actually received).
sent_v2=$(( $(curl -fs "$llm/__requests" | grep -o "Always mention tracking" | wc -l | tr -d ' ') - v2_before ))
echo "  model calls carrying the v2 prompt: $sent_v2 (canary runs: $n_canary)"
[ "$sent_v2" -ge 1 ] && [ "$sent_v2" -le "$n_canary" ] || fail "canary runs did not execute the frozen v2 snapshot (or stable runs leaked it)"
ok "executor ran the frozen snapshot per version"

echo "== 4. guard trip -> automatic rollback"
# Make the canary version fail: terminal failed runs for v2 (the guard reads real run rows).
sql "update runs set status='failed' where id in (select r.id from runs r join agent_versions av on av.id=r.agent_version_id join agents a on a.id=r.agent_id where a.name='shipping-assistant' and av.version='$v2' and r.labels->>'pal.variant'='canary')" >/dev/null
out=$(human canary evaluate shipping-assistant 2>&1) || fail "evaluate: $out"
echo "  $out"
echo "$out" | grep -q "action=rolled_back" || fail "guard did not roll back"
[ "$(sql "select version||'/'||status from agent_environments where agent_name='shipping-assistant' and env='prod'")" = "$v1/active" ] || fail "prod must serve v1 again"
ok "tripped guard rolled prod back to $v1"
out=$(human rollback shipping-assistant 2>&1) || fail "rollback replay: $out"
echo "$out" | grep -q "already rolled back" || fail "rollback not idempotent: $out"
[ "$(sql "select count(*) from agent_promotion_audit where promotion_id='$pid2' and action='rolled_back'")" = 1 ] || fail "duplicate rollback audit rows"
ok "rollback is idempotent (one audit row)"

echo "== 5. audit trail"
acts=$(sql "select string_agg(action, ',' order by id) from agent_promotion_audit where agent_name='shipping-assistant'")
echo "  $acts"
for a in promote_blocked promote_requested approved canary_started rolled_back; do
  echo "$acts" | grep -q "$a" || fail "audit missing $a"
done
sql "update agent_promotion_audit set actor='x'" 2>/dev/null && fail "audit must be append-only" || true
ok "every decision audited; table is append-only"
echo "E2E PASS"
