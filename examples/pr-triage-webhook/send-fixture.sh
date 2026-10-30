#!/usr/bin/env bash
# Send the signed pull_request.opened fixture to a PAL webhook trigger.
#   ./send-fixture.sh <hook-url> <trigger-secret> [delivery-id]
# Same bytes and headers GitHub sends; re-running with the same delivery id is
# deduplicated (no second run).
set -euo pipefail
url=${1:?hook url, e.g. http://localhost:8080/v1/hooks/<trigger-id>}
secret=${2:?trigger secret}
delivery=${3:-$(uuidgen)}
body="$(dirname "$0")/fixtures/pull_request.opened.json"
sig="sha256=$(openssl dgst -sha256 -hmac "$secret" <"$body" | awk '{print $NF}')"
curl -sS -X POST "$url" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: $delivery" \
  -H "X-Hub-Signature-256: $sig" \
  --data-binary "@$body"
echo
