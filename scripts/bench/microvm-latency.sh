#!/usr/bin/env bash
# shellcheck disable=SC2016  # bash -c bodies expand in the child shell, on purpose
#
# microvm-latency.sh — Firecracker lifecycle latency, measured against a real
# runtime-manager on a Linux/KVM host. No control-plane / Postgres needed:
# it talks to the manager's gRPC API directly (the same surface the scheduler
# and the control-plane exec/pause/fork paths call).
#
# `runtime-latency.sh` (same dir) measures the same operations through the REST
# API and needs the whole stack; this is the one `make lima-bench` runs.
#
# Measured (ms, wall clock on the host, per sample):
#   grpc_floor            grpcurl ExecTool on an unknown vm (NotFound) — the
#                         client cost (process start + mTLS) inside every
#                         other number. Subtract it to get manager-side time.
#   cold_spawn_rpc        Spawn RPC turnaround (jail + TAP + firecracker start)
#   cold_boot_to_exec     Spawn start → first ExecTool answered (guest booted,
#                         harness up, mTLS heartbeat in; the manager holds the
#                         exec until then)
#   exec_roundtrip        ExecTool shell_exec "true" on a warm VM
#   snapshot              Snapshot RPC (pause, write mem + disk, resume)
#   stop                  Stop RPC
#   pause                 snapshot + stop (what POST /pause does)
#   restore_rpc           Spawn{restore_snapshot_id} turnaround
#   resume_to_exec        restore start → first ExecTool answered
#   fork_<N>_spawn_wall   N Spawn{restore} calls, 16 in flight (the
#                         control-plane's LANTERN_FORK_CONCURRENCY default)
#   fork_<N>_ready_wall   batch start → every fork answered an ExecTool (only
#                         for N <= FORK_READY_MAX, default 1 — see the doc)
#   fork_<N>_spawn_each   each successful fork's own Spawn RPC turnaround
#   fork_<N>_spawn_failures  failed Spawns per batch (sum = total failures)
#   broker_*              (broker egress mode, ADR 0026) exec baseline vs an
#                         allowed HTTPS http_fetch (guest → vsock → host
#                         broker → public upstream, BENCH_UPSTREAM_HOST, default
#                         example.com) vs a denied one (broker refuses, no
#                         upstream dial) vs host_curl_upstream (same URL, host)
#
# Inputs (env): FC_KERNEL_PATH FC_ROOTFS_PATH MANAGER_BIN (required);
#   FIRECRACKER_JAILER_PATH/_UID/_GID FIRECRACKER_CHROOT_BASE (fork needs the
#   jailer); ITERATIONS (default 20); FORK_SIZES (default "1 10 50");
#   FORK_ITERATIONS (default ITERATIONS); FORK_CONCURRENCY (default 16);
#   FORK_READY_MAX (default 1); BENCH_PORT (default 51060, broker
#   manager uses +1); OUT_DIR (default ./bench-out); SKIP_BROKER=1.
# Output: OUT_DIR/samples.csv (op,iter,ms), OUT_DIR/summary.json, summary.md.
#
# Run as root (TAP + jailer). Cleans up every VM, jail and snapshot it creates.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROTO_DIR="${REPO_ROOT}/packages/proto"
PROTO_FILE="lantern/v1/runtime.proto"
ITERATIONS="${ITERATIONS:-20}"
FORK_SIZES="${FORK_SIZES:-1 10 50}"
FORK_ITERATIONS="${FORK_ITERATIONS:-${ITERATIONS}}"
PORT="${BENCH_PORT:-51060}"
OUT_DIR="${OUT_DIR:-${PWD}/bench-out}"
TENANT="00000000-0000-0000-0000-000000000001"
DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000001"
TOKEN="bench-token"

log()  { printf '\033[1;34m[bench]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[bench] FAIL:\033[0m %b\n' "$*" >&2; exit 1; }

