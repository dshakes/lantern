#!/usr/bin/env bash
#
# measurement-e2e.sh — host-asserted software measurement (ADR 0031) on real
# Firecracker. Hard-fails unless:
#   1. two cold spawns of ONE spec (different vm ids, different agent instance
#      tokens) under gate=warn report the same 64-hex measurement;
#   2. with gate=enforce and that value as the only reference, the same spec
#      boots while a changed env value or a changed command is refused (and the
#      log says "does not match any reference");
#   3. under enforce, snapshot -> stop -> restore (resume) succeeds and a fork
#      (new vm id) succeeds, each reporting the source's measurement;
#   4. the manager refuses to START with gate=enforced (typo), with a malformed
#      reference, and with LANTERN_ENV=production + enforce + no references;
#   5. no manager log contains the measurement value or an instance token.
#
# Self-contained, like broker-e2e.sh: own port (LISTEN_PORT, default 51055),
# own work dir, every VM it starts is stopped through the manager (then
# backstop-killed by id), its snapshot is removed. Needs root, /dev/kvm,
# grpcurl, jq, openssl, FC_KERNEL_PATH / FC_ROOTFS_PATH from build-image.sh,
# and the jailer (FIRECRACKER_JAILER_PATH + _UID/_GID/CHROOT_BASE): a fork
# under a new vm id needs it. MANAGER_BIN may point at a prebuilt manager.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROTO_DIR="${REPO_ROOT}/packages/proto"
PROTO_FILE="lantern/v1/runtime.proto"
LISTEN_PORT="${LISTEN_PORT:-51055}"
MANAGER_ADDR="127.0.0.1:${LISTEN_PORT}"
WORK="$(mktemp -d /tmp/measurement-e2e.XXXXXX)"
TENANT="00000000-0000-0000-0000-000000000001"
HARNESS_CMD="/usr/local/bin/lantern-harness"
VM_IDS=()
TOKENS=()
SNAPSHOT_ID=""
LOG=""

log()  { printf '\033[1;34m[measurement-e2e]\033[0m %s\n' "$*" >&2; }
pass() { printf '\033[1;32m[measurement-e2e] PASS:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[measurement-e2e] FAIL:\033[0m %b\n' "$*" >&2; exit 1; }

[ -r /dev/kvm ] || fail "/dev/kvm not readable"
{ [ -s "${FC_KERNEL_PATH:-}" ] && [ -s "${FC_ROOTFS_PATH:-}" ]; } || fail "FC_KERNEL_PATH/FC_ROOTFS_PATH unset"
[ -x "${FIRECRACKER_JAILER_PATH:-}" ] || fail "FIRECRACKER_JAILER_PATH unset — the fork assertion needs the jailer"
for t in grpcurl jq openssl; do command -v "$t" >/dev/null || fail "missing $t"; done
MANAGER_BIN="${MANAGER_BIN:-${REPO_ROOT}/services/runtime-manager/target/release/lantern-runtime-manager}"
[ -x "${MANAGER_BIN}" ] || fail "no manager at ${MANAGER_BIN}"

g() { # g <json> <method> — grpcurl to our manager
  grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" \
    -servername localhost -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -H "x-lantern-service-token: e2e-token" -d "$1" "${MANAGER_ADDR}" "lantern.v1.RuntimeManager/$2"
}
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/${LISTEN_PORT}") 2>/dev/null; }

stop_vm() {
  g "$(jq -n --arg id "$1" '{vm_id:$id, reason:"measurement-e2e"}')" Stop >/dev/null 2>&1 || true
}

stop_manager() {
  [ -n "${MANAGER_PGID:-}" ] || return 0
  kill -TERM -- "-${MANAGER_PGID}" 2>/dev/null
  for _ in $(seq 30); do port_open || break; sleep 0.2; done
  kill -KILL -- "-${MANAGER_PGID}" 2>/dev/null
  MANAGER_PGID=""
}

cleanup() {
  if port_open; then for id in "${VM_IDS[@]}"; do stop_vm "${id}"; done; fi
  stop_manager
  # Backstop: firecracker setsid()s out of the manager's group; match only
  # THIS run's vm ids anywhere in argv (jailed sockets live in the jail).
  for pid in $(pgrep -x firecracker); do
    for id in "${VM_IDS[@]}"; do
      tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | grep -qF "${id}" && kill -KILL "${pid}" 2>/dev/null
    done
  done
  if [ -n "${SNAPSHOT_ID}" ]; then
    find /var/lib/lantern/snapshots -mindepth 3 -maxdepth 3 -type d -name "${SNAPSHOT_ID}" \
      -exec rm -r -- {} + 2>/dev/null
  fi
  echo "manager logs kept in ${WORK}" >&2
}
trap cleanup EXIT

