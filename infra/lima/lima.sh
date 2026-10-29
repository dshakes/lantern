#!/usr/bin/env bash
#
# lima.sh — one-command real Firecracker on an Apple Silicon Mac.
#
# Backs the `make lima-*` targets. Runs on the Mac, and re-invokes itself
# inside the `firecracker-dev` Lima VM (`_in <cmd>`) for the guest-side steps —
# the repo is mounted read-only at the same path there, so every build writes
# to a cache under the VM's home instead.
#
#   up          create/start the VM, verify /dev/kvm + firecracker + jailer
#   image       build vmlinux + rootfs.ext4 (harness as PID 1), cached
#   e2e         integration-test.sh, jailed, EXPECT_VENDSECRET=1, timing table
#   broker-e2e  broker-e2e.sh (ADR 0026 broker egress mode)
#   measurement-e2e  measurement-e2e.sh (ADR 0031 software measurement, jailed)
#   down        stop the VM
#   clean       drop the VM's build caches (cargo clean + the cached image)
#
# Tunables: LIMA_VM (default firecracker-dev), LIMA_DISK_MAX_PCT (default 85),
# LIMA_PORT_WAIT_SECS (how long to wait for a busy manager port, default 1800).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VM="${LIMA_VM:-firecracker-dev}"
DISK_MAX_PCT="${LIMA_DISK_MAX_PCT:-85}"
PORT_WAIT_SECS="${LIMA_PORT_WAIT_SECS:-1800}"