[ -r /dev/kvm ] || fail "/dev/kvm not readable"
[ -s "${FC_KERNEL_PATH:-}" ] && [ -s "${FC_ROOTFS_PATH:-}" ] || fail "FC_KERNEL_PATH/FC_ROOTFS_PATH unset"
[ -x "${MANAGER_BIN:-}" ] || fail "MANAGER_BIN unset or not executable"
for t in grpcurl jq openssl xargs python3 curl; do command -v "$t" >/dev/null || fail "missing $t"; done

WORK="$(mktemp -d /tmp/microvm-bench.XXXXXX)"
mkdir -p "${OUT_DIR}"
SAMPLES="${OUT_DIR}/samples.csv"
echo "op,iter,ms" >"${SAMPLES}"
: >"${WORK}/vms"; : >"${WORK}/snaps"
export WORK PROTO_DIR PROTO_FILE TOKEN TENANT DIGEST

ms() { date +%s%3N; }
rec() { echo "$1,$2,$3" >>"${SAMPLES}"; }

# g <addr> <rpc> <json>
g() {
  grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" \
    -servername localhost -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -H "x-lantern-service-token: ${TOKEN}" -max-time 330 -d "$3" "$1" "lantern.v1.RuntimeManager/$2"
}
export -f g

spawn_req() { # spawn_req <run_id> [snapshot_id vm_id]
  jq -cn --arg t "${TENANT}" --arg d "${DIGEST}" --arg r "$1" --arg s "${2:-}" --arg v "${3:-}" '
    {spec:{tenant_id:$t, image_digest:$d, isolation:"ISOLATION_HOSTILE",
           limits:{vcpu:"1", memory:"128Mi", timeout:"300s"}, run_id:$r,
           command:["/usr/local/bin/lantern-harness"]}}
    | if $s != "" then .spec.restore_snapshot_id = $s | .handle = {vm_id:$v} else . end'
}
tool_req() { # tool_req <vm_id> <tool> <args-json> <key>
  jq -cn --arg v "$1" --arg n "$2" --argjson a "$3" --arg k "$4" \
    '{vm_id:$v, run_id:"bench", step_id:$k, tool_name:$n, args:$a, idempotency_key:("bench:"+$k)}'
}
export -f tool_req
exec_ok() { # exec_ok <addr> <vm> <key> — shell_exec "true" must come back OK
  g "$1" ExecTool "$(tool_req "$2" shell_exec '{"command":"true"}' "$3")" 2>/dev/null \
    | jq -e '(.status // "") | test("OK")' >/dev/null
}
export -f exec_ok

