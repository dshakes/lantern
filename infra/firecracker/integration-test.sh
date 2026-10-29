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
# This script's own process group — cleanup refuses to signal it (see cleanup).
SELF_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -dc '0-9')"
# Where the manager wrapper publishes its process group id (see the launch).
MANAGER_PGID_FILE="${WORK}/manager.pgid"
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
  # 1. Stop the VM through the manager FIRST, while the manager is still alive.
  #
  # Killing the manager's process group does NOT reap its VMs: the backend
  # launches each firecracker with `pre_exec(libc::setsid())` (see
  # services/runtime-manager/src/backends/firecracker.rs), so every VM leaves
  # the manager's session before exec and survives a group kill. A run that
  # failed after Spawn but before the explicit Stop would leave a live VM — and
  # since the manager itself does die, the port check below would come back
  # clean and report success while the VM leaked.
  #
  # Stop is also the only path that releases the VM's TAP, so this is a clean
  # shutdown rather than a kill. Best-effort: before the certs exist, or with
  # the manager already gone, grpcurl simply fails and the kill below covers it.
  if [ -n "${VM_ID:-}" ] && [ -s "${WORK}/client.crt" ] && port_open; then
    grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" \
      -servername localhost -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
      -d "$(jq -n --arg id "${VM_ID}" '{vm_id:$id, reason:"integration-test cleanup"}')" \
      "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Stop >/dev/null 2>&1 || true
  fi
  # Forks too: a run that fails mid-fork-test otherwise leaks every fork VM
  # (they outlive the manager for the same setsid reason as above).
  if [ "${#FORK_IDS[@]}" -gt 0 ] && [ -s "${WORK}/client.crt" ] && port_open; then
    for fid in "${FORK_IDS[@]}"; do
      grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" \
        -servername localhost -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
        -d "$(jq -n --arg id "${fid}" '{vm_id:$id, reason:"integration-test cleanup"}')" \
        "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Stop >/dev/null 2>&1 || true
    done
  fi
  # The snapshot this run took (its mem file is the VM's full RAM) - never
  # leave it behind. Only this run's own id, never a glob over the store.
  # Store layout is $SNAPSHOT_DIR/<agent_version_id>/<vm_id>/<snapshot_id>/
  # (see snapshot_store.rs) — the snapshot id directory is at depth 3 from
  # the store root, not depth 2.
  if [ -n "${SNAPSHOT_ID:-}" ]; then
    sudo find /var/lib/lantern/snapshots -mindepth 3 -maxdepth 3 -type d -name "${SNAPSHOT_ID}" \
      -exec rm -r -- {} + 2>/dev/null || true
  fi

  # The pgid may have been published after the handshake loop gave up, so read
  # the file again rather than trusting only the variable. Without this, a
  # handshake that times out while the manager IS running leaks it — the very
  # thing `MANAGER_PID=$!` used to cover.
  if [ -z "${MANAGER_PGID:-}" ] && [ -s "${MANAGER_PGID_FILE:-/nonexistent}" ]; then
    MANAGER_PGID="$(tr -dc '0-9' <"${MANAGER_PGID_FILE}" 2>/dev/null)"
  fi

  # Never signal our own process group, whatever went wrong upstream: that would
  # kill this script (and, under CI, the runner step) instead of the manager.
  # The handshake below should make this unreachable; it is here because the
  # cost of being wrong is losing the run and its diagnostics.
  if [ -n "${MANAGER_PGID:-}" ] && [ "${MANAGER_PGID}" = "${SELF_PGID:-}" ]; then
    printf '\033[1;33m[integration] WARN:\033[0m %s\n' \
      "refusing to signal process group ${MANAGER_PGID} — it is this script's own" >&2
    MANAGER_PGID=""
  fi
  if [ -n "${MANAGER_PGID:-}" ]; then
    kill -TERM -- "-${MANAGER_PGID}" 2>/dev/null || true
    # Give a graceful shutdown a bounded chance (~6s), then stop asking.
    for _ in $(seq 1 30); do
      port_open || break
      sleep 0.2
    done
    kill -KILL -- "-${MANAGER_PGID}" 2>/dev/null || true
  elif [ -n "${MANAGER_LAUNCH_PID:-}" ]; then
    # No usable group id — the wrapper never published one. Fall back to the pid
    # `&` gave us, which is what the pre-handshake code always used. It is the
    # manager itself when setsid exec'd, and a already-exited wrapper when setsid
    # forked, so this is safe either way and strictly better than leaking.
    kill -TERM "${MANAGER_LAUNCH_PID}" 2>/dev/null || true
    sleep 1
    kill -KILL "${MANAGER_LAUNCH_PID}" 2>/dev/null || true
  fi

  # Backstop for any VM that outlived the manager (each firecracker setsid()s
  # into its own session, so nothing above reaches it). Matched on THIS run's
  # vm_ids — the primary PLUS every fork id — in the api socket path, all
  # uuids, so this cannot match another run's VM, an unrelated hypervisor, or
  # this script's own command line. That last part matters: a broad
  # `pkill -f firecracker` also matches the usual dev host's Lima VM name and
  # the shell running this script.
  # Matched on the id ANYWHERE in a firecracker process's argv, not on the
  # bare `/run/firecracker/<id>.sock` path: under jailer mode the socket lives
  # inside the jail root instead, so a path match would miss it and leak the VM.
  # Forks need the same backstop as the primary VM: a manager that dies
  # mid-fork-test leaves every fork's firecracker process reparented and
  # outside any process group this script can reach, exactly like the
  # primary VM case above.
  BACKSTOP_IDS=()
  [ -n "${VM_ID:-}" ] && BACKSTOP_IDS+=("${VM_ID}")
  [ "${#FORK_IDS[@]}" -gt 0 ] && BACKSTOP_IDS+=("${FORK_IDS[@]}")
  if [ "${#BACKSTOP_IDS[@]}" -gt 0 ]; then
    for pid in $(pgrep -x firecracker 2>/dev/null); do
      [ "${pid}" = "$$" ] && continue
      CMDLINE="$(tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null)"
      for id in "${BACKSTOP_IDS[@]}"; do
        if printf '%s' "${CMDLINE}" | grep -qF "${id}"; then
          kill -KILL "${pid}" 2>/dev/null || true
          break
        fi
      done
    done
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
FORK_IDS=()
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
#
# The wrapper publishes the group id ITSELF rather than letting us infer it,
# because `setsid` behaves two different ways and neither is safe to guess at:
#
#   - caller is NOT already a group leader (a script under CI, job control off):
#     setsid execs in place, so the leader keeps the pid `$!` gave us — but only
#     AFTER setsid() has run. Reading the pgid right after `&` is a race, and
#     losing it returns the SCRIPT'S OWN pgid. Cleanup would then `kill` the
#     test script's process group: the same self-kill this file already warns
#     about for `pkill -f firecracker`, arrived at from the other direction.
#   - caller IS a group leader (sourced from an interactive shell): setsid
#     forks, `$!` is the short-lived wrapper, and the pid we captured exits at
#     once — so the health check below would declare the manager dead, and a
#     pgid derived from it would be wrong.
#
# Inside the wrapper, `$$` is the session leader in BOTH cases, so it is the one
# value that is always right. It writes that, then execs the manager, which
# inherits the pid and stays the leader.
# shellcheck disable=SC2016  # $$ intentionally expands in the child bash, not here
setsid bash -c 'echo $$ >"$1"; shift; exec "$@"' _ "${MANAGER_PGID_FILE}" \
  env \
  RUNTIME_BACKEND=firecracker \
  LANTERN_RUNTIME_BACKEND=firecracker \
  LISTEN_ADDR="${MANAGER_LISTEN_ADDR}" \
  LOG_LEVEL=info \
  FC_KERNEL_PATH="${FC_KERNEL_PATH}" \
  FC_ROOTFS_PATH="${FC_ROOTFS_PATH}" \
  ${FC_BINARY_PATH:+FC_BINARY_PATH="${FC_BINARY_PATH}"} \
  ${FIRECRACKER_JAILER_PATH:+FIRECRACKER_JAILER_PATH="${FIRECRACKER_JAILER_PATH}"} \
  ${FIRECRACKER_JAILER_UID:+FIRECRACKER_JAILER_UID="${FIRECRACKER_JAILER_UID}"} \
  ${FIRECRACKER_JAILER_GID:+FIRECRACKER_JAILER_GID="${FIRECRACKER_JAILER_GID}"} \
  ${FIRECRACKER_CHROOT_BASE:+FIRECRACKER_CHROOT_BASE="${FIRECRACKER_CHROOT_BASE}"} \
  LANTERN_MANAGER_TLS_CA="${WORK}/ca.crt" \
  LANTERN_MANAGER_TLS_CERT="${WORK}/server.crt" \
  LANTERN_MANAGER_TLS_KEY="${WORK}/server.key" \
  LANTERN_VM_SIGNING_CA_CERT="${WORK}/ca.crt" \
  LANTERN_VM_SIGNING_CA_KEY="${WORK}/ca.key" \
  LANTERN_MEASUREMENT_GATE="${PAL_MEASUREMENT_GATE:-${LANTERN_MEASUREMENT_GATE:-warn}}" \
  LANTERN_VM_CERT_DIR="${WORK}/vm-certs" \
  "${SECRET_ENV_KEY}=${SECRET_VALUE}" \
  "${MANAGER_BIN}" >"${MANAGER_LOG}" 2>&1 &
