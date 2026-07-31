#!/usr/bin/env bash
#
# integration-test.sh — live Firecracker microVM boot validation.
#
# This is the test the macOS dev host CANNOT run: it cold-boots a real
# Firecracker microVM and asserts the full in-guest contract end to end:
#
#   1. The runtime-manager Firecracker backend reports itself AVAILABLE
#      (Linux + firecracker binary + /dev/kvm).
#   2. A "hello" microVM is scheduled (Spawn), BOOTS, and the guest actually
#      comes up (the harness runs as PID 1; no kernel panic).
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
#   - "Firecracker: microVM started"          -> hypervisor launched  (step 2a)
#   - "starting lantern-harness (PID 1)"      -> GUEST came up        (step 2b)
#   - "VendSecret: issued (value NOT logged)" -> mTLS vend       (steps 3 + 4)
#
# Step 2a is host-side and proves only that Firecracker accepted a config; a
# guest that panics on boot still satisfies it. Step 2b is the one that proves
# the VM is real, and a kernel panic anywhere in the log is a hard failure.
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
# The guest reaches the manager over its point-to-point TAP link (172.16.x.1),
# never loopback, so the manager has to bind all interfaces. grpcurl still
# talks to it on 127.0.0.1 via MANAGER_ADDR above.
MANAGER_LISTEN_ADDR="0.0.0.0:50054"
MANAGER_LOG="${WORK}/manager.log"
SECRET_URI="lantern.secret://dev/itest/key/OPENAI_API_KEY"
SECRET_VALUE="itest-secret-value-do-not-log"
# Every scheduled workload must carry a tenant (multi-tenancy invariant); the
# manager rejects an untenanted spec outright.
ITEST_TENANT_ID="00000000-0000-0000-0000-000000000001"

# Is something listening on the manager's gRPC port?
#
# Defined up here because cleanup uses it too: the port — not the pid — is what
# the NEXT run actually needs back. No `nc` dependency; bash /dev/tcp is enough.
port_open() { (exec 3<>/dev/tcp/127.0.0.1/50054) 2>/dev/null && exec 3>&- 3<&-; }

# Reap the manager AND everything it spawned.
#
# `kill "${MANAGER_PID}"` was not enough, in two ways that compound: the manager
# does not reliably exit on SIGTERM, and its firecracker children are reparented
# rather than killed when it does. A failed run therefore left a live manager
# holding :50054, and every LATER run then failed to bind and reported
# "Firecracker backend did not report available" — a symptom that points at the
# backend, or at whatever was last edited, rather than at the leaked process.
# That cost three runs and briefly looked like a code regression.
#
# The manager is started in its own process group (see `setsid` below) so the
# whole tree can be signalled by group id. Deliberately NOT a host-wide
# `pkill -f firecracker`: that would kill unrelated VMs, and on the usual dev
# host — a Lima VM named `firecracker-dev` — the pattern also matches the
# caller's own shell command line and kills the session running this script.
cleanup() {
  if [ -n "${MANAGER_PGID:-}" ]; then
    kill -TERM "-${MANAGER_PGID}" 2>/dev/null || true
    # Give a graceful shutdown a bounded chance (~6s), then stop asking.
    for _ in $(seq 1 30); do
      port_open || break
      sleep 0.2
    done
    kill -KILL "-${MANAGER_PGID}" 2>/dev/null || true
  fi

  # Confirm the port came back. If it did not, say so HERE — the next run would
  # otherwise fail with the misleading message described above.
  for _ in $(seq 1 25); do
    port_open || break
    sleep 0.2
  done
  if port_open; then
    printf '\033[1;33m[integration] WARN:\033[0m %s\n' \
      "port 50054 still held after teardown; the next run will fail to bind. \
Find it with: sudo ss -lntp | grep 50054" >&2
  fi

  rm -rf "${WORK}" 2>/dev/null || true
}
trap cleanup EXIT