start_manager() { # start_manager <port> <extra env...>
  local port="$1"; shift
  # shellcheck disable=SC2016  # $$ expands in the child bash
  setsid bash -c 'echo $$ >"$1"; shift; exec "$@"' _ "${WORK}/pgid.${port}" env \
    RUNTIME_BACKEND=firecracker LISTEN_ADDR="0.0.0.0:${port}" LOG_LEVEL=info \
    LANTERN_GRPC_SERVICE_TOKEN="${TOKEN}" LANTERN_HARNESS_READY_TIMEOUT_MS=300000 \
    FC_KERNEL_PATH="${FC_KERNEL_PATH}" FC_ROOTFS_PATH="${FC_ROOTFS_PATH}" \
    LANTERN_MANAGER_TLS_CA="${WORK}/ca.crt" LANTERN_MANAGER_TLS_CERT="${WORK}/server.crt" \
    LANTERN_MANAGER_TLS_KEY="${WORK}/server.key" \
    LANTERN_VM_SIGNING_CA_CERT="${WORK}/ca.crt" LANTERN_VM_SIGNING_CA_KEY="${WORK}/ca.key" \
    LANTERN_VM_CERT_DIR="${WORK}/vm-certs.${port}" LANTERN_MEASUREMENT_GATE=warn \
    "$@" "${MANAGER_BIN}" >"${WORK}/manager.${port}.log" 2>&1 &
  for _ in $(seq 50); do [ -s "${WORK}/pgid.${port}" ] && break; sleep 0.1; done
  for _ in $(seq 150); do (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null && return 0; sleep 0.2; done
  fail "manager on :${port} never opened:\n$(tail -30 "${WORK}/manager.${port}.log")"
}

stop_manager() {
  local f="${WORK}/pgid.$1" pg
  [ -s "${f}" ] || return 0
  pg="$(tr -dc 0-9 <"${f}")"; rm -f "${f}"
  [ -n "${pg}" ] && kill -TERM -- "-${pg}" 2>/dev/null
  sleep 1; [ -n "${pg}" ] && kill -KILL -- "-${pg}" 2>/dev/null
  return 0
}

drop_snapshot() {
  find /var/lib/lantern/snapshots -mindepth 3 -maxdepth 3 -type d -name "$1" -exec rm -r -- {} + 2>/dev/null
  return 0
}

cleanup() {
  local addr id pid
  for port in "${PORT}" "$((PORT + 1))"; do
    [ -s "${WORK}/pgid.${port}" ] || continue
    addr="127.0.0.1:${port}"
    sort -u "${WORK}/vms" | xargs -r -P 16 -I{} bash -c \
      'g "$0" Stop "{\"vm_id\":\"{}\",\"reason\":\"bench cleanup\"}" >/dev/null 2>&1' "${addr}"
  done
  # Backstop: any firecracker still carrying one of our ids (VMs setsid out of
  # the manager's group, so killing the manager does not reap them).
  for pid in $(pgrep -x firecracker); do
    while read -r id; do
      [ -n "${id}" ] && tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | grep -qF "${id}" \
        && { kill -KILL "${pid}" 2>/dev/null; break; }
    done <"${WORK}/vms"
  done
  stop_manager "${PORT}"; stop_manager "$((PORT + 1))"
  while read -r s; do [ -n "${s}" ] && drop_snapshot "${s}"; done <"${WORK}/snaps"
  cp "${WORK}"/manager.*.log "${OUT_DIR}/" 2>/dev/null
  rm -rf "${WORK}"
}
trap cleanup EXIT

log "minting certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "${WORK}/ca.key" -out "${WORK}/ca.crt" \
  -subj "/CN=bench-ca" -addext "basicConstraints=critical,CA:TRUE" >/dev/null 2>&1 || fail ca
for who in server client; do
  openssl req -newkey rsa:2048 -nodes -keyout "${WORK}/${who}.key" -out "${WORK}/${who}.csr" \
    -subj "/CN=${who}" >/dev/null 2>&1 || fail "${who} csr"
done
openssl x509 -req -in "${WORK}/server.csr" -CA "${WORK}/ca.crt" -CAkey "${WORK}/ca.key" -CAcreateserial \
  -days 1 -out "${WORK}/server.crt" -extfile <(printf 'subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:manager.lantern.internal\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE') >/dev/null 2>&1 || fail server
openssl x509 -req -in "${WORK}/client.csr" -CA "${WORK}/ca.crt" -CAkey "${WORK}/ca.key" -CAcreateserial \
  -days 1 -out "${WORK}/client.crt" -extfile <(printf 'extendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE') >/dev/null 2>&1 || fail client

# ───────────────────── phase A: guest egress mode, jailed ─────────────────────
A="127.0.0.1:${PORT}"
JAIL_ENV=()
[ -n "${FIRECRACKER_JAILER_PATH:-}" ] && JAIL_ENV=(
  FIRECRACKER_JAILER_PATH="${FIRECRACKER_JAILER_PATH}"
  FIRECRACKER_JAILER_UID="${FIRECRACKER_JAILER_UID:-123}"
  FIRECRACKER_JAILER_GID="${FIRECRACKER_JAILER_GID:-100}"
  FIRECRACKER_CHROOT_BASE="${FIRECRACKER_CHROOT_BASE:-/srv/jailer}")
log "starting manager on ${A} (jailer: ${FIRECRACKER_JAILER_PATH:-none})"
start_manager "${PORT}" "${JAIL_ENV[@]}"

log "grpc client floor (${ITERATIONS}×)"
for i in $(seq "${ITERATIONS}"); do
  t0=$(ms); g "${A}" ExecTool "$(tool_req no-such-vm shell_exec '{"command":"true"}' "floor-$i")" >/dev/null 2>&1
  rec grpc_floor "$i" $(( $(ms) - t0 ))
done

FORK_SNAP=""
for i in $(seq "${ITERATIONS}"); do
  log "lifecycle iteration ${i}/${ITERATIONS}"
  t0=$(ms)
  R=$(g "${A}" Spawn "$(spawn_req "bench-$i")" 2>&1) || fail "Spawn: ${R}"
  t1=$(ms)
  VM=$(jq -r '.handle.vmId // empty' <<<"${R}"); [ -n "${VM}" ] || fail "no vm_id: ${R}"
  echo "${VM}" >>"${WORK}/vms"
  exec_ok "${A}" "${VM}" "boot-$i" || fail "first exec after cold boot failed (vm ${VM})"
  t2=$(ms)
  rec cold_spawn_rpc "$i" $(( t1 - t0 )); rec cold_boot_to_exec "$i" $(( t2 - t0 ))

  for k in 1 2 3 4 5; do
    t0=$(ms); exec_ok "${A}" "${VM}" "x-$i-$k" || fail "exec round-trip failed"
    rec exec_roundtrip "$(( (i - 1) * 5 + k ))" $(( $(ms) - t0 ))
  done

  t0=$(ms); R=$(g "${A}" Snapshot "{\"vm_id\":\"${VM}\"}" 2>&1) || fail "Snapshot: ${R}"
  t1=$(ms)
  SNAP=$(jq -r '.snapshotId // empty' <<<"${R}"); [ -n "${SNAP}" ] || fail "no snapshot id: ${R}"
  echo "${SNAP}" >>"${WORK}/snaps"
  g "${A}" Stop "{\"vm_id\":\"${VM}\",\"reason\":\"bench pause\"}" >/dev/null 2>&1 || fail "Stop failed"
  t2=$(ms)
  rec snapshot "$i" $(( t1 - t0 )); rec stop "$i" $(( t2 - t1 )); rec pause "$i" $(( t2 - t0 ))
  [ "$i" -eq 1 ] && rec snapshot_bytes "$i" "$(jq -r '.bytes // 0' <<<"${R}")"

  t0=$(ms); R=$(g "${A}" Spawn "$(spawn_req "bench-r-$i" "${SNAP}" "${VM}")" 2>&1) || fail "restore: ${R}"
  t1=$(ms)
  exec_ok "${A}" "${VM}" "resume-$i" || fail "first exec after restore failed (vm ${VM})"
  t2=$(ms)
  rec restore_rpc "$i" $(( t1 - t0 )); rec resume_to_exec "$i" $(( t2 - t0 ))
  g "${A}" Stop "{\"vm_id\":\"${VM}\",\"reason\":\"bench\"}" >/dev/null 2>&1

  if [ "$i" -eq "${ITERATIONS}" ] && [ -n "${FIRECRACKER_JAILER_PATH:-}" ]; then FORK_SNAP="${SNAP}"; else drop_snapshot "${SNAP}"; fi
done

# fork_one <addr> <snap> <vm_id> <out> — one fork's Spawn, "<vm> <ms> <rc>" to out.
fork_one() {
  local req t0 rc=0
  req=$(jq -cn --arg t "${TENANT}" --arg d "${DIGEST}" --arg s "$1" --arg v "$2" \
    '{spec:{tenant_id:$t, image_digest:$d, isolation:"ISOLATION_HOSTILE",
      limits:{vcpu:"1", memory:"128Mi", timeout:"300s"}, run_id:("bench-"+$v),
      command:["/usr/local/bin/lantern-harness"], restore_snapshot_id:$s}, handle:{vm_id:$v}}')
  t0=$(date +%s%3N); g "${ADDR}" Spawn "${req}" >/dev/null 2>&1 || rc=$?
  echo "$2 $(( $(date +%s%3N) - t0 )) ${rc}" >>"$3"
}
export -f fork_one