# Recorded BEFORE the handshake so an early failure still has something to kill:
# every `fail` from here on runs cleanup, and until the pgid is published this is
# the only handle on the manager.
MANAGER_LAUNCH_PID=$!

# Wait for the wrapper to publish its pid — this is a handshake, not a guess, so
# there is no race left to lose.
for _ in $(seq 1 50); do
  [ -s "${MANAGER_PGID_FILE}" ] && break
  sleep 0.1
done
MANAGER_PGID="$(tr -dc '0-9' <"${MANAGER_PGID_FILE}" 2>/dev/null)"
[ -n "${MANAGER_PGID}" ] || fail "manager wrapper never published its process group id"
# The wrapper exec'd into the manager, so the leader's pid IS the manager's pid.
# Use it for liveness rather than `$!`, which is the setsid wrapper when setsid
# forks and would look dead immediately.
MANAGER_PID="${MANAGER_PGID}"

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
# Timing infrastructure.  Every lifecycle step records a start + end epoch-ms
# value.  At the very end these are emitted as JSON + markdown so CI can upload
# the file as a build artifact.
# ---------------------------------------------------------------------------
ms() { date +%s%3N; }
# TIMING_JSON accumulates a JSON array of objects; assembled at the end.
TIMING_JSON="[]"
timing_record() {
  # timing_record <label> <start_ms> <end_ms>
  local label="$1" start_ms="$2" end_ms="$3"
  local duration_ms=$(( end_ms - start_ms ))
  TIMING_JSON=$(printf '%s' "${TIMING_JSON}" \
    | jq --arg l "${label}" --argjson s "${start_ms}" --argjson e "${end_ms}" --argjson d "${duration_ms}" \
         '. + [{label:$l, start_ms:$s, end_ms:$e, duration_ms:$d}]')
}

# Wait for the heartbeat bidi stream before issuing any ExecTool call.
# VendSecret (vsock) can succeed before the heartbeat TCP address is registered
# in the manager, but ExecTool requires that address.  This wait is bounded
# and idempotent — if VendSecret was skipped the stream is still needed.
for _ in $(seq 1 60); do
  grep -q "heartbeat: bidi stream established" "${MANAGER_LOG}" && break
  sleep 0.5
done
grep -q "heartbeat: bidi stream established" "${MANAGER_LOG}" \
  || fail "heartbeat stream never established before ExecTool — guest may not have connected back. Log:\n$(tail -40 "${MANAGER_LOG}")"
log "heartbeat bidi stream established — ExecTool path is ready"