log "minting certs in ${WORK}"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "${WORK}/ca.key" -out "${WORK}/ca.crt" \
  -subj "/CN=measurement-e2e-ca" -addext "basicConstraints=critical,CA:TRUE" >/dev/null 2>&1 || fail ca
for who in server client; do
  openssl req -newkey rsa:2048 -nodes -keyout "${WORK}/${who}.key" -out "${WORK}/${who}.csr" \
    -subj "/CN=${who}" >/dev/null 2>&1 || fail "${who} csr"
done
openssl x509 -req -in "${WORK}/server.csr" -CA "${WORK}/ca.crt" -CAkey "${WORK}/ca.key" -CAcreateserial \
  -days 1 -out "${WORK}/server.crt" -extfile <(printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE') >/dev/null 2>&1 || fail server
openssl x509 -req -in "${WORK}/client.csr" -CA "${WORK}/ca.crt" -CAkey "${WORK}/ca.key" -CAcreateserial \
  -days 1 -out "${WORK}/client.crt" -extfile <(printf 'extendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE') >/dev/null 2>&1 || fail client

# start_manager <name> [VAR=value ...] — fresh log ${WORK}/<name>.log.
start_manager() {
  local name="$1"; shift
  LOG="${WORK}/${name}.log"
  rm -f "${WORK}/pgid"
  # shellcheck disable=SC2016  # $$ expands in the child bash
  setsid bash -c 'echo $$ >"$1"; shift; exec "$@"' _ "${WORK}/pgid" env \
    RUNTIME_BACKEND=firecracker LISTEN_ADDR="0.0.0.0:${LISTEN_PORT}" LOG_LEVEL=info \
    LANTERN_GRPC_SERVICE_TOKEN=e2e-token \
    FC_KERNEL_PATH="${FC_KERNEL_PATH}" FC_ROOTFS_PATH="${FC_ROOTFS_PATH}" \
    FIRECRACKER_JAILER_PATH="${FIRECRACKER_JAILER_PATH}" \
    FIRECRACKER_JAILER_UID="${FIRECRACKER_JAILER_UID:-123}" \
    FIRECRACKER_JAILER_GID="${FIRECRACKER_JAILER_GID:-100}" \
    FIRECRACKER_CHROOT_BASE="${FIRECRACKER_CHROOT_BASE:-/srv/jailer}" \
    LANTERN_MANAGER_TLS_CA="${WORK}/ca.crt" LANTERN_MANAGER_TLS_CERT="${WORK}/server.crt" \
    LANTERN_MANAGER_TLS_KEY="${WORK}/server.key" \
    LANTERN_VM_SIGNING_CA_CERT="${WORK}/ca.crt" LANTERN_VM_SIGNING_CA_KEY="${WORK}/ca.key" \
    LANTERN_VM_CERT_DIR="${WORK}/vm-certs" \
    "$@" "${MANAGER_BIN}" >"${LOG}" 2>&1 &
  for _ in $(seq 50); do [ -s "${WORK}/pgid" ] && break; sleep 0.1; done
  MANAGER_PGID="$(tr -dc 0-9 <"${WORK}/pgid" 2>/dev/null)"
  [ -n "${MANAGER_PGID}" ] || fail "manager wrapper never published its pgid"
  for _ in $(seq 100); do
    port_open && break
    kill -0 "${MANAGER_PGID}" 2>/dev/null || fail "manager (${name}) exited early:\n$(tail -20 "${LOG}")"
    sleep 0.2
  done
  port_open || fail "manager (${name}) never opened ${LISTEN_PORT}:\n$(tail -20 "${LOG}")"
  grep -q "Firecracker backend: available" "${LOG}" || fail "Firecracker backend not available:\n$(tail -20 "${LOG}")"
}

# spec <mode> <token> [command] — the measured spec; only token differs per VM.
spec() {
  jq -n --arg t "${TENANT}" --arg mode "$1" --arg tok "$2" --arg cmd "${3:-${HARNESS_CMD}}" '{
    tenant_id:$t, image_digest:"sha256:0000000000000000000000000000000000000000000000000000000000000003",
    isolation:"ISOLATION_HOSTILE", limits:{vcpu:"1", memory:"128Mi", timeout:"120s"},
    run_id:"measurement-e2e", command:[$cmd],
    env:{MODE:$mode, LANTERN_AGENT_INSTANCE_ID:("inst-" + ($tok | explode | reverse | implode)), LANTERN_AGENT_INSTANCE_TOKEN:$tok}}'
}

