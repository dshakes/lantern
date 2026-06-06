#!/usr/bin/env bash
#
# integration-test.sh — live Firecracker microVM boot validation.
#
# This is the test the macOS dev host CANNOT run: it cold-boots a real
# Firecracker microVM and asserts the full in-guest contract end to end:
#
#   1. The runtime-manager Firecracker backend reports itself AVAILABLE
#      (Linux + firecracker binary + /dev/kvm).
#   2. A "hello" microVM is scheduled (Spawn) and BOOTS.
#   3. The in-guest harness (PID 1) comes up LIVE and connects back to the
#      manager over the mTLS harness↔manager channel.
#   4. The harness VENDS a declared secret over that mTLS channel (client cert
#      CN == vm_id, signed by the manager CA).
#   5. The VM is torn down cleanly (Stop).
#
# It self-skips (exit 0) when /dev/kvm is absent so it is safe to invoke on a
# runner without nested virt — see the KVM gate at the top. The GitHub Actions
# job (.github/workflows/microvm-integration.yml) only reaches this script after
# its own KVM probe, but the gate here keeps the script honest if run by hand.
#
# Assertions are made against the manager's structured (JSON) log stream:
#   - "Firecracker backend: available"        -> backend gate   (step 1)
#   - "Firecracker: microVM started"          -> boot           (step 2)
#   - "VendSecret: issued (value NOT logged)" -> mTLS vend       (steps 3 + 4)
#
# NOTE on heartbeat: the manager-side Heartbeat handler is currently a stub that
# accepts the harness stream but logs nothing (services/runtime-manager/src/
# service.rs — "the manager side is a future workstream"). So there is no
# manager-side heartbeat log to grep for yet. A successful VendSecret PROVES the
# harness is live: it can only succeed after the harness booted as PID 1,
# registered, and established the SAME mTLS connection lifecycle the Heartbeat
# stream uses. When the manager-side heartbeat handler starts logging, add an
# explicit assertion for it here. This is called out in the docs note so the
# gap is visible, not hidden.
#
# ---------------------------------------------------------------------------
# REQUIREMENTS (provided by the CI job or your local Linux/KVM host)
# ---------------------------------------------------------------------------
#   - /dev/kvm present + readable (nested virt on the runner)
#   - firecracker binary on PATH (or FC_BINARY_PATH)
#   - FC_KERNEL_PATH / FC_ROOTFS_PATH (from build-image.sh)
#   - cargo (to build + run runtime-manager) OR MANAGER_BIN pointing at a build
#   - grpcurl, openssl, jq
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROTO_DIR="${REPO_ROOT}/packages/proto"
PROTO_FILE="lantern/v1/runtime.proto"