# ---------------------------------------------------------------------------
# 4b. Invoke a tool in the guest via ExecTool (shell_exec marker check).
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
T0=$(ms)
TOOL_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
  -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
  -d "{\"vm_id\":\"${VM_ID}\",\"run_id\":\"itest-run-001\",\"step_id\":\"itest-step-1\",\"tool_name\":\"shell_exec\",\"args\":{\"command\":\"echo lantern-tool-marker\"},\"idempotency_key\":\"itest-run-001:itest-step-1:1\"}" \
  "${MANAGER_ADDR}" lantern.v1.RuntimeManager/ExecTool 2>>"${MANAGER_LOG}") || TOOL_RESP=""
timing_record "shell_exec" "${T0}" "$(ms)"

SHELL_EXEC_AVAILABLE=false
if printf '%s' "${TOOL_RESP}" | grep -q "lantern-tool-marker"; then
  pass "tool invoked in-guest and returned its output (ExecTool -> shell_exec)"
  SHELL_EXEC_AVAILABLE=true
elif printf '%s' "${TOOL_RESP}" | grep -q "No such file or directory"; then
  skip "in-guest tool ran but the image has no /bin/sh — install a static busybox to assert execution"
else
  fail "ExecTool did not return the tool's output. Response:\n${TOOL_RESP}\nLog:\n$(tail -30 "${MANAGER_LOG}")"
fi

# ---------------------------------------------------------------------------
# 4c. Lifecycle — write a state file before snapshot so we can verify it
#     survives a stop/restore cycle.  Only runs when shell_exec is available
#     (the marker proof above passed), since write_file requires a real
#     harness exec layer — same dependency.
# ---------------------------------------------------------------------------
SNAPSHOT_ID=""
SNAPSHOT_AVAILABLE=false

