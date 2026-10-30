#!/usr/bin/env bash
# ADR 0032: a release created before the PAL rename (name contains "lantern") must keep its object,
# selector and PVC names, or `helm upgrade` replaces Deployments/StatefulSets and orphans the volumes.
# New releases get the pal-* names. Usage: infra/helm/pal/tests/fullname-stability.sh (needs helm)
set -euo pipefail
H="$(cd "$(dirname "$0")/../.." && pwd)"
helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true
for c in pal pal-control-plane pal-data-plane; do (cd "$H/$c" && helm dependency build >/dev/null); done
SETS=(--set backup.s3Bucket=lint --set externalDatabase.host=db.example
      --set externalS3.endpoint=https://s3.example --set externalS3.accessKeyId=k)
fail() { echo "FAIL: $*"; exit 1; }

render() { helm template "$@" "${SETS[@]}"; }

# all-in-one chart, legacy release name: statefulsets keep lantern-* names and selectors
out=$(render lantern "$H/pal" -f "$H/pal/values-dev.yaml")
for n in lantern-postgresql lantern-minio; do
  grep -qE "^  name: $n\$" <<<"$out" || fail "legacy release lost object name $n"
done
grep -q 'app.kubernetes.io/name: lantern$' <<<"$out" || fail "legacy selector label app.kubernetes.io/name: lantern missing"
! grep -q 'lantern-pal' <<<"$out" || fail "legacy release rendered lantern-pal-* names"

# new release name: pal-* names and selectors
out=$(render pal "$H/pal" -f "$H/pal/values-dev.yaml")
grep -qE '^  name: pal-postgresql$' <<<"$out" || fail "new release should be named pal-postgresql"
grep -q 'app.kubernetes.io/name: pal$' <<<"$out" || fail "new release selector should be app.kubernetes.io/name: pal"

# split charts, legacy release names
out=$(render lantern-dp "$H/pal-data-plane")
grep -q 'lantern-dp-lantern-data-plane-' <<<"$out" || fail "data-plane legacy release lost old names"
! grep -q 'lantern-dp-pal-' <<<"$out" || fail "data-plane legacy release rendered lantern-dp-pal-* names"
out=$(render lantern "$H/pal-control-plane")
grep -q 'lantern-control-plane' <<<"$out" || fail "control-plane legacy release lost old names"
! grep -q 'lantern-pal-' <<<"$out" || fail "control-plane legacy release rendered lantern-pal-* names"
echo "ok: legacy release names keep their object/selector/PVC names; new releases are pal-*"
