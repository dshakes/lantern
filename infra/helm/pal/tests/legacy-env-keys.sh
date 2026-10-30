#!/usr/bin/env bash
# ADR 0032: values files written against the old chart keep working. A legacy
# `PAL_ENV` / `PAL_RLS_ENFORCE` / `PAL_AUTHZ_ENFORCE` key is still
# honored (rendered as the PAL_* container env), and the PAL_* key wins when both are set.
# Usage: infra/helm/pal/tests/legacy-env-keys.sh   (needs helm)
set -euo pipefail
C="$(cd "$(dirname "$0")/.." && pwd)"
helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true
(cd "$C" && helm dependency build >/dev/null)
SETS=(--set backup.s3Bucket=lint --set externalDatabase.host=db.example
      --set externalS3.endpoint=https://s3.example --set externalS3.accessKeyId=k)

# render <env-name> <helm --set args...>  -> the value rendered for that container env var
val() {
  local name=$1; shift
  helm template t "$C" "${SETS[@]}" "$@" |
    awk -v n="$name" '$0 ~ "- name: "n"$" { getline; print; exit }' | sed 's/^ *//'
}

for k in ENV RLS_ENFORCE AUTHZ_ENFORCE; do
  got=$(val "PAL_$k" --set "controlPlane.env.PAL_$k=legacy")
  [ "$got" = 'value: "legacy"' ] || { echo "FAIL: legacy PAL_$k not honored (got: $got)"; exit 1; }
  got=$(val "PAL_$k" --set "controlPlane.env.PAL_$k=new" --set "controlPlane.env.PAL_$k=legacy")
  [ "$got" = 'value: "new"' ] || { echo "FAIL: PAL_$k must win over PAL_$k (got: $got)"; exit 1; }
done
echo "ok: legacy PAL_* values keys honored, PAL_* wins"