if [ -z "${FORK_SNAP}" ]; then
  log "fork: SKIPPED (needs FIRECRACKER_JAILER_PATH — only the jailer can give a restore a new vm_id)"
else
  export ADDR="${A}"
  for n in ${FORK_SIZES}; do
    for it in $(seq "${FORK_ITERATIONS}"); do
      log "fork N=${n} iteration ${it}/${FORK_ITERATIONS}"
      seq "${n}" | while read -r _; do echo "bench-fork-$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"; done >"${WORK}/batch"
      cat "${WORK}/batch" >>"${WORK}/vms"
      : >"${WORK}/spawned"
      t0=$(ms)
      xargs -P "${FORK_CONCURRENCY:-16}" -I{} bash -c 'fork_one "$0" {} "$1"' "${FORK_SNAP}" "${WORK}/spawned" <"${WORK}/batch"
      t1=$(ms)
      bad=$(awk '$3 != 0' "${WORK}/spawned" | wc -l)
      # A failed spawn under load is a result, not a reason to abort: count it
      # (fork_<N>_spawn_failures) and keep going; abort only if all failed.
      rec "fork_${n}_spawn_failures" "${it}" "${bad}"
      [ "${bad}" -lt "${n}" ] || fail "all ${n} fork spawns failed (N=${n})\n$(tail -30 "${WORK}/manager.${PORT}.log")"
      [ "${bad}" -eq 0 ] || log "WARN: ${bad}/${n} fork spawns failed (N=${n}) — counted in fork_${n}_spawn_failures"
      rec "fork_${n}_spawn_wall" "${it}" $(( t1 - t0 ))
      if [ "${n}" -le "${FORK_READY_MAX:-1}" ]; then
        xargs -P "${n}" -I{} bash -c 'exec_ok "$0" {} "fr-{}" || echo {}' "${A}" <"${WORK}/batch" >"${WORK}/notready"
        t2=$(ms)
        [ -s "${WORK}/notready" ] && fail "$(wc -l <"${WORK}/notready")/${n} forks never answered exec (N=${n})"
        rec "fork_${n}_ready_wall" "${it}" $(( t2 - t0 ))
      fi
      awk -v op="fork_${n}_spawn_each" -v it="${it}" '$3 == 0 {print op "," it "." NR "," $2}' "${WORK}/spawned" >>"${SAMPLES}"
      xargs -P 16 -I{} bash -c 'g "$0" Stop "{\"vm_id\":\"{}\",\"reason\":\"bench\"}" >/dev/null 2>&1' "${A}" <"${WORK}/batch"
    done
  done