# Fail fast, and for the RIGHT reason, if the port is already taken — by a
# manager leaked from an earlier run, or by anything else. Without this the
# script starts a manager that cannot bind and reports a backend problem.
if port_open; then
  fail "something is already listening on 127.0.0.1:50054 (likely a runtime-manager
  leaked by an earlier run). This script cannot start its own manager until that
  is gone. Find and stop it with:  sudo ss -lntp | grep 50054"
fi

# ---------------------------------------------------------------------------
# 1. Mint a manager mTLS CA + server cert. The Firecracker backend issues a
#    per-VM client cert (CN=vm_id) signed by this CA at spawn; the harness
#    presents it on the VendSecret channel. We point the manager at the CA via
#    the signing-CA env contract (tls.rs: LANTERN_VM_SIGNING_CA_CERT/KEY) and at
#    the server cert via LANTERN_MANAGER_TLS_*.
# ---------------------------------------------------------------------------
log "Minting manager mTLS CA + server + client certs"
# Go's crypto/tls (grpcurl) is stricter than openssl: it requires a leaf cert to
# carry the right extendedKeyUsage (serverAuth / clientAuth) and a CA with
# basicConstraints:CA:TRUE. A bare `openssl x509 -req` with no extensions
# produces certs openssl accepts but Go aborts ("tls handshake eof" server-side,
# "context deadline exceeded" client-side). So every cert below sets EKU +
# basicConstraints explicitly — without them the live mTLS dial silently hangs.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "${WORK}/ca.key" -out "${WORK}/ca.crt" \
  -subj "/CN=lantern-runtime-ca" \
  -addext "basicConstraints=critical,CA:TRUE" >/dev/null 2>&1 || fail "CA generation failed"

openssl req -newkey rsa:2048 -nodes \
  -keyout "${WORK}/server.key" -out "${WORK}/server.csr" \
  -subj "/CN=runtime-manager" >/dev/null 2>&1 \
  || fail "server CSR generation failed"
openssl x509 -req -in "${WORK}/server.csr" -CA "${WORK}/ca.crt" -CAkey "${WORK}/ca.key" \
  -CAcreateserial -days 1 -out "${WORK}/server.crt" \
  -extfile <(printf 'subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:manager.lantern.internal\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE') >/dev/null 2>&1 \
  || fail "server cert signing failed"

# The manager enforces mTLS (client_ca_root) on EVERY service, including the
# RuntimeManager control RPCs — so the test client must present its own cert
# signed by the same CA. The RuntimeManager service accepts any CA-signed
# client; only RuntimeHarness/VendSecret pins CN==vm_id.
openssl req -newkey rsa:2048 -nodes \
  -keyout "${WORK}/client.key" -out "${WORK}/client.csr" \
  -subj "/CN=integration-test-client" >/dev/null 2>&1 \
  || fail "client CSR generation failed"
openssl x509 -req -in "${WORK}/client.csr" -CA "${WORK}/ca.crt" -CAkey "${WORK}/ca.key" \
  -CAcreateserial -days 1 -out "${WORK}/client.crt" \
  -extfile <(printf 'extendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE') >/dev/null 2>&1 \
  || fail "client cert signing failed"

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
# `setsid` puts the manager in its own process group so cleanup can reap it and
# every firecracker VM it spawns as one unit, without signalling anything else
# on the host.
setsid env \
  RUNTIME_BACKEND=firecracker \
  LANTERN_RUNTIME_BACKEND=firecracker \
  LISTEN_ADDR="${MANAGER_LISTEN_ADDR}" \
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
# Read the group id back rather than assuming it equals MANAGER_PID: `setsid`
# execs in place when the caller is not already a group leader, but forks when
# it is, and only one of those keeps the pid we captured. The group id is what
# cleanup signals, so derive it instead of inferring it.
MANAGER_PGID="$(ps -o pgid= -p "${MANAGER_PID}" 2>/dev/null | tr -d ' ')"
: "${MANAGER_PGID:=${MANAGER_PID}}"

