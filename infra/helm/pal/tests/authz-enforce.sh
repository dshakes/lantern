#!/usr/bin/env bash
# Asserts the prod/staging overlays render PAL_AUTHZ_ENFORCE=1 on the
# control-plane, and the base values leave it empty (default off).
# Usage: infra/helm/pal/tests/authz-enforce.sh   (needs helm)
set -euo pipefail
C="$(cd "$(dirname "$0")/.." && pwd)"
# CI checks out without charts/ and with no repos registered; render needs the redis subchart.
helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true
helm dependency build "$C" >/dev/null
SETS=(--set backup.s3Bucket=lint --set externalDatabase.host=db.example
      --set externalS3.endpoint=https://s3.example --set externalS3.accessKeyId=k)
val() { # $1=values file or "" ; prints the rendered PAL_AUTHZ_ENFORCE value
  local f=(); [ -n "$1" ] && f=(-f "$C/$1")
  helm template pal "$C" ${f[@]+"${f[@]}"} "${SETS[@]}" |
    grep -A1 'name: PAL_AUTHZ_ENFORCE' | grep -o 'value: .*' | head -1
}
for v in values-prod.yaml values-staging.yaml; do
  [ "$(val $v)" = 'value: "1"' ] || { echo "FAIL: $v does not render PAL_AUTHZ_ENFORCE=1"; exit 1; }
done
[ "$(val '')" = 'value: ""' ] || { echo "FAIL: default values must leave PAL_AUTHZ_ENFORCE empty"; exit 1; }
echo "ok: authz enforce on in prod+staging, off by default"
