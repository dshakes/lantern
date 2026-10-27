#!/usr/bin/env bash
#
# broker-e2e.sh — live broker-egress-mode (ADR 0026) boot on a Linux/KVM host.
#
# Boots a Firecracker microVM with LANTERN_EGRESS_MODE=broker and asserts:
#   1. the VM has NO network device (no TAP created, no /network-interfaces PUT,
#      guest sees no eth0),
#   2. the harness reaches the manager over vsock (heartbeat/report) — no NIC,
#   3. exec into the VM works over host-initiated vsock (ExecTool shell_exec),
#   4. an HTTPS request from inside the guest to an injected host goes through
#      127.0.0.1:3128 -> vsock -> host broker, the broker sets the credential,
#      and upstream accepts it (httpbin hidden-basic-auth: 404 without the
#      header, 200 with it — and it never echoes the credential back),
#   5. a non-allowlisted host is denied by the broker,
#   6. the credential value never appears in the manager log or the guest's
#      response.
#
# Self-contained and isolated from infra/firecracker/integration-test.sh: own
# port (LISTEN_PORT, default 51054), own work dir, own VM. Needs root (TAP-less
# boot still needs /dev/kvm + firecracker), grpcurl, jq, openssl and the
# artifacts from build-image.sh (FC_KERNEL_PATH / FC_ROOTFS_PATH) built with a
# broker-capable harness. MANAGER_BIN may point at a prebuilt manager.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROTO_DIR="${REPO_ROOT}/packages/proto"
PROTO_FILE="lantern/v1/runtime.proto"
LISTEN_PORT="${LISTEN_PORT:-51054}"
MANAGER_ADDR="127.0.0.1:${LISTEN_PORT}"
WORK="$(mktemp -d /tmp/broker-e2e.XXXXXX)"
LOG="${WORK}/manager.log"
TENANT="00000000-0000-0000-0000-000000000001"
INJECT_HOST="${INJECT_HOST:-httpbin.org}"
SECRET_URI="lantern.secret/llm/httpbin"
# base64("user:passwd") — what httpbin's hidden-basic-auth expects.
SECRET_VALUE="dXNlcjpwYXNzd2Q="

log()  { printf '\033[1;34m[broker-e2e]\033[0m %s\n' "$*" >&2; }
pass() { printf '\033[1;32m[broker-e2e] PASS:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[broker-e2e] FAIL:\033[0m %b\n' "$*" >&2; exit 1; }

[ -r /dev/kvm ] || fail "/dev/kvm not readable"
[ -s "${FC_KERNEL_PATH:-}" ] && [ -s "${FC_ROOTFS_PATH:-}" ] || fail "FC_KERNEL_PATH/FC_ROOTFS_PATH unset"
for t in grpcurl jq openssl; do command -v "$t" >/dev/null || fail "missing $t"; done

g() { # grpcurl to our manager
  grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" \
    -servername localhost -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -H "x-lantern-service-token: e2e-token" -d "$1" "${MANAGER_ADDR}" "lantern.v1.RuntimeManager/$2"
}

cleanup() {
  # BROKER_E2E_HOLD=<secs>: keep the VM + manager alive for inspection.
  [ -n "${BROKER_E2E_HOLD:-}" ] && { log "holding ${BROKER_E2E_HOLD}s (vm ${VM_ID:-?})"; sleep "${BROKER_E2E_HOLD}"; }
  if [ -n "${VM_ID:-}" ]; then
    g "$(jq -n --arg id "${VM_ID}" '{vm_id:$id, reason:"broker-e2e cleanup"}')" Stop >/dev/null 2>&1 || true
    for pid in $(pgrep -x firecracker); do
      tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | grep -qF "${VM_ID}" && kill -KILL "${pid}" 2>/dev/null
    done
  fi
  [ -n "${MANAGER_PGID:-}" ] && kill -KILL -- "-${MANAGER_PGID}" 2>/dev/null
  echo "manager log kept at ${LOG}" >&2
}
trap cleanup EXIT

log "minting certs in ${WORK}"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "${WORK}/ca.key" -out "${WORK}/ca.crt" \
  -subj "/CN=broker-e2e-ca" -addext "basicConstraints=critical,CA:TRUE" >/dev/null 2>&1 || fail ca
for who in server client; do
  openssl req -newkey rsa:2048 -nodes -keyout "${WORK}/${who}.key" -out "${WORK}/${who}.csr" \
    -subj "/CN=${who}" >/dev/null 2>&1 || fail "${who} csr"
