#!/usr/bin/env bash
# runtime-latency.sh — benchmark runtime operations against a live PAL Runtime stack.
#
# Measures p50/p95 latency (milliseconds) and host RSS delta (MiB) for:
#   - cold schedule → RUNNING
#   - exec round-trip
#   - pause
#   - resume
#   - fork N=1 / N=10 / N=100
#
# Outputs JSON to stdout and a markdown table to stderr. For the Lima/KVM
# numbers in docs/benchmarks/runtime-latency.md see microvm-latency.sh, which
# needs only the runtime-manager, not the whole stack.
#
# PREREQUISITES (Linux + KVM only)
# ─────────────────────────────────
# • /dev/kvm readable                      (firecracker requires KVM)
# • PAL_API_URL env var                (default: http://localhost:8080)
# • PAL_API_TOKEN env var              (Bearer token for an admin account)
# • jq, curl, awk, /proc/meminfo present
#
# Usage:
#   export PAL_API_URL=http://localhost:8080
#   export PAL_API_TOKEN=<bearer-token>
#   bash scripts/bench/runtime-latency.sh [--iterations N] [--image-digest sha256:...]
#
# On non-Linux hosts or without KVM this script prints a SKIP notice and exits 0.

set -euo pipefail

# ── host guard ─────────────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "SKIP: runtime-latency bench requires Linux (this is $(uname -s)); not running." >&2
  exit 0
fi
if [[ ! -r /dev/kvm ]]; then
  echo "SKIP: /dev/kvm not readable; Firecracker microVM benchmarks cannot run." >&2
  exit 0
fi

# ── defaults ────────────────────────────────────────────────────────────────────
API_URL="${PAL_API_URL:-http://localhost:8080}"
TOKEN="${PAL_API_TOKEN:-}"
ITERATIONS=5          # per-operation sample count (override with --iterations N)
IMAGE_DIGEST="${PAL_BENCH_IMAGE:-sha256:placeholder}"   # must be a real digest in prod
TENANT_ID="${PAL_BENCH_TENANT:-}"

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") [--iterations N] [--image-digest sha256:...]
  --iterations N       number of samples per operation (default: $ITERATIONS)
  --image-digest D     agent image digest to schedule (default: $IMAGE_DIGEST)
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --iterations) ITERATIONS="$2"; shift 2;;
    --image-digest) IMAGE_DIGEST="$2"; shift 2;;
    -h|--help) usage;;
    *) echo "Unknown arg: $1" >&2; usage;;
  esac
done

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: PAL_API_TOKEN is not set." >&2
  exit 1
fi

command -v jq  >/dev/null 2>&1 || { echo "ERROR: jq not found." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl not found." >&2; exit 1; }

# ── helpers ──────────────────────────────────────────────────────────────────

api() {
  local method="$1"; shift
  local path="$1"; shift
  curl -sS -X "$method" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "$@" \
    "${API_URL}${path}"
}

# time_ms <cmd...>  →  elapsed milliseconds printed to stdout.
time_ms() {
  local start end
  start=$(date +%s%N)
  "$@"
  end=$(date +%s%N)
  echo $(( (end - start) / 1000000 ))
}

# rss_mib  →  current /proc/meminfo MemUsed in MiB (best-effort host proxy).
rss_mib() {
  awk '/^MemTotal:/{total=$2} /^MemAvailable:/{avail=$2} END{printf "%.1f", (total-avail)/1024}' \
    /proc/meminfo
}

# percentile <p> <file-of-numbers>
percentile() {
  local p="$1" file="$2"
  sort -n "$file" | awk -v p="$p" 'BEGIN{n=0}{a[n++]=$1} END{
    i=int(n * p / 100 + 0.5) - 1
    if(i<0)i=0; if(i>=n)i=n-1
    printf "%d", a[i]
  }'
}

# collect <name> <count> <cmd...>  →  runs cmd N times, collects ms samples.
collect() {
  local name="$1" count="$2"; shift 2
  local tmpfile
  tmpfile=$(mktemp)
  local i
  for (( i=0; i<count; i++ )); do
    time_ms "$@" >> "$tmpfile"
  done
  local p50 p95
  p50=$(percentile 50 "$tmpfile")
  p95=$(percentile 95 "$tmpfile")
  rm -f "$tmpfile"
  printf '{"name":"%s","p50_ms":%d,"p95_ms":%d,"samples":%d}' \
    "$name" "$p50" "$p95" "$count"
}

# ── benchmark operations ─────────────────────────────────────────────────────

schedule_one() {
  local resp vm_id
  resp=$(api POST /v1/runtime/schedule -d "{
    \"image_digest\": \"$IMAGE_DIGEST\",
    \"isolation\": \"microvm\"
  }")
  vm_id=$(echo "$resp" | jq -r '.vmId // empty')
  [[ -n "$vm_id" ]] || { echo "schedule_one: no vmId in response: $resp" >&2; return 1; }
  # poll until running (best-effort, up to 30s)
  local n=0
  until [[ "$(api GET /v1/runtime/vms/"$vm_id" | jq -r '.state')" == "running" ]]; do
    sleep 0.5
    (( n++ )); [[ $n -lt 60 ]] || break
  done
  echo "$vm_id"
}

bench_exec() {
  local vm_id="$1"
  api POST /v1/runtime/vms/"$vm_id"/exec -d '{"command":"/bin/true","argv":[]}' > /dev/null
}

bench_pause() {
  local vm_id="$1"
  api POST /v1/runtime/vms/"$vm_id"/pause -d '{}' > /dev/null
}