# Wait for the gRPC port to accept connections. The manager has no gRPC
# reflection, so probe the raw TCP port (port_open is defined near cleanup,
# which needs it too).
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
# tenant_id is REQUIRED: the manager refuses to schedule an untenanted
# workload ("spec.tenant_id is required"), per the multi-tenancy invariant.
SPAWN_REQ=$(jq -n --arg uri "${SECRET_URI}" --arg tenant "${ITEST_TENANT_ID}" '{
  spec: {
    tenant_id: $tenant,
    image_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
    isolation: "ISOLATION_HOSTILE",
    limits: { vcpu: "1", memory: "128Mi", timeout: "30s" },
    run_id: "itest-run-001",
    command: ["/usr/local/bin/lantern-harness"],
    secrets: [ { env_name: "OPENAI_API_KEY", secret_uri: $uri } ]
  }
}')

SPAWN_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
  -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
  -d "${SPAWN_REQ}" \
  "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Spawn 2>>"${MANAGER_LOG}") \
  || fail "Spawn RPC failed. Log:\n$(cat "${MANAGER_LOG}")"

VM_ID=$(printf '%s' "${SPAWN_RESP}" | jq -r '.handle.vmId // .handle.id // empty')
[ -n "${VM_ID}" ] || fail "Spawn returned no vm_id: ${SPAWN_RESP}"
log "Spawned vm_id=${VM_ID}"

# ---------------------------------------------------------------------------
# Assertion 2a: Firecracker launched the VM (host-side).
# ---------------------------------------------------------------------------
for _ in $(seq 1 100); do
  grep -q "Firecracker: microVM started" "${MANAGER_LOG}" && break
  sleep 0.3
done
grep -q "Firecracker: microVM started" "${MANAGER_LOG}" \
  || fail "microVM never reported started. Log:\n$(tail -50 "${MANAGER_LOG}")"

# ---------------------------------------------------------------------------
# Assertion 2b: the GUEST actually came up.
#
# "microVM started" is host-side only — it means Firecracker launched a VM, not
# that anything inside it survived. A guest that panics milliseconds later still
# satisfies it. That is not hypothetical: when the harness could not read
# LANTERN_VM_ID, PID 1 exited and the kernel panicked ("Attempted to kill
# init!") ~3s into every boot, and this test reported PASS for all of them.
#
# So require POSITIVE evidence from inside the guest, and fail loudly on a
# panic. The marker is the harness's own startup line, which can only be
# emitted after the guest booted, mounted its filesystems, and read its
# configuration — i.e. it is proof the in-guest contract held, not just that
# the hypervisor accepted a config.
#
# Depends on the guest console being captured into MANAGER_LOG (Firecracker
# inherits the manager's stdio). If that ever stops being true this assertion
# fails, which is correct: a test that cannot see inside the guest cannot
# claim the guest booted.
# ---------------------------------------------------------------------------
GUEST_ALIVE_MARKER="starting lantern-harness (PID 1)"
for _ in $(seq 1 100); do
  grep -q "Kernel panic" "${MANAGER_LOG}" && break
  grep -q "${GUEST_ALIVE_MARKER}" "${MANAGER_LOG}" && break
  sleep 0.3
done

if grep -q "Kernel panic" "${MANAGER_LOG}"; then
  fail "guest KERNEL PANICKED during boot — the VM did NOT come up.\n$(grep -B 8 'Kernel panic' "${MANAGER_LOG}" | tail -20)"
fi
grep -q "${GUEST_ALIVE_MARKER}" "${MANAGER_LOG}" \
  || fail "guest never reported the harness running as PID 1 — the VM launched but nothing came up inside it. Log:\n$(tail -50 "${MANAGER_LOG}")"

pass "microVM booted AND guest is live (vm_id=${VM_ID})"