done
openssl x509 -req -in "${WORK}/server.csr" -CA "${WORK}/ca.crt" -CAkey "${WORK}/ca.key" -CAcreateserial \
  -days 1 -out "${WORK}/server.crt" -extfile <(printf 'subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:manager.lantern.internal\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE') >/dev/null 2>&1 || fail server
openssl x509 -req -in "${WORK}/client.csr" -CA "${WORK}/ca.crt" -CAkey "${WORK}/ca.key" -CAcreateserial \
  -days 1 -out "${WORK}/client.crt" -extfile <(printf 'extendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE') >/dev/null 2>&1 || fail client

MANAGER_BIN="${MANAGER_BIN:-${REPO_ROOT}/services/runtime-manager/target/release/lantern-runtime-manager}"
[ -x "${MANAGER_BIN}" ] || fail "no manager at ${MANAGER_BIN}"
SECRET_ENV_KEY="LANTERN_SECRET_$(printf '%s' "${SECRET_URI}" | tr -c 'A-Za-z0-9' '_')"

log "starting manager (broker mode) on ${MANAGER_ADDR}"
setsid bash -c 'echo $$ >"$1"; shift; exec "$@"' _ "${WORK}/pgid" env \
  RUNTIME_BACKEND=firecracker LISTEN_ADDR="0.0.0.0:${LISTEN_PORT}" LOG_LEVEL=info \
  LANTERN_EGRESS_MODE=broker \
  LANTERN_GRPC_SERVICE_TOKEN=e2e-token \
  FC_KERNEL_PATH="${FC_KERNEL_PATH}" FC_ROOTFS_PATH="${FC_ROOTFS_PATH}" \
  LANTERN_MANAGER_TLS_CA="${WORK}/ca.crt" LANTERN_MANAGER_TLS_CERT="${WORK}/server.crt" \
  LANTERN_MANAGER_TLS_KEY="${WORK}/server.key" \
  LANTERN_VM_SIGNING_CA_CERT="${WORK}/ca.crt" LANTERN_VM_SIGNING_CA_KEY="${WORK}/ca.key" \
  "${SECRET_ENV_KEY}=${SECRET_VALUE}" \
  "${MANAGER_BIN}" >"${LOG}" 2>&1 &
for _ in $(seq 50); do [ -s "${WORK}/pgid" ] && break; sleep 0.1; done
MANAGER_PGID="$(tr -dc 0-9 <"${WORK}/pgid")"
for _ in $(seq 100); do (exec 3<>"/dev/tcp/127.0.0.1/${LISTEN_PORT}") 2>/dev/null && break; sleep 0.2; done
grep -q "egress broker mode" "${LOG}" || fail "manager not in broker mode:\n$(tail -20 "${LOG}")"
pass "manager up in broker egress mode"

SPAWN=$(jq -n --arg t "${TENANT}" --arg host "${INJECT_HOST}" --arg uri "${SECRET_URI}" '{spec:{
  tenant_id:$t, image_digest:"sha256:0000000000000000000000000000000000000000000000000000000000000002",
  isolation:"ISOLATION_HOSTILE", limits:{vcpu:"1", memory:"256Mi", timeout:"120s"}, run_id:"broker-e2e",
  egress_rules:[{pattern:$host, inject:[{header:"Authorization", secret_uri:$uri, value_prefix:"Basic "}]}]
}}')
RESP=$(g "${SPAWN}" Spawn 2>>"${LOG}") || fail "Spawn failed:\n$(tail -30 "${LOG}")"
VM_ID=$(printf '%s' "${RESP}" | jq -r '.handle.vmId // empty')
[ -n "${VM_ID}" ] || fail "no vm_id: ${RESP}"
log "spawned ${VM_ID}"

for _ in $(seq 150); do grep -q "starting lantern-harness (PID 1)" "${LOG}" && break; grep -q "Kernel panic" "${LOG}" && break; sleep 0.3; done
grep -q "Kernel panic" "${LOG}" && fail "guest panicked:\n$(grep -B8 'Kernel panic' "${LOG}" | tail -20)"
grep -q "starting lantern-harness (PID 1)" "${LOG}" || fail "guest never came up:\n$(tail -40 "${LOG}")"
pass "guest booted (harness PID 1)"

# (1) no NIC: no TAP on the host, and the guest has no eth0.
TAP="fc-$(printf '%s' "${VM_ID}" | tr -dc 0-9a-f | head -c 8)"
ip link show "${TAP}" >/dev/null 2>&1 && fail "TAP ${TAP} exists — broker VM must have no NIC"
pass "host has no TAP for the VM (${TAP} absent)"

