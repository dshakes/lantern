#!/usr/bin/env bash
# Render the chart's SLO PrometheusRule, then lint it and run the alert unit
# tests with promtool (ADR 0041). Needs: helm, python3 + PyYAML, promtool
# (PROMTOOL=/path/to/promtool, or on PATH).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
chart="$here/../../helm/pal"
promtool="${PROMTOOL:-promtool}"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

[ -d "$chart/charts" ] || helm dependency build "$chart" >/dev/null
helm template lantern "$chart" -f "$chart/values-prod.yaml" \
  --set backup.s3Bucket=lint --set externalDatabase.host=db.example \
  --set externalS3.endpoint=https://s3.example --set externalS3.accessKeyId=k \
  --show-only templates/monitoring/prometheusrule.yaml |
  python3 -I -c 'import sys,yaml; print(yaml.safe_dump({"groups": yaml.safe_load(sys.stdin)["spec"]["groups"]}))' \
    >"$out/slo-rules.yml"

"$promtool" check rules "$out/slo-rules.yml"
cp "$here"/tests/*.test.yml "$out/"
(cd "$out" && "$promtool" test rules ./*.test.yml)