# spawn <spec-json> [handle-vm-id] — echoes the Spawn response; records vm id.
spawn() {
  local req resp id
  if [ -n "${2:-}" ]; then
    req=$(jq -n --argjson s "$1" --arg id "$2" '{spec:$s, handle:{vm_id:$id}}')
  else
    req=$(jq -n --argjson s "$1" '{spec:$s}')
  fi
  resp=$(g "${req}" Spawn 2>>"${LOG}") || return 1
  id=$(printf '%s' "${resp}" | jq -r '.handle.vmId // empty')
  [ -n "${id}" ] && VM_IDS+=("${id}")
  printf '%s' "${resp}"
}
measurement_of() { printf '%s' "$1" | jq -r '.handle.softwareMeasurement // empty'; }
is_hex64() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$'; }
newtok() { printf 'tok-%s' "$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"; }

wait_booted() { # wait_booted <n> — n harness boot banners in the current log
  for _ in $(seq 150); do
    [ "$(grep -c "starting lantern-harness (PID 1)" "${LOG}")" -ge "$1" ] && return 0
    grep -q "Kernel panic" "${LOG}" && fail "guest panicked:\n$(grep -B8 'Kernel panic' "${LOG}" | tail -20)"
    sleep 0.3
  done
  fail "guest never came up:\n$(tail -40 "${LOG}")"
}

# ---------------------------------------------------------------------------
# (4) startup refusals — the manager must exit non-zero before serving.
# ---------------------------------------------------------------------------
refuses_start() { # refuses_start <label> <expect-substring> VAR=value...
  local label="$1" want="$2" rc=0; shift 2
  timeout 30 env RUNTIME_BACKEND=firecracker LISTEN_ADDR="127.0.0.1:$((LISTEN_PORT + 1))" \
    LANTERN_GRPC_SERVICE_TOKEN=e2e-token "$@" "${MANAGER_BIN}" >"${WORK}/refuse.log" 2>&1 || rc=$?
  if [ "${rc}" -eq 0 ] || [ "${rc}" -eq 124 ]; then
    fail "${label}: manager did not refuse to start (rc=${rc}):\n$(tail -10 "${WORK}/refuse.log")"
  fi
  grep -qF "${want}" "${WORK}/refuse.log" || fail "${label}: refusal lacks \"${want}\":\n$(tail -10 "${WORK}/refuse.log")"
  pass "manager refuses to start: ${label}"
}
refuses_start "gate=enforced (typo)" "invalid LANTERN_MEASUREMENT_GATE" LANTERN_MEASUREMENT_GATE=enforced
refuses_start "malformed reference" "invalid LANTERN_REFERENCE_MEASUREMENTS" \
  LANTERN_MEASUREMENT_GATE=warn LANTERN_REFERENCE_MEASUREMENTS=deadbeef
refuses_start "production + enforce + no references" "LANTERN_MEASUREMENT_GATE=enforce in production" \
  LANTERN_ENV=production LANTERN_MEASUREMENT_GATE=enforce

# ---------------------------------------------------------------------------
# (1) gate=warn: two VMs from one spec measure identically.
# ---------------------------------------------------------------------------
start_manager warn LANTERN_MEASUREMENT_GATE=warn
pass "manager up (gate=warn)"
T1=$(newtok); T2=$(newtok); TOKENS+=("${T1}" "${T2}")
R1=$(spawn "$(spec fast "${T1}")") || fail "warn spawn #1 failed:\n$(tail -30 "${LOG}")"
R2=$(spawn "$(spec fast "${T2}")") || fail "warn spawn #2 failed:\n$(tail -30 "${LOG}")"
M=$(measurement_of "${R1}"); M2=$(measurement_of "${R2}")
V1=$(printf '%s' "${R1}" | jq -r .handle.vmId); V2=$(printf '%s' "${R2}" | jq -r .handle.vmId)
[ "${V1}" != "${V2}" ] || fail "spawns got the same vm id ${V1}"
is_hex64 "${M}" || fail "spawn #1 reported no 64-hex measurement: ${R1}"
[ "${M}" = "${M2}" ] || fail "same spec, different measurements:\n  ${V1}: ${M}\n  ${V2}: ${M2}"
pass "two cold spawns of one spec (vm ${V1} / ${V2}, different instance tokens) report the same measurement"
wait_booted 2
stop_vm "${V1}"; stop_vm "${V2}"
stop_manager