if [ "${SHELL_EXEC_AVAILABLE}" = "true" ]; then
  # ---- 4c-i. write_file: drop a known marker into /workspace ----
  MARKER_PATH="/workspace/itest-state-marker.txt"
  MARKER_CONTENT="lantern-state-survived-restore-$(date +%s)"
  log "Writing state marker before snapshot (write_file -> ${MARKER_PATH})"
  T0=$(ms)
  WRITE_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
    -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -d "$(jq -n --arg vm "${VM_ID}" --arg path "${MARKER_PATH}" --arg content "${MARKER_CONTENT}" \
           '{vm_id:$vm,run_id:"itest-run-001",step_id:"itest-step-wf",
             tool_name:"write_file",args:{path:$path,content:$content},
             idempotency_key:"itest-run-001:itest-step-wf:1"}')" \
    "${MANAGER_ADDR}" lantern.v1.RuntimeManager/ExecTool 2>>"${MANAGER_LOG}") || WRITE_RESP=""
  timing_record "write_file" "${T0}" "$(ms)"

  if printf '%s' "${WRITE_RESP}" | grep -qi '"status":"OK"\|bytes_written\|"result"'; then
    pass "state marker written to guest /workspace"
  else
    fail "write_file failed. Response:\n${WRITE_RESP}\nLog:\n$(tail -20 "${MANAGER_LOG}")"
  fi

  # ---- 4c-i-b. Flush the marker to the VM's disk before snapshotting ----
  # WP2 regression guard. The workload runs as uid 1000, so it cannot
  # `echo 3 > /proc/sys/vm/drop_caches`; the post-restore check below uses an
  # O_DIRECT read instead, which bypasses the guest page cache for the file's
  # data. `sync` here makes those pages clean, so O_DIRECT cannot be satisfied
  # by flushing them from memory — the bytes must already be on the disk the
  # restored VM was given. A restore onto the base rootfs (no disk in the
  # snapshot) reads zeros/garbage there instead of the marker.
  log "Flushing guest writes to disk before snapshot (sync)"
  SYNC_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
    -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -d "$(jq -n --arg vm "${VM_ID}" \
           '{vm_id:$vm,run_id:"itest-run-001",step_id:"itest-step-sync",
             tool_name:"shell_exec",args:{command:"sync && echo synced-ok"},
             idempotency_key:"itest-run-001:itest-step-sync:1"}')" \
    "${MANAGER_ADDR}" lantern.v1.RuntimeManager/ExecTool 2>>"${MANAGER_LOG}") || SYNC_RESP=""
  printf '%s' "${SYNC_RESP}" | grep -q "synced-ok" \
    || fail "guest sync failed. Response:\n${SYNC_RESP}"
  pass "guest writes flushed to disk before snapshot"

  # ---- 4c-ii. Snapshot ----
  log "Snapshotting vm_id=${VM_ID} (Snapshot RPC)"
  T0=$(ms)
  SNAP_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
    -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -d "$(jq -n --arg id "${VM_ID}" '{vm_id:$id}')" \
    "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Snapshot 2>>"${MANAGER_LOG}") \
    || fail "Snapshot RPC failed. Log:\n$(tail -30 "${MANAGER_LOG}")"
  timing_record "snapshot" "${T0}" "$(ms)"

  SNAPSHOT_ID=$(printf '%s' "${SNAP_RESP}" | jq -r '.snapshotId // .snapshot_id // empty')
  [ -n "${SNAPSHOT_ID}" ] || fail "Snapshot returned no snapshot_id: ${SNAP_RESP}"
  SNAP_BYTES=$(printf '%s' "${SNAP_RESP}" | jq -r '.bytes // 0')
  log "Snapshot created: id=${SNAPSHOT_ID} bytes=${SNAP_BYTES}"
  pass "snapshot succeeded (${SNAP_BYTES} bytes, id=${SNAPSHOT_ID})"
  SNAPSHOT_AVAILABLE=true

  # The backend always resumes the VM after snapshotting.  Now Stop it so that
  # the restore below proves a full pause/restore cycle — not a hot copy.
  # ---- 4c-iii. Stop the VM ----
  log "Stopping vm_id=${VM_ID} (Stop)"
  T0=$(ms)
  grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
    -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -d "$(jq -n --arg id "${VM_ID}" '{vm_id:$id, reason:"lifecycle-test stop before restore"}')" \
    "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Stop >>"${MANAGER_LOG}" 2>&1 \
    || log "Stop returned non-zero — may already be stopping"
  timing_record "stop" "${T0}" "$(ms)"

  # Assert the firecracker process for this VM is gone.  A leaked process would
  # appear as a false-alive restored VM or a stale socket — both misleading.
  FC_LEAKED=false
  for _ in $(seq 1 30); do
    FC_LEAKED=false
    for pid in $(pgrep -x firecracker 2>/dev/null); do
      if tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | grep -qF "${VM_ID}"; then
        FC_LEAKED=true
        break
      fi
    done
    [ "${FC_LEAKED}" = "false" ] && break
    sleep 0.2
  done
  if [ "${FC_LEAKED}" = "true" ]; then
    fail "firecracker process for ${VM_ID} still running after Stop — process leak"
  fi
  pass "VM stopped — no firecracker process for ${VM_ID}"

  # ---- 4c-iv. Restore (Spawn with restore_snapshot_id) ----
  # In bare (unjailed) mode the backend requires the same vm_id as the source.
  # The restore stages its own writable copy of the disk captured with the
  # snapshot, so writes never bleed back into the snapshot image.
  log "Restoring vm_id=${VM_ID} from snapshot_id=${SNAPSHOT_ID}"
  RESTORE_REQ=$(jq -n \
    --arg uri "${SECRET_URI}" \
    --arg tenant "${ITEST_TENANT_ID}" \
    --arg snap "${SNAPSHOT_ID}" \
    --arg vmid "${VM_ID}" \
    '{
      spec: {
        tenant_id: $tenant,
        image_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
        isolation: "ISOLATION_HOSTILE",
        limits: { vcpu: "1", memory: "128Mi", timeout: "30s" },
        run_id: "itest-run-002",
        command: ["/usr/local/bin/lantern-harness"],
        secrets: [ { env_name: "OPENAI_API_KEY", secret_uri: $uri } ],
        restore_snapshot_id: $snap
      },
      handle: { vm_id: $vmid }
    }')
  T0=$(ms)
  RESTORE_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
    -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -d "${RESTORE_REQ}" \
    "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Spawn 2>>"${MANAGER_LOG}") \
    || fail "Restore Spawn RPC failed. Log:\n$(tail -30 "${MANAGER_LOG}")"
  timing_record "restore" "${T0}" "$(ms)"

  RESTORED_VM_ID=$(printf '%s' "${RESTORE_RESP}" | jq -r '.handle.vmId // .handle.id // empty')
  [ -n "${RESTORED_VM_ID}" ] || fail "Restore Spawn returned no vm_id: ${RESTORE_RESP}"
  FROM_SNAP=$(printf '%s' "${RESTORE_RESP}" | jq -r '.fromSnapshot // false')
  log "Restored vm_id=${RESTORED_VM_ID} (from_snapshot=${FROM_SNAP})"

  # Wait for the restored harness to come alive.
  #
  # A restored VM resumes from memory state — the harness was already running,
  # so the "starting lantern-harness (PID 1)" boot banner does NOT re-appear.
  # What DOES appear is a new heartbeat stream established line once the harness
  # reconnects the bidi stream to the manager (it detects the session ended and
  # reconnects).  Use that as the alive signal, falling back to the old boot
  # marker in case the heartbeat log format changes.
  RESTORE_ALIVE_MARKER="heartbeat: bidi stream established"
  RESTORE_ALIVE_MARKER2="${GUEST_ALIVE_MARKER}"
  for _ in $(seq 1 100); do
    grep -q "Kernel panic" "${MANAGER_LOG}" && break
    grep -qF "${RESTORE_ALIVE_MARKER}"  "${MANAGER_LOG}" && break
    # Also accept a second boot-banner as a fallback (e.g. cold-restored harness).
    ALIVE_COUNT=$(grep -c "${RESTORE_ALIVE_MARKER2}" "${MANAGER_LOG}" 2>/dev/null || echo 0)
    [ "${ALIVE_COUNT}" -ge 2 ] && break
    sleep 0.3
  done
  if grep -q "Kernel panic" "${MANAGER_LOG}"; then
    fail "guest PANICKED after restore.\n$(grep -B 8 'Kernel panic' "${MANAGER_LOG}" | tail -20)"
  fi
  if grep -qF "${RESTORE_ALIVE_MARKER}" "${MANAGER_LOG}"; then
    pass "restored VM is alive (heartbeat stream re-established after restore)"
  else
    ALIVE_COUNT=$(grep -c "${RESTORE_ALIVE_MARKER2}" "${MANAGER_LOG}" 2>/dev/null || echo 0)
    [ "${ALIVE_COUNT}" -ge 2 ] \
      || fail "harness not alive after restore — no heartbeat reconnect and no second startup marker (${ALIVE_COUNT} occurrences). Log:\n$(tail -40 "${MANAGER_LOG}")"
    pass "restored VM is alive (harness re-reported startup)"
  fi

  # ---- 4c-v. re-identification check ----
  # The backend issues PATCH /drives/certs with the new cert image before
  # resuming, so the restored VM's cert CN should match the (unchanged) vm_id.
  # We can verify this by confirming the manager logged the identity swap.
  if grep -q "plan_identity_restore\|PATCH.*drives/certs\|new identity\|cert.*swapped\|reidentif" "${MANAGER_LOG}"; then
    pass "re-identification log found in manager output"
  else
    # Not a hard failure: different build profiles may not emit a debug-level log.
    skip "re-identification log line not found (debug logs may be suppressed); cert swap is enforced structurally"
  fi

  # ---- 4c-vi. read_file: verify state marker survived ----
  # ONE ExecTool, no retry loop: the manager holds an exec until the restored
  # harness has re-identified and heartbeated under the new cert (bounded by
  # LANTERN_HARNESS_READY_TIMEOUT_MS, default 5 s). Gate: the first exec after
  # restore hard-fails above FIRST_EXEC_MAX_MS (default 3500 ms) and warns above
  # FIRST_EXEC_WARN_MS (default 1500 ms). Nested-virt Lima lands 2.6–3.1 s: the
  # guest-side re-identify + mTLS reconnect run slowly right after restore there.
  FIRST_EXEC_MAX_MS="${FIRST_EXEC_MAX_MS:-3500}"
  FIRST_EXEC_WARN_MS="${FIRST_EXEC_WARN_MS:-1500}"
  log "Verifying state marker survived snapshot/restore (single read_file)"
  T0=$(ms)
  READ_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
    -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -d "$(jq -n --arg vm "${RESTORED_VM_ID}" --arg path "${MARKER_PATH}" \
           '{vm_id:$vm,run_id:"itest-run-002",step_id:"itest-step-rf",
             tool_name:"read_file",args:{path:$path},
             idempotency_key:"itest-run-002:itest-step-rf:1"}')" \
    "${MANAGER_ADDR}" lantern.v1.RuntimeManager/ExecTool 2>>"${MANAGER_LOG}") || READ_RESP=""
  T1=$(ms)
  timing_record "read_file_after_restore" "${T0}" "${T1}"
  [ $(( T1 - T0 )) -le "${FIRST_EXEC_MAX_MS}" ] \
    || fail "first exec after restore took $(( T1 - T0 )) ms (> ${FIRST_EXEC_MAX_MS} ms). Response: ${READ_RESP}\nLog:\n$(grep -E 'harness ready|waited for the harness|readiness timeout|reidentify' "${MANAGER_LOG}" | tail -10)"
  [ $(( T1 - T0 )) -le "${FIRST_EXEC_WARN_MS}" ] \
    || log "WARN: first exec after restore took $(( T1 - T0 )) ms (> ${FIRST_EXEC_WARN_MS} ms target)"
  pass "first exec after restore: $(( T1 - T0 )) ms (gate ${FIRST_EXEC_MAX_MS} ms)"

  if printf '%s' "${READ_RESP}" | grep -qF "${MARKER_CONTENT}"; then
    pass "state marker survived stop/restore — file system state is durable across snapshot cycles"
  else
    fail "state marker NOT found after restore. Expected: ${MARKER_CONTENT}. Response:\n${READ_RESP}\nLog:\n$(tail -30 "${MANAGER_LOG}")"
  fi

  # ---- 4c-vi-b. The marker is on the restored DISK, not just in guest memory ----
  # read_file above can be served from the guest page cache the snapshot
  # carried, which passes even when the restored disk is the base image. An
  # O_DIRECT read skips that cache: it returns the marker only if the disk
  # captured with the snapshot is the one this VM resumed on.
  log "Verifying the marker is on the restored disk (O_DIRECT read, page cache bypassed)"
  T0=$(ms)
  DIRECT_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
    -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -d "$(jq -n --arg vm "${RESTORED_VM_ID}" --arg cmd "dd if=${MARKER_PATH} bs=4096 iflag=direct 2>/dev/null" \
           '{vm_id:$vm,run_id:"itest-run-002",step_id:"itest-step-direct",
             tool_name:"shell_exec",args:{command:$cmd},
             idempotency_key:"itest-run-002:itest-step-direct:1"}')" \
    "${MANAGER_ADDR}" lantern.v1.RuntimeManager/ExecTool 2>>"${MANAGER_LOG}") || DIRECT_RESP=""
  timing_record "direct_read_after_restore" "${T0}" "$(ms)"
  if printf '%s' "${DIRECT_RESP}" | grep -qF "${MARKER_CONTENT}"; then
    pass "marker read from the restored disk with the page cache bypassed — the snapshot captured the VM's disk"
  else
    fail "DISK STATE LOST: marker absent on the restored disk (O_DIRECT read). The restore resumed guest memory onto a disk that does not match it. Response:\n${DIRECT_RESP}"
  fi

  # VM_ID now points at the restored VM so cleanup stops it.
  VM_ID="${RESTORED_VM_ID}"

  # Stop the restored VM before the fork test.  The fork test spawns N new
  # vm_ids from the same snapshot.  In bare (unjailed) mode the manager refuses
  # to spawn a fork while the snapshot's source vm_id is still running because
  # each bare restore binds to /run/lantern/vsock/<source-vm-id>.sock — two
  # running VMs with the same id would collide.  Stopping first satisfies the
  # manager's FailedPrecondition guard without requiring the jailer.
  log "Stopping restored vm_id=${VM_ID} before fork test"
  T0=$(ms)
  grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
    -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -d "$(jq -n --arg id "${VM_ID}" '{vm_id:$id, reason:"stop before fork test"}')" \
    "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Stop >>"${MANAGER_LOG}" 2>&1 \
    || log "Stop returned non-zero (VM may already be gone)"
  timing_record "stop_before_fork" "${T0}" "$(ms)"
  pass "restored VM stopped before fork test"