bench_resume() {
  local vm_id="$1"
  api POST /v1/runtime/vms/"$vm_id"/resume -d '{}' > /dev/null
  # poll to running
  local n=0
  until [[ "$(api GET /v1/runtime/vms/"$vm_id" | jq -r '.state')" == "running" ]]; do
    sleep 0.5; (( n++ )); [[ $n -lt 60 ]] || break
  done
}

bench_fork() {
  local vm_id="$1" count="$2"
  local resp
  resp=$(api POST /v1/runtime/vms/"$vm_id"/fork -d "{\"count\":$count}")
  # clean up the fork children immediately
  echo "$resp" | jq -r '.forks[].vmId // empty' | while read -r child; do
    api DELETE /v1/runtime/vms/"$child" -d '{}' > /dev/null 2>&1 || true
  done
}

# ── main ─────────────────────────────────────────────────────────────────────

echo "PAL Runtime runtime-latency bench  $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
echo "API: $API_URL | iterations: $ITERATIONS" >&2

results=()

# 1. Cold schedule latency (includes VM boot)
echo "[1/$((ITERATIONS+3))] cold schedule latency…" >&2
vm_ids=()
schedtmp=$(mktemp)
for (( i=0; i<ITERATIONS; i++ )); do
  start=$(date +%s%N)
  vm=$(schedule_one)
  end=$(date +%s%N)
  echo $(( (end - start) / 1000000 )) >> "$schedtmp"
  vm_ids+=("$vm")
done
p50=$(percentile 50 "$schedtmp"); p95=$(percentile 95 "$schedtmp")
rm -f "$schedtmp"
results+=("$(printf '{"name":"cold_schedule","p50_ms":%d,"p95_ms":%d,"samples":%d}' "$p50" "$p95" "$ITERATIONS")")

# Use the first live VM for subsequent ops
BENCH_VM="${vm_ids[0]}"

# Cleanup extra scheduled VMs
for (( i=1; i<${#vm_ids[@]}; i++ )); do
  api DELETE /v1/runtime/vms/"${vm_ids[$i]}" -d '{}' > /dev/null 2>&1 || true
done

# 2. Exec round-trip
echo "[2] exec round-trip latency…" >&2
results+=("$(collect "exec_roundtrip" "$ITERATIONS" bench_exec "$BENCH_VM")")

# 3. Pause (RUNNING→PAUSED)
echo "[3] pause latency…" >&2
ptmp=$(mktemp)
for (( i=0; i<ITERATIONS; i++ )); do
  # ensure running
  bench_resume "$BENCH_VM" 2>/dev/null || true
  time_ms bench_pause "$BENCH_VM" >> "$ptmp"
done
p50=$(percentile 50 "$ptmp"); p95=$(percentile 95 "$ptmp")
rm -f "$ptmp"
results+=("$(printf '{"name":"pause","p50_ms":%d,"p95_ms":%d,"samples":%d}' "$p50" "$p95" "$ITERATIONS")")

# 4. Resume (PAUSED→RUNNING)
echo "[4] resume latency…" >&2
rtmp=$(mktemp)
for (( i=0; i<ITERATIONS; i++ )); do
  bench_pause "$BENCH_VM" 2>/dev/null || true
  time_ms bench_resume "$BENCH_VM" >> "$rtmp"
done
p50=$(percentile 50 "$rtmp"); p95=$(percentile 95 "$rtmp")
rm -f "$rtmp"
results+=("$(printf '{"name":"resume","p50_ms":%d,"p95_ms":%d,"samples":%d}' "$p50" "$p95" "$ITERATIONS")")

# 5. Fork N=1 / N=10 / N=100
for fork_n in 1 10 100; do
  echo "[5] fork N=$fork_n latency…" >&2
  # ensure source is running
  bench_resume "$BENCH_VM" 2>/dev/null || true
  rss_before=$(rss_mib)
  ftmp=$(mktemp)
  for (( i=0; i<ITERATIONS; i++ )); do
    time_ms bench_fork "$BENCH_VM" "$fork_n" >> "$ftmp"
  done
  rss_after=$(rss_mib)
  p50=$(percentile 50 "$ftmp"); p95=$(percentile 95 "$ftmp")
  rm -f "$ftmp"
  rss_delta=$(awk "BEGIN{printf \"%.1f\", $rss_after - $rss_before}")
  results+=("$(printf '{"name":"fork_%d","p50_ms":%d,"p95_ms":%d,"samples":%d,"rss_delta_mib_total":%s,"rss_mib_per_fork":%s}' \
    "$fork_n" "$p50" "$p95" "$ITERATIONS" "$rss_delta" \
    "$(awk "BEGIN{printf \"%.2f\", $rss_delta / $fork_n}")")")
done

# cleanup bench VM
api DELETE /v1/runtime/vms/"$BENCH_VM" -d '{}' > /dev/null 2>&1 || true

# ── output ────────────────────────────────────────────────────────────────────
json_out="$(printf '[%s]' "$(IFS=','; echo "${results[*]}")")"
echo "$json_out"

# Markdown table
md_table() {
  echo "| Operation | p50 (ms) | p95 (ms) | Samples | RSS Δ / fork (MiB) |"
  echo "|-----------|----------|----------|---------|---------------------|"
  echo "$json_out" | jq -r '.[] |
    "| \(.name) | \(.p50_ms) | \(.p95_ms) | \(.samples) | \(.rss_mib_per_fork // "n/a") |"'
}

# Bug fix: this used to overwrite the doc's results block with a placeholder
# on every run (it never wrote the table). Print the table instead.
md_table >&2

exit 0