log()  { printf '\033[1;34m[lima]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[lima] ERROR:\033[0m %b\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Host side (macOS).
# ---------------------------------------------------------------------------
host_preflight() {
  [ "$(uname -s)" = "Darwin" ] || die "run this on the Mac; inside a Linux/KVM host call infra/firecracker/*.sh directly"
  [ "$(uname -m)" = "arm64" ] || die "Apple Silicon required (got $(uname -m))"
  local chip macos
  chip="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
  macos="$(sw_vers -productVersion)"
  case "${chip}" in
    *M1*|*M2*) die "${chip}: no nested virtualization (needs M3+ and macOS 15+).\nUse the KVM CI job (.github/workflows/microvm-integration.yml) or a remote Linux/KVM host; RUNTIME_BACKEND=docker is the zero-setup macOS path." ;;
  esac
  [ "${macos%%.*}" -ge 15 ] || die "macOS ${macos}: nested virtualization needs macOS 15+"
  command -v limactl >/dev/null || die "limactl not found — brew install lima"
  case "${REPO_ROOT}" in
    "${HOME}"/*) ;;
    *) die "repo must live under ${HOME} (the VM mounts ~ read-only at the same path); it is at ${REPO_ROOT}" ;;
  esac
}

vm_status() { limactl list --format '{{.Status}}' "${VM}" 2>/dev/null || true; }

# limactl shell does not forward the caller's env; pass the tunables explicitly.
in_vm() {
  limactl shell --workdir "${REPO_ROOT}" "${VM}" -- env \
    LIMA_DISK_MAX_PCT="${DISK_MAX_PCT}" LIMA_PORT_WAIT_SECS="${PORT_WAIT_SECS}" \
    ${LISTEN_PORT:+LISTEN_PORT="${LISTEN_PORT}"} \
    bash "${REPO_ROOT}/infra/lima/lima.sh" _in "$@"
}

require_running() {
  [ "$(vm_status)" = "Running" ] || die "VM ${VM} is not running — make lima-up"
}

host_up() {
  host_preflight
  case "$(vm_status)" in
    Running) log "VM ${VM} already running" ;;
    "")      log "creating VM ${VM} from infra/lima/firecracker-dev.yaml (first run takes a few minutes)"
             limactl start --tty=false --name="${VM}" "${SCRIPT_DIR}/firecracker-dev.yaml" ;;
    *)       log "starting VM ${VM}"; limactl start --tty=false "${VM}" ;;
  esac
  in_vm up
}

# ---------------------------------------------------------------------------
# Guest side (Linux, inside the VM).
# ---------------------------------------------------------------------------
CACHE="${HOME}/.cache/lantern-lima"
TARGET="${CACHE}/target"   # shared cargo target dir: harness (musl) + manager
IMG="${CACHE}/image"
TIMING="${CACHE}/timing"

guest_env() {
  # shellcheck disable=SC1091
  [ -f "${HOME}/.cargo/env" ] && . "${HOME}/.cargo/env"
  ARCH="$(uname -m)"
  MUSL="${ARCH}-unknown-linux-musl"
  HARNESS_BIN="${TARGET}/${MUSL}/release/lantern-harness"
  MANAGER_BIN="${TARGET}/release/lantern-runtime-manager"
}

guest_deps() {
  local missing=()
  for c in grpcurl jq openssl protoc musl-gcc busybox; do command -v "$c" >/dev/null || missing+=("$c"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    log "installing guest build deps (missing: ${missing[*]})"
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      musl-tools e2fsprogs jq curl openssl protobuf-compiler busybox-static build-essential
    if ! command -v grpcurl >/dev/null; then
      local gv=1.9.1 ga
      case "$(uname -m)" in aarch64) ga=arm64 ;; *) ga=x86_64 ;; esac
      curl -fsSL "https://github.com/fullstorydev/grpcurl/releases/download/v${gv}/grpcurl_${gv}_linux_${ga}.tar.gz" \
        | sudo tar -xz -C /usr/local/bin grpcurl
    fi
  fi
  if ! command -v cargo >/dev/null; then
    log "installing rustup"
    curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
    # shellcheck disable=SC1091
    . "${HOME}/.cargo/env"
  fi
  rustup target list --installed | grep -qx "${MUSL}" || rustup target add "${MUSL}"
}

guest_up() {
  guest_env
  [ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm missing or not usable in ${HOSTNAME} — host needs M3+ and macOS 15+ (nested virt)"
  log "/dev/kvm: $(stat -c '%A %U:%G' /dev/kvm)"
  log "firecracker: $(firecracker --version | head -1)"
  log "jailer: $(jailer --version | head -1)"
  guest_deps
  log "disk: $(df -h --output=pcent,avail / | tail -1 | xargs) used/avail"
  log "VM ready — next: make lima-image / make lima-e2e"
}

disk_guard() {
  local pct
  pct="$(df --output=pcent / | tail -1 | tr -dc 0-9)"
  [ "${pct}" -le "${DISK_MAX_PCT}" ] || die "VM disk is ${pct}% used (limit ${DISK_MAX_PCT}%) — refusing to build.\nFree space: make lima-clean   (drops ${TARGET} + ${IMG})\nor inside the VM: sudo apt-get clean; du -sh ~/* | sort -h"
}

build_harness() {
  log "building lantern-harness (${MUSL}) -> ${TARGET}"
  cargo build --release --locked --bin lantern-harness --target "${MUSL}" \
    --manifest-path services/harness/Cargo.toml --target-dir "${TARGET}"
}

build_manager() {
  log "building lantern-runtime-manager -> ${TARGET}"
  cargo build --release --locked --manifest-path services/runtime-manager/Cargo.toml --target-dir "${TARGET}"
}

guest_image() {
  guest_env
  disk_guard
  build_harness
  mkdir -p "${IMG}"
  # Rebuild only when an input changed: the harness binary (cargo already
  # no-ops when its sources didn't) or the image script itself.
  local stamp
  stamp="$(sha256sum "${HARNESS_BIN}" infra/firecracker/build-image.sh | sha256sum | cut -c1-16)"
  if [ -s "${IMG}/vmlinux" ] && [ -s "${IMG}/rootfs.ext4" ] && [ "$(cat "${IMG}/.stamp" 2>/dev/null)" = "${stamp}" ]; then
    log "image up to date (${IMG}, stamp ${stamp})"
    return
  fi
  log "building image -> ${IMG}"
  sudo FC_HARNESS_BIN="${HARNESS_BIN}" ARCH="${ARCH}" bash infra/firecracker/build-image.sh "${IMG}"
  echo "${stamp}" >"${IMG}/.stamp"
}

# Wait until nothing listens on $1 — another run (another agent, a manual
# manager) may own the port; never kill it, just wait our turn.
wait_port_free() {
  local port="$1" waited=0
  while ss -Hltn "sport = :${port}" | grep -q .; do
    [ "${waited}" -lt "${PORT_WAIT_SECS}" ] || die ":${port} still busy after ${PORT_WAIT_SECS}s — another manager is running in the VM (ss -ltnp | grep ${port})"
    [ "${waited}" -eq 0 ] && log ":${port} in use by another run — waiting (up to ${PORT_WAIT_SECS}s)"
    sleep 15; waited=$((waited + 15))
  done
}

# What a run must not leave behind: firecracker processes, snapshot dirs, jails.
leak_snapshot() {
  { pgrep -x firecracker || true
    sudo find /var/lib/lantern/snapshots -mindepth 3 -maxdepth 3 -type d 2>/dev/null || true
    sudo find /srv/jailer -mindepth 2 -maxdepth 2 -type d 2>/dev/null || true
  } | sort
}

leak_check() {
  local new
  new="$(comm -13 <(printf '%s\n' "$1") <(leak_snapshot))"
  [ -z "${new}" ] || die "run leaked (or a concurrent run created) these — firecracker pids / snapshot dirs / jails:\n${new}"
  log "no leaked firecracker processes, snapshot dirs or jails"
}

guest_e2e() {
  guest_image
  build_manager
  sudo mkdir -p /srv/jailer /var/lib/lantern/snapshots "${TIMING}"
  wait_port_free 50054
  local before rc=0
  before="$(leak_snapshot)"
  sudo FC_KERNEL_PATH="${IMG}/vmlinux" FC_ROOTFS_PATH="${IMG}/rootfs.ext4" \
    RUNTIME_BACKEND=firecracker LANTERN_RUNTIME_BACKEND=firecracker \
    MANAGER_BIN="${MANAGER_BIN}" EXPECT_VENDSECRET=1 \
    FIRECRACKER_JAILER_PATH="$(command -v jailer)" FIRECRACKER_JAILER_UID=123 \
    FIRECRACKER_JAILER_GID=100 FIRECRACKER_CHROOT_BASE=/srv/jailer \
    LIFECYCLE_TIMING_DIR="${TIMING}" \
    bash infra/firecracker/integration-test.sh || rc=$?
  leak_check "${before}"
  [ "${rc}" -eq 0 ] || die "integration-test.sh failed (exit ${rc})"
  log "timing table (above) saved to ${TIMING}/lifecycle-timing.md"
}

guest_broker_e2e() {
  guest_image
  build_manager
  local port="${LISTEN_PORT:-51054}" before rc=0
  wait_port_free "${port}"
  before="$(leak_snapshot)"
  sudo FC_KERNEL_PATH="${IMG}/vmlinux" FC_ROOTFS_PATH="${IMG}/rootfs.ext4" \
    MANAGER_BIN="${MANAGER_BIN}" LISTEN_PORT="${port}" \
    bash infra/firecracker/broker-e2e.sh || rc=$?
  leak_check "${before}"
  [ "${rc}" -eq 0 ] || die "broker-e2e.sh failed (exit ${rc})"
}

guest_measurement_e2e() {
  guest_image
  build_manager
  sudo mkdir -p /srv/jailer /var/lib/lantern/snapshots
  local port="${LISTEN_PORT:-51055}" before rc=0
  wait_port_free "${port}"
  wait_port_free "$((port + 1))"
  before="$(leak_snapshot)"
  sudo FC_KERNEL_PATH="${IMG}/vmlinux" FC_ROOTFS_PATH="${IMG}/rootfs.ext4" \
    MANAGER_BIN="${MANAGER_BIN}" LISTEN_PORT="${port}" \
    FIRECRACKER_JAILER_PATH="$(command -v jailer)" FIRECRACKER_JAILER_UID=123 \
    FIRECRACKER_JAILER_GID=100 FIRECRACKER_CHROOT_BASE=/srv/jailer \
    bash infra/firecracker/measurement-e2e.sh || rc=$?
  leak_check "${before}"
  [ "${rc}" -eq 0 ] || die "measurement-e2e.sh failed (exit ${rc})"
}

guest_clean() {
  guest_env
  if [ -d "${TARGET}" ]; then
    cargo clean --manifest-path services/harness/Cargo.toml --target-dir "${TARGET}"
  fi
  sudo rm -f "${IMG}/vmlinux" "${IMG}/rootfs.ext4" "${IMG}/fc-env.sh" "${IMG}/.stamp"
  log "caches cleared; disk: $(df -h --output=pcent,avail / | tail -1 | xargs) used/avail"
}

# ---------------------------------------------------------------------------
# Dispatch.
# ---------------------------------------------------------------------------
cmd="${1:-}"
if [ "${cmd}" = "_in" ]; then
  case "${2:-}" in
    up)         guest_up ;;
    image)      guest_image ;;
    e2e)        guest_e2e ;;
    broker-e2e) guest_broker_e2e ;;
    measurement-e2e) guest_measurement_e2e ;;
    clean)      guest_clean ;;
    *)          die "unknown guest command: ${2:-}" ;;
  esac
  exit 0
fi

case "${cmd}" in
  up)                     host_up ;;
  image|e2e|broker-e2e|measurement-e2e|clean) host_preflight; require_running; in_vm "${cmd}" ;;
  down)                   command -v limactl >/dev/null || die "limactl not found"; limactl stop "${VM}" ;;
  *) die "usage: $0 up|image|e2e|broker-e2e|measurement-e2e|down|clean" ;;
esac