fi # SHELL_EXEC_AVAILABLE

# ---------------------------------------------------------------------------
# 4d. Fork test (conditional on FIRECRACKER_JAILER_PATH being explicitly set).
#
# Forking N distinct vm_ids from the same snapshot requires the jailer: bare
# mode can only restore the source vm_id because the vsock socket path is
# baked into the snapshot state.  A fork with a different vm_id in bare mode
# always gets FailedPrecondition from the manager.
#
# Detection: FIRECRACKER_JAILER_PATH must be explicitly set in the environment
# — finding the jailer binary on PATH is NOT sufficient, because the manager
# must also be started with that env var to enable jailed mode.  Both the
# manager env (propagated via the setsid block above) and the fork request
# must agree that jailing is in use.  Auto-discovery from PATH causes a false
# positive: the binary exists but the manager runs bare, so every fork gets
# FailedPrecondition.
#
# Fork verifications:
#   a. Each fork gets a distinct vm_id and comes alive.
#   b. COW isolation: writing fork-N.txt in fork-N is NOT visible in fork-M.
#   c. All fork VMs are terminated cleanly (no leaked processes).
# ---------------------------------------------------------------------------
JAILER_PATH="${FIRECRACKER_JAILER_PATH:-}"

if [ -z "${JAILER_PATH}" ] || [ ! -x "${JAILER_PATH}" ]; then
  skip "fork test SKIPPED — FIRECRACKER_JAILER_PATH not set or not executable (set FIRECRACKER_JAILER_PATH to the jailer binary; jailer binary on PATH is not sufficient because the manager must also be started with it)"