# ---------------------------------------------------------------------------
# Assertions 3 + 4 (PENDING the in-guest harness agent): the harness is LIVE
#    and a secret vends over the mTLS harness↔manager channel.
#    The hello workload's SDK helper reads the secret socket, which makes the
#    harness call VendSecret with its per-VM client cert (CN == vm_id, signed
#    by the manager CA). The manager logs "VendSecret: issued (value NOT
#    logged)" on success — we assert the success line, NOT the value.
#
#    STATUS: the guest-side agent that performs this round-trip — read vm_id +
#    cert paths from /proc/cmdline, mount the read-only `certs` drive, build the
#    mTLS client, and call VendSecret — is NOT YET implemented in
#    services/harness (manager_client.rs is a stub). The microVM BOOTS with the
#    harness as PID 1 (asserted above) and the kernel registers vsock, but the
#    vend does not yet happen. So this is gated behind EXPECT_VENDSECRET: off by
#    default (the live-boot milestone passes green), flip it on once the harness
#    agent lands to make the full round-trip a hard assertion. Either way the
#    secret-value-never-leaked invariant is always enforced.
# ---------------------------------------------------------------------------
if grep -q "${SECRET_VALUE}" "${MANAGER_LOG}"; then
  fail "secret value leaked into manager log — invariant #10 violated"
fi
if [ "${EXPECT_VENDSECRET:-0}" = "1" ]; then
  for _ in $(seq 1 120); do
    grep -q "VendSecret: issued" "${MANAGER_LOG}" && break
    sleep 0.5
  done
  grep -q "VendSecret: issued" "${MANAGER_LOG}" \
    || fail "secret was not vended over mTLS within timeout. Log:\n$(tail -80 "${MANAGER_LOG}")"
  pass "harness live + secret vended over mTLS (CN=vm_id; value never logged)"
else
  skip "VendSecret round-trip PENDING in-guest harness agent (services/harness manager_client.rs is a stub); set EXPECT_VENDSECRET=1 to assert it. Secret-value-never-leaked invariant: enforced."
fi

# ---------------------------------------------------------------------------
# 4b. Invoke a tool in the guest via ExecTool.
#
# This is the workflow-engine's tool_call path end to end: manager -> in-guest
# harness exec server -> tool registry -> real execution -> typed result. It can
# only succeed after the harness has opened its Heartbeat stream (that is what
# gives the manager the guest address to dial back on), so it also proves the
# harness is reachable, not just that it started.
#
# Needs a shell in the image; build-image.sh installs a static busybox when one
# is available, and skips this assertion when it did not.
# ---------------------------------------------------------------------------
log "Invoking a tool in the guest (ExecTool -> shell_exec)"
TOOL_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
  -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
  -d "{\"vm_id\":\"${VM_ID}\",\"run_id\":\"itest-run-001\",\"step_id\":\"itest-step-1\",\"tool_name\":\"shell_exec\",\"args\":{\"command\":\"echo lantern-tool-marker\"},\"idempotency_key\":\"itest-run-001:itest-step-1:1\"}" \
  "${MANAGER_ADDR}" lantern.v1.RuntimeManager/ExecTool 2>>"${MANAGER_LOG}") || TOOL_RESP=""

if printf '%s' "${TOOL_RESP}" | grep -q "lantern-tool-marker"; then
  pass "tool invoked in-guest and returned its output (ExecTool -> shell_exec)"
elif printf '%s' "${TOOL_RESP}" | grep -q "No such file or directory"; then
  skip "in-guest tool ran but the image has no /bin/sh — install a static busybox to assert execution"
else
  fail "ExecTool did not return the tool's output. Response:\n${TOOL_RESP}\nLog:\n$(tail -30 "${MANAGER_LOG}")"
fi

# ---------------------------------------------------------------------------
# 5. Tear down.
# ---------------------------------------------------------------------------
log "Tearing down vm_id=${VM_ID} (Stop)"
grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
  -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
  -d "$(jq -n --arg id "${VM_ID}" '{vm_id:$id, reason:"integration-test teardown"}')" \
  "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Stop >>"${MANAGER_LOG}" 2>&1 \
  || log "Stop RPC returned non-zero (VM may already be gone) — continuing"

if [ "${EXPECT_VENDSECRET:-0}" = "1" ]; then
  pass "ALL ASSERTIONS PASSED — live Firecracker boot + mTLS VendSecret validated end to end"
else
  pass "LIVE BOOT VALIDATED — Firecracker backend available + microVM booted on KVM (VendSecret round-trip pending the in-guest harness agent)"
fi