# ---------------------------------------------------------------------------
# (2) gate=enforce with that value as the reference.
# ---------------------------------------------------------------------------
start_manager enforce LANTERN_MEASUREMENT_GATE=enforce LANTERN_REFERENCE_MEASUREMENTS="${M}"
pass "manager up (gate=enforce, reference = the warn-run measurement)"
T3=$(newtok); TOKENS+=("${T3}")
R3=$(spawn "$(spec fast "${T3}")") || fail "enforce: the reference spec was refused:\n$(tail -30 "${LOG}")"
SRC=$(printf '%s' "${R3}" | jq -r .handle.vmId)
[ "$(measurement_of "${R3}")" = "${M}" ] || fail "enforce: reference spec measured $(measurement_of "${R3}"), want ${M}"
pass "enforce: the reference spec boots (vm ${SRC})"

refused() { # refused <label> <spec-json>
  local before
  before=$(grep -c "does not match any reference" "${LOG}")
  spawn "$2" >/dev/null && fail "enforce: ${1} was NOT refused"
  [ "$(grep -c "does not match any reference" "${LOG}")" -gt "${before}" ] \
    || fail "enforce: ${1} refused, but not by the measurement gate:\n$(tail -20 "${LOG}")"
  pass "enforce: ${1} refused (log: does not match any reference)"
}
T4=$(newtok); T5=$(newtok); TOKENS+=("${T4}" "${T5}")
refused "changed env value (MODE=slow)" "$(spec slow "${T4}")"
refused "changed command" "$(spec fast "${T5}" /bin/sh)"

# ---------------------------------------------------------------------------
# (3) under enforce: snapshot -> stop -> resume, and a fork, inherit M.
# ---------------------------------------------------------------------------
wait_booted 1
SNAP=$(g "$(jq -n --arg id "${SRC}" '{vm_id:$id}')" Snapshot 2>>"${LOG}") \
  || fail "Snapshot failed:\n$(tail -30 "${LOG}")"
SNAPSHOT_ID=$(printf '%s' "${SNAP}" | jq -r '.snapshotId // empty')
[ -n "${SNAPSHOT_ID}" ] || fail "Snapshot returned no id: ${SNAP}"
pass "enforce: snapshot of ${SRC} (${SNAPSHOT_ID})"
stop_vm "${SRC}"
for _ in $(seq 30); do
  pgrep -x firecracker | while read -r p; do tr '\0' ' ' <"/proc/${p}/cmdline"; echo; done | grep -qF "${SRC}" || break
  sleep 0.2
done

RESTORE_SPEC() { spec fast "$1" | jq --arg s "${SNAPSHOT_ID}" '. + {restore_snapshot_id:$s}'; }
T6=$(newtok); T7=$(newtok); TOKENS+=("${T6}" "${T7}")
RR=$(spawn "$(RESTORE_SPEC "${T6}")" "${SRC}") || fail "enforce: resume (restore of ${SRC}) refused:\n$(tail -30 "${LOG}")"
[ "$(printf '%s' "${RR}" | jq -r '.fromSnapshot // false')" = true ] || fail "resume did not come from the snapshot: ${RR}"
[ "$(measurement_of "${RR}")" = "${M}" ] || fail "resumed VM measurement $(measurement_of "${RR}"), want inherited ${M}"
pass "enforce: snapshot -> stop -> restore succeeded and carries the source's measurement"

FORK_ID="meas-fork-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
RF=$(spawn "$(RESTORE_SPEC "${T7}")" "${FORK_ID}") || fail "enforce: fork refused:\n$(tail -30 "${LOG}")"
[ "$(printf '%s' "${RF}" | jq -r .handle.vmId)" = "${FORK_ID}" ] || fail "fork got the wrong vm id: ${RF}"
[ "$(measurement_of "${RF}")" = "${M}" ] || fail "fork measurement $(measurement_of "${RF}"), want inherited ${M}"
pass "enforce: fork ${FORK_ID} succeeded and carries the source's measurement"
grep -q "inherited from snapshot source" "${LOG}" || fail "no 'inherited from snapshot source' audit line"
pass "restore/fork audited as inherited"

stop_vm "${SRC}"; stop_vm "${FORK_ID}"
stop_manager

# ---------------------------------------------------------------------------
# (5) no manager log carries the measurement value or an instance token.
# ---------------------------------------------------------------------------
LOGS=("${WORK}"/*.log)
grep -lF "${M}" "${LOGS[@]}" && fail "measurement value appears in a manager log (above)"
grep -liE 'measurement.*[0-9a-f]{64}' "${LOGS[@]}" \
  && fail "a 64-hex value on a measurement log line (above)"
for tok in "${TOKENS[@]}"; do
  grep -lF "${tok}" "${LOGS[@]}" && fail "instance token ${tok} appears in a manager log (above)"
done
pass "no manager log contains the measurement value or any instance token (${#TOKENS[@]} checked)"

pass "ALL MEASUREMENT ASSERTIONS PASSED"