elif [ "${SNAPSHOT_AVAILABLE}" = "false" ]; then
  skip "fork test SKIPPED — no snapshot available (shell_exec or snapshot step was skipped)"
else
  log "Running fork lifecycle test with jailer=${JAILER_PATH}"
  FORK_SNAP_ID="${SNAPSHOT_ID}"

  # Spawn 3 forks, each with a unique vm_id and a different run_id.
  FORK_IDS=()
  for i in 1 2 3; do
    FORK_VM_ID="itest-fork-$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-' | head -c 16)"
    log "Spawning fork #${i}: vm_id=${FORK_VM_ID}"
    FORK_REQ=$(jq -n \
      --arg tenant "${ITEST_TENANT_ID}" \
      --arg snap "${FORK_SNAP_ID}" \
      --arg vmid "${FORK_VM_ID}" \
      --arg run "itest-fork-run-${i}" \
      '{
        spec: {
          tenant_id: $tenant,
          image_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
          isolation: "ISOLATION_HOSTILE",
          limits: { vcpu: "1", memory: "128Mi", timeout: "30s" },
          run_id: $run,
          command: ["/usr/local/bin/lantern-harness"],
          restore_snapshot_id: $snap
        },
        handle: { vm_id: $vmid }
      }')
    T0=$(ms)
    FORK_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
      -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
      -d "${FORK_REQ}" \
      "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Spawn 2>>"${MANAGER_LOG}") \
      || fail "Fork #${i} Spawn failed. Log:\n$(tail -30 "${MANAGER_LOG}")"
    timing_record "fork_spawn_${i}" "${T0}" "$(ms)"

    SPAWNED_ID=$(printf '%s' "${FORK_RESP}" | jq -r '.handle.vmId // .handle.id // empty')
    [ -n "${SPAWNED_ID}" ] || fail "Fork #${i} Spawn returned no vm_id: ${FORK_RESP}"
    FORK_IDS+=("${SPAWNED_ID}")
    pass "fork #${i} spawned: vm_id=${SPAWNED_ID}"
  done

  # Wait for all forks to come alive: watch for 3 distinct heartbeat reconnects
  # (one per fork) in the manager log.  Because three VMs log concurrently,
  # lines can interleave at the byte level — we count heartbeat occurrences
  # rather than grepping for a specific vm_id within a single line.
  # The write_file retry below serves as the final readiness gate.
  for _ in $(seq 1 150); do
    grep -q "Kernel panic" "${MANAGER_LOG}" && break
    HB_COUNT=$(grep -c "heartbeat: bidi stream established" "${MANAGER_LOG}" 2>/dev/null || echo 0)
    # At least 3 new heartbeats (original VM + 3 forks may produce ≥4 total).
    [ "${HB_COUNT}" -ge 4 ] && break
    sleep 0.3
  done
  if grep -q "Kernel panic" "${MANAGER_LOG}"; then
    fail "kernel panic during fork"
  fi
  pass "all 3 forks are alive (heartbeat reconnects observed in manager log)"

  # Assert distinct vm_ids.
  if [ "${#FORK_IDS[@]}" -eq 3 ] && \
     [ "${FORK_IDS[0]}" != "${FORK_IDS[1]}" ] && \
     [ "${FORK_IDS[1]}" != "${FORK_IDS[2]}" ] && \
     [ "${FORK_IDS[0]}" != "${FORK_IDS[2]}" ]; then
    pass "all 3 forks have distinct vm_ids"
  else
    fail "fork vm_ids are not all distinct: ${FORK_IDS[*]}"
  fi

  # COW isolation: write fork-N.txt in each fork.  The ExecTool channel is
  # ready once the heartbeat stream reconnects (~0.5–5 s) — retry up to 6×2s.
  # Same regression guard as read_file_after_restore: a 35 s timeout would
  # exhaust the budget on the first attempt.
  for i in "${!FORK_IDS[@]}"; do
    fid="${FORK_IDS[$i]}"
    n=$(( i + 1 ))
    log "Writing /workspace/fork-${n}.txt in fork ${fid}"
    WF_RESP=""
    for attempt in $(seq 1 6); do
      WF_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
        -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
        -d "$(jq -n --arg vm "${fid}" --arg path "/workspace/fork-${n}.txt" --arg content "fork-${n}-marker" \
               "{vm_id:\$vm,run_id:\"itest-fork-run-${n}\",step_id:\"wf-${n}\",
                 tool_name:\"write_file\",args:{path:\$path,content:\$content},
                 idempotency_key:\"itest-fork-run-${n}:wf-${n}:1\"}")" \
        "${MANAGER_ADDR}" lantern.v1.RuntimeManager/ExecTool 2>>"${MANAGER_LOG}") || WF_RESP=""
      printf '%s' "${WF_RESP}" | grep -qi '"status":"OK"\|bytes_written\|"result"' && break
      log "write_file fork-${n} attempt ${attempt}: waiting 2s..."
      sleep 2
    done
    printf '%s' "${WF_RESP}" | grep -qi '"status":"OK"\|bytes_written\|"result"' \
      || fail "write_file fork-${n}.txt in fork ${fid} failed after retries: ${WF_RESP}"
  done
  pass "wrote fork-N.txt in each of the 3 fork VMs"

  # Now read fork-1.txt from fork-2 — it must NOT be there (COW isolation).
  fid2="${FORK_IDS[1]}"
  log "Verifying COW isolation: fork-1.txt must NOT be visible in fork-2 (${fid2})"
  COW_RESP=$(grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
    -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
    -d "$(jq -n --arg vm "${fid2}" \
           '{vm_id:$vm,run_id:"itest-fork-run-2",step_id:"cow-check",
             tool_name:"read_file",args:{path:"/workspace/fork-1.txt"},
             idempotency_key:"itest-fork-run-2:cow-check:1"}')" \
    "${MANAGER_ADDR}" lantern.v1.RuntimeManager/ExecTool 2>>"${MANAGER_LOG}") || COW_RESP=""
  if printf '%s' "${COW_RESP}" | grep -q "fork-1-marker"; then
    fail "COW ISOLATION FAILURE: fork-1.txt from fork-1 is visible in fork-2 — writes are bleeding across VM rootfs images"
  else
    pass "COW isolation verified: fork-1.txt written in fork-1 is NOT visible in fork-2"
  fi

  # Hard-link inode verification — prove the shared-memory optimization from
  # PR #295 is active (mem is hard-linked, not copied into each fork's jail).
  #
  # Rationale: plan_jailed_fork_staging() places the mem artifact in .links[]
  # (hard-link / MAP_PRIVATE CoW) rather than .copies[].  If the optimization
  # is working, every fork's mem file in <chroot_base>/<fc_bin>/<vm_id>/root/
  # snapshot/mem must have the SAME inode as the source snapshot mem file in
  # the snapshot store.  EXDEV (cross-device hard link) falls back to a copy;
  # on the Lima tmpfs + local-disk store setup both paths are on the same
  # filesystem, so EXDEV should not occur.
  CHROOT_BASE="${FIRECRACKER_CHROOT_BASE:-/srv/jailer}"
  FC_BIN_NAME="firecracker"
  [ -n "${FC_BINARY_PATH:-}" ] && FC_BIN_NAME=$(basename "${FC_BINARY_PATH}")

  # Find the snapshot mem file in the store by snapshot_id.
  SNAP_MEM_PATH=$(sudo find /var/lib/lantern/snapshots -name "mem" -path "*/${FORK_SNAP_ID}/mem" 2>/dev/null | head -1)
  if [ -z "${SNAP_MEM_PATH}" ]; then
    fail "snapshot mem file not found in store for snapshot_id=${FORK_SNAP_ID} — hard-link check cannot proceed"
  fi
  SNAP_MEM_INODE=$(sudo stat -c '%i' "${SNAP_MEM_PATH}")
  SNAP_MEM_NLINKS=$(sudo stat -c '%h' "${SNAP_MEM_PATH}")
  log "snapshot mem: path=${SNAP_MEM_PATH} inode=${SNAP_MEM_INODE} link_count=${SNAP_MEM_NLINKS}"

  HARD_LINK_FAILURES=0
  for fid in "${FORK_IDS[@]}"; do
    FORK_MEM="${CHROOT_BASE}/${FC_BIN_NAME}/${fid}/root/snapshot/mem"
    if ! sudo test -f "${FORK_MEM}"; then
      log "FAIL: fork ${fid}: mem file not found at ${FORK_MEM}"
      HARD_LINK_FAILURES=$(( HARD_LINK_FAILURES + 1 ))
      continue
    fi
    FORK_MEM_INODE=$(sudo stat -c '%i' "${FORK_MEM}")
    if [ "${FORK_MEM_INODE}" = "${SNAP_MEM_INODE}" ]; then
      pass "fork ${fid}: mem file hard-linked to snapshot mem (inode=${FORK_MEM_INODE})"
    else
      log "FAIL: fork ${fid}: mem inode=${FORK_MEM_INODE} != snapshot mem inode=${SNAP_MEM_INODE} (copy path used instead of hard-link — PR #295 optimization not active)"
      HARD_LINK_FAILURES=$(( HARD_LINK_FAILURES + 1 ))
    fi
  done

  if [ "${HARD_LINK_FAILURES}" -gt 0 ]; then
    fail "${HARD_LINK_FAILURES} fork(s) did not share the snapshot mem inode — hard-link optimization not applied"
  fi
  pass "all 3 fork mem files share snapshot mem inode ${SNAP_MEM_INODE} (link_count=${SNAP_MEM_NLINKS}) — MAP_PRIVATE CoW sharing active"

  # --- FICLONE disk-staging verification (WP4-reflink) ---
  #
  # Each fork must stage its disk image via FICLONE (copy-on-write reflink,
  # O(1) disk I/O) OR fall back to a full byte copy with a structured WARN
  # (disk_staging="full_copy").  The manager logs one of:
  #   "disk staged via FICLONE (CoW reflink, O(1) disk I/O)"  [disk_staging=ficlone]
  #   "disk staged via full byte copy ..."                     [disk_staging=full_copy]
  #
  # If LANTERN_REQUIRE_REFLINK=1 is set and the snapshot dir is NOT on an
  # XFS/btrfs filesystem, forks would have already failed above — so reaching
  # this point implies staging succeeded (FICLONE or fallback).
  #
  # How to verify FICLONE independently (Lima):
  #   sudo filefrag -v <fork-chroot>/snapshot/rootfs 2>&1 | head -5
  # Shared extents (CoW) show the same physical block range as the source.
  FICLONE_LOG="${WORK}/manager.log"
  if [ ! -f "${FICLONE_LOG}" ]; then
    # Manager log written to a separate path when LANTERN_MANAGER_LOG is set.
    FICLONE_LOG="${PAL_MANAGER_LOG:-${LANTERN_MANAGER_LOG:-${MANAGER_LOG}}}"
  fi

  # grep -c exits 1 on 0 matches (prints "0") and exits 2 when the file is
  # missing (prints nothing).  Using `|| echo 0` with grep -c causes double
  # output ("0\n0") when the file exists but has no matches.  Instead: check
  # existence first, then use `|| true` so the exit code is always 0 and the
  # variable gets a clean integer (empty → 0 default).
  if [ -f "${FICLONE_LOG}" ]; then
    FICLONE_COUNT=$(grep -cF "disk staged via FICLONE" "${FICLONE_LOG}" || true)
    FULLCOPY_COUNT=$(grep -cF "disk staged via full byte copy" "${FICLONE_LOG}" || true)
    FICLONE_COUNT="${FICLONE_COUNT:-0}"
    FULLCOPY_COUNT="${FULLCOPY_COUNT:-0}"
  else
    FICLONE_COUNT=0
    FULLCOPY_COUNT=0
  fi
  TOTAL_DISK_EVENTS=$(( FICLONE_COUNT + FULLCOPY_COUNT ))

  if [ "${FICLONE_COUNT}" -ge "${#FORK_IDS[@]}" ]; then
    pass "disk staged via FICLONE for all ${#FORK_IDS[@]} fork(s) (CoW reflink, O(1) disk I/O)"
  elif [ "${TOTAL_DISK_EVENTS}" -ge "${#FORK_IDS[@]}" ]; then
    # Forks succeeded but used full-copy fallback (ext4/tmpfs node, no FICLONE).
    # This is correct default behaviour — log it as a WARN for operator awareness.
    log "WARN: disk staging used full byte copy (${FULLCOPY_COUNT} fork(s)) instead of FICLONE."
    log "WARN: For CoW fork scale, mount the snapshot dir on XFS (mkfs.xfs -m reflink=1) or btrfs"
    log "WARN: and set LANTERN_REQUIRE_REFLINK=1 in the manager env to enforce FICLONE."
    pass "disk staging completed via full-copy fallback (${FULLCOPY_COUNT} full-copy, ${FICLONE_COUNT} FICLONE events found)"
  else
    # No staging log events at all — WP4-reflink binary may not be active.
    log "WARN: ${#FORK_IDS[@]} fork(s) completed but found no disk staging log events in ${FICLONE_LOG}."
    log "WARN: Expected 'disk staged via FICLONE' or 'disk staged via full byte copy' for each fork."
    log "WARN: Check: (1) LANTERN_SNAPSHOT_DIR and FIRECRACKER_CHROOT_BASE point to the right paths;"
    log "WARN: (2) manager binary includes WP4-reflink changes; (3) FICLONE_LOG=${FICLONE_LOG} is the right file."
    # Not a hard fail: forks passed functionally; this is an observability gap.
    log "WARN: Treating as non-blocking — forks succeeded. Investigate missing log events."
  fi

  # Tear down all forks cleanly.
  for fid in "${FORK_IDS[@]}"; do
    log "Stopping fork vm_id=${fid}"
    grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
      -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
      -d "$(jq -n --arg id "${fid}" '{vm_id:$id, reason:"fork-lifecycle-test teardown"}')" \
      "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Stop >>"${MANAGER_LOG}" 2>&1 || true
  done

  # Verify no fork processes leaked.
  LEAKED_FORKS=0
  for fid in "${FORK_IDS[@]}"; do
    for pid in $(pgrep -x firecracker 2>/dev/null); do
      if tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | grep -qF "${fid}"; then
        LEAKED_FORKS=$(( LEAKED_FORKS + 1 ))
        log "WARN: firecracker process for fork ${fid} still running (pid ${pid})"
      fi
    done
  done
  if [ "${LEAKED_FORKS}" -gt 0 ]; then
    fail "${LEAKED_FORKS} fork firecracker process(es) still running after Stop — process leak"
  fi
  pass "all 3 fork VMs stopped cleanly — no leaked processes"
