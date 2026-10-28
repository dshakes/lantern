#!/usr/bin/env bash
# eval.sh [agent-dir] - run the eval suite against a candidate agent.yaml and record it.
#
#   1. stage the candidate's system prompt on a staging agent (<name>-ci)
#   2. run every case in eval/suite.json through POST /v1/runs and score it here:
#      the server does not score cases, it stores the per-case results you POST
#   3. POST /v1/eval-runs. 422 = regressed vs. the baseline pinned for EVAL_BRANCH.
#
# Exit 0: clean. Exit 1: regression or a failing case (the job must stop before deploy).
# Exit 2: setup error. Writes $EVAL_RESULT (default .eval-result.json) for release.sh.
#
# env: LANTERN_API_URL (http://host:8080), LANTERN_API_KEY (JWT or API key with
#      agents:write, runs:execute and runs:write scopes)
#      EVAL_BRANCH     baseline branch to gate against (default main; PRs gate against main)
#      STAGING_AGENT   staging agent name (default <name>-ci)
#      EVAL_PIN=1      on success, pin this run as the baseline for EVAL_BRANCH (do this on main)
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
dir=${1:-.}
: "${LANTERN_API_URL:?set LANTERN_API_URL}" "${LANTERN_API_KEY:?set LANTERN_API_KEY}"
api=${LANTERN_API_URL%/}
branch=${EVAL_BRANCH:-main}
out=${EVAL_RESULT:-.eval-result.json}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# call METHOD PATH [JSON-BODY] -> $status, body in $tmp/body
call() {
  local args=(-sS -o "$tmp/body" -w '%{http_code}' -X "$1" -H "Authorization: Bearer $LANTERN_API_KEY" "$api$2")
  [ $# -ge 3 ] && args+=(-H 'Content-Type: application/json' -d "$3")
  status=$(curl "${args[@]}") || { echo "eval: cannot reach $api" >&2; exit 2; }
}

# agent.yaml: name + a block-literal system_prompt (the only shape this script reads)
manifest="$dir/agent.yaml"
name=$(sed -nE 's/^name:[[:space:]]*"?([^"#]*)"?.*/\1/p' "$manifest" | head -1 | xargs)
version=$(sed -nE 's/^version:[[:space:]]*"?([^"#]*)"?.*/\1/p' "$manifest" | head -1 | xargs)
prompt=$(awk '/^system_prompt:[[:space:]]*\|/{f=1;next} f&&/^[^[:space:]]/{f=0} f{sub(/^  /,"");print}' "$manifest")
[ -n "$name" ] && [ -n "$prompt" ] || { echo "eval: $manifest needs name and a 'system_prompt: |' block" >&2; exit 2; }
staging=${STAGING_AGENT:-$name-ci}

# 1. stage the candidate
call GET "/v1/agents/$staging"
if [ "$status" = 404 ]; then
  call POST /v1/agents "$(jq -n --arg n "$staging" --arg p "$prompt" '{name:$n,description:"eval staging",systemPrompt:$p,model:"auto"}')"
else
  call PATCH "/v1/agents/$staging" "$(jq -n --arg p "$prompt" '{systemPrompt:$p}')"
fi
case $status in 200|201|204) ;; *) echo "eval: stage $staging: HTTP $status $(cat "$tmp/body")" >&2; exit 2;; esac

# the suite is recorded against the real agent name, so the baseline gates that agent
call POST /v1/eval-suites "$(jq --arg a "$name" '.agentName=$a' "$here/eval/suite.json")"
[ "$status" = 200 ] || { echo "eval: upsert suite: HTTP $status $(cat "$tmp/body")" >&2; exit 2; }
suite=$(jq -r .id "$tmp/body")

# 2. run + score each case
results=()
last=""
start=$(date +%s)
while IFS= read -r c; do
  cname=$(jq -r .name <<<"$c"); input=$(jq -r .input <<<"$c"); need=$(jq -r '.assert.contains' <<<"$c")
  call POST /v1/runs "$(jq -n --arg a "$staging" --arg i "$input" '{agentName:$a,input:{prompt:$i}}')"
  [ "$status" = 201 ] || { echo "eval: run '$cname': HTTP $status $(cat "$tmp/body")" >&2; exit 2; }
  id=$(jq -r .id "$tmp/body"); last=$id
  for _ in $(seq 1 90); do
    call GET "/v1/runs/$id"
    case $(jq -r .status "$tmp/body") in succeeded|failed|cancelled) break;; esac
    sleep 1
  done
  results+=("$(jq -c --arg n "$cname" --arg need "$need" '
    ((.output.result // .output.text // .output.output // (.output | tostring)) // "") as $a
    | ($a | contains($need)) as $ok
    | {name:$n, passed:$ok, score:(if $ok then 1 else 0 end), actual:$a, expected:$need, costUsd:(.costUsd // 0)}' "$tmp/body")")
  echo "  $cname: $(jq -r 'if .passed then "PASS" else "FAIL" end' <<<"${results[${#results[@]}-1]}")"
done < <(jq -c '.cases[]' "$here/eval/suite.json")

# 3. record. 422 = regression vs. the baseline
ms=$((($(date +%s) - start) * 1000))
body=$(printf '%s\n' "${results[@]}" | jq -s --arg s "$suite" --arg r "$last" --arg v "$version" --arg sha "${GITHUB_SHA:-}" --arg b "$branch" --argjson ms "$ms" \
  '{suiteId:$s, runId:$r, agentVersion:$v, commitSha:$sha, branch:$b, durationMs:$ms, caseResults:.}')
call POST /v1/eval-runs "$body"
case $status in 200|422) ;; *) echo "eval: record: HTTP $status $(cat "$tmp/body")" >&2; exit 2;; esac
jq -c --arg r "$last" --arg a "$name" --arg st "$staging" --argjson http "$status" '. + {runId:$r, agentName:$a, staging:$st, http:$http}' "$tmp/body" >"$out"
echo "eval: HTTP $status $(cat "$out")"

if [ "$status" = 422 ] || ! jq -e '.passed' "$out" >/dev/null; then
  echo "eval gate: FAILED (regressed or a case failed) - not deploying" >&2
  exit 1
fi
if [ "${EVAL_PIN:-}" = 1 ]; then
  call POST /v1/eval-baselines "$(jq -n --arg a "$name" --arg b "$branch" --arg id "$(jq -r .id "$out")" '{agentName:$a,branch:$b,evalRunId:$id}')"
  [ "$status" = 200 ] || { echo "eval: pin baseline: HTTP $status" >&2; exit 2; }
  echo "eval: pinned baseline for $name @ $branch"
fi
