#!/usr/bin/env bash
# Send a signed fixture alert to a PAL webhook trigger.
#   ./send-fixture.sh sentry|pagerduty <hook-url> <trigger-secret> [delivery-id]
# Same bytes and headers the provider sends; the same delivery id is deduplicated.
set -euo pipefail
kind=${1:?sentry|pagerduty}; url=${2:?hook url}; secret=${3:?trigger secret}; delivery=${4:-$(uuidgen)}
dir="$(dirname "$0")/fixtures"
case "$kind" in
  sentry)    body="$dir/sentry.alert.json"
             sig=$(openssl dgst -sha256 -hmac "$secret" <"$body" | awk '{print $NF}')
             hdr=(-H "Sentry-Hook-Signature: $sig" -H "Sentry-Hook-Resource: event_alert" -H "Request-ID: $delivery") ;;
  pagerduty) body="$dir/pagerduty.incident.triggered.json"
             sig=$(openssl dgst -sha256 -hmac "$secret" <"$body" | awk '{print $NF}')
             hdr=(-H "X-PagerDuty-Signature: v1=$sig") ;;
  *) echo "unknown kind $kind" >&2; exit 2 ;;
esac
curl -sS -X POST "$url" -H "Content-Type: application/json" "${hdr[@]}" --data-binary "@$body"
echo