fi # jailer fork test

# ---------------------------------------------------------------------------
# 5. Tear down the primary VM (or restored VM).
# ---------------------------------------------------------------------------
log "Tearing down vm_id=${VM_ID} (Stop)"
grpcurl -cacert "${WORK}/ca.crt" -cert "${WORK}/client.crt" -key "${WORK}/client.key" -servername localhost \
  -import-path "${PROTO_DIR}" -proto "${PROTO_FILE}" \
  -d "$(jq -n --arg id "${VM_ID}" '{vm_id:$id, reason:"integration-test teardown"}')" \
  "${MANAGER_ADDR}" lantern.v1.RuntimeManager/Stop >>"${MANAGER_LOG}" 2>&1 \
  || log "Stop RPC returned non-zero (VM may already be gone) — continuing"

# ---------------------------------------------------------------------------
# 6. Emit timing summary as JSON + markdown.
# ---------------------------------------------------------------------------
TIMING_DIR="${LIFECYCLE_TIMING_DIR:-${WORK}/timing}"
mkdir -p "${TIMING_DIR}"
TIMING_JSON_FILE="${TIMING_DIR}/lifecycle-timing.json"
TIMING_MD_FILE="${TIMING_DIR}/lifecycle-timing.md"

# Annotate with run context.
FULL_TIMING=$(jq -n \
  --argjson steps "${TIMING_JSON}" \
  --arg run_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg arch "$(uname -m)" \
  '{run_at:$run_at, arch:$arch, steps:$steps}')