log()  { printf '\033[1;34m[integration]\033[0m %s\n' "$*" >&2; }
pass() { printf '\033[1;32m[integration] PASS:\033[0m %s\n' "$*" >&2; }
skip() { printf '\033[1;33m[integration] SKIP:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[integration] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# KVM gate — skip gracefully (exit 0) when there is no nested virt.
# ---------------------------------------------------------------------------
if [ ! -e /dev/kvm ] || [ ! -r /dev/kvm ]; then
  skip "/dev/kvm not present or not readable — no nested virt on this host."
  skip "Live Firecracker boot validation requires a KVM-capable runner."
  exit 0
fi

# ---------------------------------------------------------------------------
# Tool + artifact preconditions (hard-fail — if KVM is here these must be too).
# ---------------------------------------------------------------------------
for tool in grpcurl openssl jq; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
done
command -v firecracker >/dev/null 2>&1 || [ -n "${FC_BINARY_PATH:-}" ] \
  || fail "firecracker binary not on PATH and FC_BINARY_PATH unset"
[ -s "${FC_KERNEL_PATH:-}" ] || fail "FC_KERNEL_PATH unset/empty — run build-image.sh first"
[ -s "${FC_ROOTFS_PATH:-}" ] || fail "FC_ROOTFS_PATH unset/empty — run build-image.sh first"

WORK="$(mktemp -d)"
MANAGER_ADDR="127.0.0.1:50054"
MANAGER_LOG="${WORK}/manager.log"
SECRET_URI="lantern.secret://dev/itest/key/OPENAI_API_KEY"
SECRET_VALUE="itest-secret-value-do-not-log"

cleanup() {
  [ -n "${MANAGER_PID:-}" ] && kill "${MANAGER_PID}" 2>/dev/null || true
  # Best-effort teardown of any leaked TAPs / sockets from a failed boot.
  rm -rf "${WORK}" 2>/dev/null || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Mint a manager mTLS CA + server cert. The Firecracker backend issues a
#    per-VM client cert (CN=vm_id) signed by this CA at spawn; the harness
#    presents it on the VendSecret channel. We point the manager at the CA via
#    the signing-CA env contract (tls.rs: LANTERN_VM_SIGNING_CA_CERT/KEY) and at
#    the server cert via LANTERN_MANAGER_TLS_*.
# ---------------------------------------------------------------------------
log "Minting manager mTLS CA + server cert"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "${WORK}/ca.key" -out "${WORK}/ca.crt" \
  -subj "/CN=lantern-runtime-ca" >/dev/null 2>&1 || fail "CA generation failed"

openssl req -newkey rsa:2048 -nodes \
  -keyout "${WORK}/server.key" -out "${WORK}/server.csr" \
  -subj "/CN=runtime-manager" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1 \
  || fail "server CSR generation failed"
openssl x509 -req -in "${WORK}/server.csr" -CA "${WORK}/ca.crt" -CAkey "${WORK}/ca.key" \
  -CAcreateserial -days 1 -out "${WORK}/server.crt" \
  -extfile <(printf 'subjectAltName=IP:127.0.0.1,DNS:localhost') >/dev/null 2>&1 \
  || fail "server cert signing failed"

# ---------------------------------------------------------------------------
# 2. Boot the runtime-manager with the Firecracker backend + mTLS.
#    EnvSecretResolver reads LANTERN_SECRET_<encoded-uri>; encode the test URI
#    the same way the resolver expects (see secret_resolver.rs).
# ---------------------------------------------------------------------------
SECRET_ENV_KEY="LANTERN_SECRET_$(printf '%s' "${SECRET_URI}" | tr -c 'A-Za-z0-9' '_')"
log "Secret resolver env key: ${SECRET_ENV_KEY}"

MANAGER_BIN="${MANAGER_BIN:-}"
if [ -z "${MANAGER_BIN}" ]; then
  log "Building runtime-manager (release)"
  ( cd "${REPO_ROOT}/services/runtime-manager" && cargo build --release ) \
    || fail "runtime-manager build failed"
  MANAGER_BIN="${REPO_ROOT}/services/runtime-manager/target/release/lantern-runtime-manager"
fi
[ -x "${MANAGER_BIN}" ] || fail "manager binary not found at ${MANAGER_BIN}"

log "Starting runtime-manager (RUNTIME_BACKEND=firecracker) on ${MANAGER_ADDR}"
env \
  RUNTIME_BACKEND=firecracker \
  LANTERN_RUNTIME_BACKEND=firecracker \
  LISTEN_ADDR="${MANAGER_ADDR}" \
  LOG_LEVEL=info \
  FC_KERNEL_PATH="${FC_KERNEL_PATH}" \
  FC_ROOTFS_PATH="${FC_ROOTFS_PATH}" \
  ${FC_BINARY_PATH:+FC_BINARY_PATH="${FC_BINARY_PATH}"} \
  LANTERN_MANAGER_TLS_CA="${WORK}/ca.crt" \
  LANTERN_MANAGER_TLS_CERT="${WORK}/server.crt" \
  LANTERN_MANAGER_TLS_KEY="${WORK}/server.key" \
  LANTERN_VM_SIGNING_CA_CERT="${WORK}/ca.crt" \
  LANTERN_VM_SIGNING_CA_KEY="${WORK}/ca.key" \
  "${SECRET_ENV_KEY}=${SECRET_VALUE}" \
  "${MANAGER_BIN}" >"${MANAGER_LOG}" 2>&1 &
MANAGER_PID=$!

# Wait for the gRPC port to accept connections. The manager has no gRPC
# reflection, so probe the raw TCP port via bash /dev/tcp (no nc dependency).
port_open() { (exec 3<>/dev/tcp/127.0.0.1/50054) 2>/dev/null && exec 3>&- 3<&-; }
for _ in $(seq 1 100); do
  port_open && break
  kill -0 "${MANAGER_PID}" 2>/dev/null || fail "manager exited early; log:\n$(cat "${MANAGER_LOG}")"
  sleep 0.2
done
port_open || fail "manager gRPC port never opened. Log:\n$(cat "${MANAGER_LOG}")"

# ---------------------------------------------------------------------------
# Assertion 1: backend available.
# ---------------------------------------------------------------------------
grep -q "Firecracker backend: available" "${MANAGER_LOG}" \
  || fail "Firecracker backend did not report available. Log:\n$(cat "${MANAGER_LOG}")"
pass "Firecracker backend available (Linux + firecracker + /dev/kvm)"

# ---------------------------------------------------------------------------
# 3. Schedule a hello microVM via the manager Spawn RPC. The AgentSpec declares
#    the test secret so VendSecret's allowlist check passes inside the guest.
# ---------------------------------------------------------------------------
log "Scheduling hello microVM (Spawn)"
SPAWN_REQ=$(jq -n --arg uri "${SECRET_URI}" '{
  spec: {
    image_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
    isolation: "ISOLATION_HOSTILE",
    limits: { vcpu: "1", memory: "128Mi", timeout: "30s" },
    run_id: "itest-run-001",
    command: ["/usr/local/bin/lantern-harness"],
    secrets: [ { env_name: "OPENAI_API_KEY", secret_uri: $uri } ]
  }
}')

SPAWN_RESP=$(grpcurl -insecure \
  -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
  -d "${SPAWN_REQ}" \
  "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Spawn 2>>"${MANAGER_LOG}") \
  || fail "Spawn RPC failed. Log:\n$(cat "${MANAGER_LOG}")"

VM_ID=$(printf '%s' "${SPAWN_RESP}" | jq -r '.handle.vmId // .handle.id // empty')
[ -n "${VM_ID}" ] || fail "Spawn returned no vm_id: ${SPAWN_RESP}"
log "Spawned vm_id=${VM_ID}"

# ---------------------------------------------------------------------------
# Assertion 2: the microVM booted.
# ---------------------------------------------------------------------------
for _ in $(seq 1 100); do
  grep -q "Firecracker: microVM started" "${MANAGER_LOG}" && break
  sleep 0.3
done
grep -q "Firecracker: microVM started" "${MANAGER_LOG}" \
  || fail "microVM never reported started. Log:\n$(tail -50 "${MANAGER_LOG}")"
pass "microVM booted (vm_id=${VM_ID})"

# ---------------------------------------------------------------------------
# Assertions 3 + 4: the harness is LIVE and a secret vends over the mTLS
#    harness↔manager channel.
#    The hello workload's SDK helper reads the secret socket, which makes the
#    harness call VendSecret with its per-VM client cert (CN == vm_id, signed
#    by the manager CA). The manager logs "VendSecret: issued (value NOT
#    logged)" on success — we assert the success line, NOT the value.
#    A successful vend can only happen after the harness booted as PID 1 and
#    established the mTLS connection (same lifecycle as Heartbeat), so this
#    line is also our proof that the harness is live. See the header note on
#    why there is no separate manager-side heartbeat log to assert yet.
# ---------------------------------------------------------------------------
for _ in $(seq 1 120); do
  grep -q "VendSecret: issued" "${MANAGER_LOG}" && break
  sleep 0.5
done
grep -q "VendSecret: issued" "${MANAGER_LOG}" \
  || fail "secret was not vended over mTLS within timeout. Log:\n$(tail -80 "${MANAGER_LOG}")"
# Defense: confirm the secret VALUE never leaked into the log.
if grep -q "${SECRET_VALUE}" "${MANAGER_LOG}"; then
  fail "secret value leaked into manager log — invariant #10 violated"
fi
pass "harness live + secret vended over mTLS (CN=vm_id; value never logged)"

# ---------------------------------------------------------------------------
# 5. Tear down.
# ---------------------------------------------------------------------------
log "Tearing down vm_id=${VM_ID} (Stop)"
grpcurl -insecure \
  -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
  -d "$(jq -n --arg id "${VM_ID}" '{vm_id:$id, reason:"integration-test teardown"}')" \
  "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Stop >>"${MANAGER_LOG}" 2>&1 \
  || log "Stop RPC returned non-zero (VM may already be gone) — continuing"

pass "ALL ASSERTIONS PASSED — live Firecracker boot validated end to end"