tool() { # tool <name> <args-json>
  g "$(jq -n --arg id "${VM_ID}" --arg n "$1" --argjson a "$2" '{vm_id:$id, run_id:"broker-e2e", step_id:"s", tool_name:$n, args:$a, idempotency_key:("broker-e2e:"+$n+":"+($a|tostring))}')" ExecTool 2>>"${LOG}"
}

# (2)+(3) exec over host-initiated vsock (retry while the harness comes up).
for _ in $(seq 60); do OUT=$(tool shell_exec '{"command":"cat /proc/net/dev; echo exec-over-vsock-ok"}') && printf '%s' "${OUT}" | grep -q exec-over-vsock-ok && break; sleep 1; done
printf '%s\n' "${OUT}" | jq -c . >&2
printf '%s' "${OUT}" | grep -q exec-over-vsock-ok || fail "ExecTool over vsock failed:\n${OUT}\n$(tail -30 "${LOG}")"
printf '%s' "${OUT}" | grep -q eth0 && fail "guest sees eth0 — broker VM must have no NIC"
pass "exec works over host-initiated vsock; guest /proc/net/dev lists no eth0"
# (2) the harness->manager control channel rides guest-initiated vsock (no
# NIC): Stats for a Firecracker VM is served ONLY from Heartbeat data, so a
# Stats frame proves a heartbeat crossed vsock -> relay -> manager over mTLS.
for _ in $(seq 30); do
  STATS=$(timeout 8 grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" \
    -servername localhost -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" -H "x-lantern-service-token: e2e-token" \
    -max-msg-sz 1048576 -d "$(jq -n --arg id "${VM_ID}" '{vm_id:$id, interval:"1s"}')" \
    "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Stats 2>&1 | head -c 400)
  printf '%s' "${STATS}" | grep -q '{' && break; sleep 1
done
printf '%s\n' "${STATS}" | head -5 >&2
printf '%s' "${STATS}" | grep -q '{' || fail "no heartbeat-backed Stats — harness control channel over vsock is not up:\n${STATS}"
pass "harness heartbeat reached the manager over guest-initiated vsock (Stats served from it)"
log "host-side vsock sockets for the VM:"; ls -la /run/lantern/vsock/ | grep "${VM_ID}" >&2

# (4) injected host via the guest's http_fetch (harness reqwest -> 127.0.0.1:3128 -> vsock -> broker).
FETCH="$(jq -n --arg u "https://${INJECT_HOST}/hidden-basic-auth/user/passwd" '{url:$u, headers:{Authorization:"Basic placeholder"}}')"
authed() { printf '%s' "$1" | jq -e '.result.status == 200 and (.result.body | test("\"authenticated\": *true"))' >/dev/null 2>&1; }
for _ in $(seq 20); do OUT=$(tool http_fetch "${FETCH}") && authed "${OUT}" && break; sleep 2; done
printf '%s\n' "${OUT}" | jq -c . >&2
authed "${OUT}" || fail "injected request not authenticated upstream:\n${OUT}\n$(tail -30 "${LOG}")"
printf '%s' "${OUT}" | grep -q "${SECRET_VALUE}" && fail "credential reached the guest"
# Control: the guest's own header (placeholder) is NOT enough — only the
# broker-injected credential authenticates.
CTRL=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H 'Authorization: Basic placeholder' "https://${INJECT_HOST}/hidden-basic-auth/user/passwd")
[ "${CTRL}" = "404" ] || fail "control request (placeholder only) returned ${CTRL}, want 404"
pass "control: placeholder-only request from the host gets 404 (so the 200 above came from injection)"
pass "HTTPS to ${INJECT_HOST}: broker injected the credential, upstream authenticated (guest saw only 'placeholder')"

# (5) non-allowlisted host denied.
OUT=$(tool http_fetch '{"url":"https://example.com/"}')
printf '%s\n' "${OUT}" | jq -c . >&2
printf '%s' "${OUT}" | jq -e '.result.status == 200' >/dev/null 2>&1 && fail "non-allowlisted host was reachable"
grep 'egress broker audit' "${LOG}" | grep 'example.com' | grep -q 'no matching allowlist rule' \
  || fail "no broker deny audit for example.com"
pass "non-allowlisted host denied by the broker (deny audited)"

# (6) secret never logged.
grep -q "${SECRET_VALUE}" "${LOG}" && fail "credential value appears in manager log"
pass "credential value absent from the manager log"
grep 'egress broker audit' "${LOG}" | tail -6 >&2
pass "ALL BROKER-MODE ASSERTIONS PASSED (vm ${VM_ID})"