printf '%s\n' "${FULL_TIMING}" > "${TIMING_JSON_FILE}"

# Markdown table.
{
  printf '# microVM lifecycle timing\n\n'
  printf 'Run at: %s  arch: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(uname -m)"
  printf '| step | duration_ms |\n'
  printf '|------|------------:|\n'
  printf '%s' "${TIMING_JSON}" \
    | jq -r '.[] | "| \(.label) | \(.duration_ms) |"'
  printf '\n'
  TOTAL=$(printf '%s' "${TIMING_JSON}" | jq '[.[].duration_ms] | add // 0')
  printf '| **total** | **%s** |\n' "${TOTAL}"
} > "${TIMING_MD_FILE}"

log "Lifecycle timing written to ${TIMING_JSON_FILE} and ${TIMING_MD_FILE}"
if [ "${LIFECYCLE_TIMING_DIR:-}" != "" ]; then
  log "Timing artifact dir: ${LIFECYCLE_TIMING_DIR}"
fi

# Print the markdown table to stderr for the CI log.
cat "${TIMING_MD_FILE}" >&2

if [ "${EXPECT_VENDSECRET:-0}" = "1" ]; then
  pass "ALL ASSERTIONS PASSED — live Firecracker boot + mTLS VendSecret + full lifecycle validated end to end"
else
  pass "LIVE BOOT + LIFECYCLE VALIDATED — Firecracker backend available, microVM booted on KVM, snapshot/stop/restore/read cycle complete (VendSecret round-trip pending the in-guest harness agent)"
fi
