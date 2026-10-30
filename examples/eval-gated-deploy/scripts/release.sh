#!/usr/bin/env bash
# release.sh [agent-dir] - deploy a candidate that passed eval.sh, then prove it.
#   pal deploy --json -> POST /v1/runs/{id}/receipt -> POST /v1/runs/receipts/verify
# Refuses to run unless eval.sh left a clean $EVAL_RESULT. The receipt is for the eval
# run that gated the deploy; eval.sh passed that run id to POST /v1/eval-runs, which
# journaled an eval_result event on it, so the signature covers the score.
# env: PAL_API_URL, PAL_API_KEY (as eval.sh), PAL_CLI (CLI binary, default pal; legacy LANTERN also read)
#      EVAL_RESULT / DEPLOY_JSON / RECEIPT_JSON: file paths (defaults .eval-result.json,
#      .deploy.json, .receipt.json)
set -euo pipefail
dir=${1:-.}
: "${PAL_API_URL:=${LANTERN_API_URL:-}}" "${PAL_API_KEY:=${LANTERN_API_KEY:-}}"
: "${PAL_API_URL:?set PAL_API_URL (LANTERN_API_URL still accepted)}" "${PAL_API_KEY:?set PAL_API_KEY (LANTERN_API_KEY still accepted)}"
api=${PAL_API_URL%/}
res=${EVAL_RESULT:-.eval-result.json}
deploy=${DEPLOY_JSON:-.deploy.json}
receipt=${RECEIPT_JSON:-.receipt.json}

jq -e '.passed == true and .regressed == false' "$res" >/dev/null 2>&1 \
  || { echo "release: no clean eval result at $res - refusing to deploy" >&2; exit 1; }

(cd "$dir" && "${PAL_CLI:-${LANTERN:-pal}}" deploy --json) >"$deploy"
echo "release: deployed $(jq -c '{id,status,url}' "$deploy")"

run=$(jq -r .runId "$res")
curl -fsS -X POST -H "Authorization: Bearer $PAL_API_KEY" "$api/v1/runs/$run/receipt" >"$receipt"
verdict=$(curl -fsS -X POST -H 'Content-Type: application/json' -d @"$receipt" "$api/v1/runs/receipts/verify")
echo "release: receipt verify -> $verdict"
jq -e '.valid == true' <<<"$verdict" >/dev/null || { echo "release: receipt did not verify" >&2; exit 1; }