fi
stop_manager "${PORT}"

# ──────────────── phase B: broker egress mode (ADR 0026), unjailed ────────────────
if [ "${SKIP_BROKER:-0}" != "1" ]; then
  B="127.0.0.1:$((PORT + 1))"
  # Unjailed, like broker-e2e.sh: under the jailer the broker's vsock path
  # (<chroot>/<id>/root/run/lantern/vsock/<id>.sock_3128) exceeds sun_path.
  unset FIRECRACKER_JAILER_PATH FIRECRACKER_JAILER_UID FIRECRACKER_JAILER_GID FIRECRACKER_CHROOT_BASE
  # The broker refuses private/metadata IPs and non-443 ports (SSRF guard), so
  # the allowed upstream is a public HTTPS host: the number includes real
  # internet RTT. host_curl_upstream is the same request made from the host.
  UP_HOST="${BENCH_UPSTREAM_HOST:-example.com}"
  log "starting broker-mode manager on ${B}; upstream https://${UP_HOST}/"
  start_manager "$((PORT + 1))" LANTERN_EGRESS_MODE=broker
  R=$(g "${B}" Spawn "$(spawn_req bench-broker | jq -c --arg h "${UP_HOST}" '.spec.egress_rules=[{pattern:$h}]')" 2>&1) \
    || fail "broker Spawn: ${R}"
  BVM=$(jq -r '.handle.vmId // empty' <<<"${R}"); [ -n "${BVM}" ] || fail "no vm_id: ${R}"
  echo "${BVM}" >>"${WORK}/vms"
  exec_ok "${B}" "${BVM}" bwarm || fail "broker VM never answered exec"
  fetch() { # fetch <url> <key> — prints the guest-observed HTTP status
    g "${B}" ExecTool "$(tool_req "${BVM}" http_fetch "$(jq -cn --arg u "$1" '{url:$u}')" "$2")" 2>/dev/null \
      | jq -r '.result.status // "none"'
  }
  ALLOWED="https://${UP_HOST}/"
  st=$(fetch "${ALLOWED}" bprobe)
  [ "${st}" = 200 ] || fail "allowed fetch through the broker returned ${st} (want 200)\n$(grep -i broker "${WORK}/manager.$((PORT + 1)).log" | tail -10)"
  for i in $(seq "${ITERATIONS}"); do
    t0=$(ms); exec_ok "${B}" "${BVM}" "bx-$i" || fail "broker exec failed"; rec broker_exec_baseline "$i" $(( $(ms) - t0 ))
    t0=$(ms); st=$(fetch "${ALLOWED}" "ba-$i"); rec broker_fetch_allowed "$i" $(( $(ms) - t0 ))
    [ "${st}" = 200 ] || fail "allowed fetch #$i returned ${st}"
    t0=$(ms); st=$(fetch "https://example.org/" "bd-$i"); rec broker_fetch_denied "$i" $(( $(ms) - t0 ))
    [ "${st}" != 200 ] || fail "denied fetch #$i returned 200"
    t0=$(ms); curl -s -o /dev/null "${ALLOWED}"; rec host_curl_upstream "$i" $(( $(ms) - t0 ))
  done
  g "${B}" Stop "{\"vm_id\":\"${BVM}\",\"reason\":\"bench\"}" >/dev/null 2>&1
  stop_manager "$((PORT + 1))"
