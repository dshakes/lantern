#!/usr/bin/env bash
# Real end-to-end for `pal ci` (ADR 0053): a fresh control-plane on private ports
# with the llm-replay fixture, then the generated .pal/ci.sh run for real in a
# scratch repo. Proves: green run, baseline pin, 422 regression gate, policy
# failure that spends nothing. No live provider key is used.
#
#   E2E_AGENT_CI_PG_URL=postgres://u:p@127.0.0.1:PORT/db?sslmode=disable \
#   E2E_AGENT_CI_REDIS_URL=redis://127.0.0.1:PORT/0 scripts/e2e-agent-ci.sh
#
# The database must be a throwaway one (the server migrates it). Never point
# this at the shared dev/live database.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${E2E_AGENT_CI_PG_URL:?throwaway Postgres URL required}"
: "${E2E_AGENT_CI_REDIS_URL:?throwaway Redis URL required}"
API_PORT=${E2E_AGENT_CI_API_PORT:-18581}
GRPC_PORT=${E2E_AGENT_CI_GRPC_PORT:-18552}
LLM_PORT=${E2E_AGENT_CI_LLM_PORT:-19292}

tmp=$(mktemp -d)
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "E2E FAIL: $*" >&2; exit 1; }

(cd services/control-plane && go build -o "$tmp/llm-replay" ./cmd/llm-replay && go build -o "$tmp/server" ./cmd/server)
mkdir -p "$tmp/bin"
(cd packages/cli && go build -o "$tmp/bin/pal" ./cmd/pal)

python3 - "$tmp/rules.json" <<'PY'
import json, sys
# reuses the eval-gated-deploy fixture: its "[policy-pack: legacy]" rule is the regression trigger used in step 2
rules = json.load(open("examples/eval-gated-deploy/fixtures/llm-rules.json"))
json.dump(rules, open(sys.argv[1], "w"))
PY

"$tmp/llm-replay" -addr "127.0.0.1:$LLM_PORT" -rules "$tmp/rules.json" >"$tmp/llm.log" 2>&1 & pids+=($!)
llm="http://127.0.0.1:$LLM_PORT"
env DATABASE_URL="$E2E_AGENT_CI_PG_URL" REDIS_URL="$E2E_AGENT_CI_REDIS_URL" \
  HTTP_ADDR="127.0.0.1:$API_PORT" LISTEN_ADDR="127.0.0.1:$GRPC_PORT" LOG_LEVEL=warn \
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

# the repo under test (HOME is scratch: the CLI never reads the real one)
repo="$tmp/repo"; mkdir -p "$repo/eval"
export HOME="$tmp/home"; mkdir -p "$HOME"
cat >"$repo/agent.yaml" <<'YAML'
name: shipping-assistant
version: "0.1.0"
model: auto
system_prompt: |
  You are the shipping assistant for an online shop. Answer delivery questions in one short sentence.
limits:
  max_cost_usd: 0.50
egress: []
YAML
cd "$repo"
git init -q . && git checkout -q -b main

curl -fs -X POST "$api/v1/eval-suites" "${auth[@]}" -d '{
  "agentName":"shipping-assistant","name":"ci","description":"e2e",
  "cases":[
   {"name":"standard-delivery","input":"How many days does standard delivery take?","assert":{"contains":"3-5 business days"}},
   {"name":"track-order","input":"Where can I track my parcel?","assert":{"contains":"Orders page"}}]}' >/dev/null

export PATH="$tmp/bin:$PATH" PAL_API_URL="$api" PAL_API_KEY="$tok" PAL_CI_STAGING_ACK=1 PAL_CLI_PATH="$tmp/bin/pal"  # prebuilt binary; the release-download path is covered by unit tests with a shimmed curl
pal ci init --suite ci
[ -x .pal/ci.sh ] && [ -f .github/workflows/pal-agent-ci.yml ] || fail "init did not write the files"
pal ci init --check >/dev/null || fail "--check failed on fresh files"

echo "== 1. main push: green + pin baseline"
PAL_CI_BASELINE_BRANCH=main PAL_CI_SET_BASELINE=1 .pal/ci.sh >"$tmp/run1.txt" || { cat "$tmp/run1.txt"; fail "green run failed"; }
python3 - <<'PY' || fail "report 1"
import json; r = json.load(open("pal-ci-report.json"))
assert r["passed"] and [g["status"] for g in r["gates"]] == ["pass"] * 4, r
PY

echo "== 2. PR: regressed candidate must fail the 422 gate"
sed -i.bak 's/one short sentence\./one short sentence. [policy-pack: legacy]/' agent.yaml
if PAL_CI_BASELINE_BRANCH=main .pal/ci.sh >"$tmp/run2.txt" 2>&1; then cat "$tmp/run2.txt"; fail "regressed PR passed the gate"; fi
python3 - <<'PY' || fail "report 2"
import json; r = json.load(open("pal-ci-report.json"))
g = {x["id"]: x for x in r["gates"]}
assert not r["passed"] and g["eval"]["status"] == "fail", r
assert any(f["rule"] in ("PAL-EVAL-002", "PAL-EVAL-003") for f in g["eval"]["findings"]), g["eval"]
PY
grep -q "pal-ci-report" pal-ci-summary.md || fail "PR summary marker missing"

echo "== 3. PR: good candidate passes again"
mv agent.yaml.bak agent.yaml
PAL_CI_BASELINE_BRANCH=main .pal/ci.sh >"$tmp/run3.txt" 2>&1 || { cat "$tmp/run3.txt"; fail "good PR failed"; }

echo "== 4. policy violation: fails without running the eval"
sed -i.bak 's/^model: auto/model: gpt-4o/' agent.yaml
before=$(curl -fs "${auth[@]}" "$api/v1/runs" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d if isinstance(d,list) else d.get("runs",[])))')
if PAL_CI_BASELINE_BRANCH=main .pal/ci.sh >"$tmp/run4.txt" 2>&1; then fail "policy violation passed"; fi
after=$(curl -fs "${auth[@]}" "$api/v1/runs" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d if isinstance(d,list) else d.get("runs",[])))')
[ "$before" = "$after" ] || fail "runs were created after a policy failure ($before -> $after)"
python3 - <<'PY' || fail "report 4"
import json; r = json.load(open("pal-ci-report.json"))
assert [g["status"] for g in r["gates"]] == ["pass", "fail", "skipped", "skipped"], r
PY
echo "E2E OK"