fi

# ─────────────────────────────── summary ───────────────────────────────
# Nearest-rank percentiles. With n=20, p95 is the 19th sample and p99 the max.
python3 - "${SAMPLES}" "${OUT_DIR}" <<'PY'
import csv, json, math, sys
rows = list(csv.DictReader(open(sys.argv[1])))
ops = {}
for r in rows:
    ops.setdefault(r["op"], []).append(int(r["ms"]))
def pct(xs, p):
    xs = sorted(xs); return xs[max(0, math.ceil(p / 100 * len(xs)) - 1)]
out = {op: {"n": len(v), "p50": pct(v, 50), "p95": pct(v, 95), "p99": pct(v, 99),
            "min": min(v), "max": max(v)} for op, v in ops.items() if op != "snapshot_bytes"}
for op, v in ops.items():
    if op.endswith("_spawn_failures"): out[op]["total"] = sum(v)
if "snapshot_bytes" in ops: out["snapshot_bytes"] = ops["snapshot_bytes"][0]
json.dump(out, open(sys.argv[2] + "/summary.json", "w"), indent=2)
with open(sys.argv[2] + "/summary.md", "w") as f:
    f.write("| operation | n | p50 | p95 | p99 | min | max |\n|---|--:|--:|--:|--:|--:|--:|\n")
    for op, s in out.items():
        if isinstance(s, dict):
            f.write(f"| `{op}` | {s['n']} | {s['p50']} | {s['p95']} | {s['p99']} | {s['min']} | {s['max']} |\n")
    for op, s in out.items():
        if isinstance(s, dict) and "total" in s:
            f.write(f"\n{op}: {s['total']} failed spawns across {s['n']} batches\n")
print(open(sys.argv[2] + "/summary.md").read())
PY
log "raw samples: ${SAMPLES}"
