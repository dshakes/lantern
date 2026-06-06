#!/usr/bin/env bash
#
# build-image.sh — build the Firecracker microVM boot artifacts for Lantern.
#
# Produces two files the runtime-manager Firecracker backend needs to cold-boot
# a microVM (see services/runtime-manager/src/backends/firecracker.rs):
#
#   1. vmlinux       — a KVM-bootable, uncompressed Linux kernel image.
#   2. rootfs.ext4   — a minimal ext4 root filesystem whose init (PID 1) is the
#                      statically-linked `lantern-harness` binary.
#
# It then exports the paths the backend reads:
#
#   FC_KERNEL_PATH=<out>/vmlinux
#   FC_ROOTFS_PATH=<out>/rootfs.ext4
#
# ---------------------------------------------------------------------------
# WHERE THIS RUNS
# ---------------------------------------------------------------------------
# This script ONLY runs on Linux with KVM (it shells out to `mkfs.ext4`,
# `losetup`/`mount`, and — for the kernel build — a Linux toolchain). It does
# NOT run on macOS; the dev host has no /dev/kvm and the Firecracker backend
# reports itself unavailable there (`firecracker_available()` returns false).
#
# It is invoked by .github/workflows/microvm-integration.yml on a KVM-capable
# runner, and can be run by hand on any Linux/KVM box for local integration.
#
# ---------------------------------------------------------------------------
# USAGE
# ---------------------------------------------------------------------------
#   ./infra/firecracker/build-image.sh [OUT_DIR]
#
#   OUT_DIR   Directory to write artifacts into. Default: ./.fc-image
#
# To consume the exported paths in the SAME shell, source the env file the
# script writes at the end:
#
#   ./infra/firecracker/build-image.sh /tmp/fc
#   source /tmp/fc/fc-env.sh        # exports FC_KERNEL_PATH / FC_ROOTFS_PATH
#
# In CI, the script appends the two paths to $GITHUB_ENV when that var is set,
# so downstream steps see them without sourcing.
#
# ---------------------------------------------------------------------------
# TUNABLES (environment variables)
# ---------------------------------------------------------------------------
#   FC_KERNEL_VERSION   Kernel series to fetch a prebuilt CI kernel for.
#                       Default: 5.10  (Firecracker's well-tested guest series).
#   FC_KERNEL_URL       Override the kernel download URL entirely. When set,
#                       FC_KERNEL_VERSION is ignored and no kernel is built.
#   FC_ROOTFS_SIZE_MB   ext4 image size in MiB. Default: 64 (harness is ~8 MiB).
#   FC_HARNESS_BIN      Path to a prebuilt static lantern-harness binary. When
#                       unset, the script builds it from services/harness via
#                       a musl target (requires the Rust musl toolchain).
#   ARCH                x86_64 (default) or aarch64. Selects the prebuilt kernel.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root + output dir.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${1:-${REPO_ROOT}/.fc-image}"
mkdir -p "${OUT_DIR}"

ARCH="${ARCH:-x86_64}"
FC_KERNEL_VERSION="${FC_KERNEL_VERSION:-5.10}"
FC_ROOTFS_SIZE_MB="${FC_ROOTFS_SIZE_MB:-64}"

KERNEL_OUT="${OUT_DIR}/vmlinux"
ROOTFS_OUT="${OUT_DIR}/rootfs.ext4"

log() { printf '\033[1;34m[build-image]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[build-image] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Hard requirement: this script is Linux-only. mkfs.ext4 / loop mounts / the
# Firecracker boot artifacts have no macOS equivalent.
[ "$(uname -s)" = "Linux" ] || die "build-image.sh is Linux-only (got $(uname -s)). \
Run it on a KVM-capable Linux host or in the microVM CI job."

# ---------------------------------------------------------------------------
# 1. KERNEL — fetch a prebuilt, KVM-bootable uncompressed vmlinux.
#
# Building a kernel from source is slow and reproducible-only with a pinned
# .config; for an integration smoke test we fetch the same CI kernel image the
# Firecracker project publishes and tests against. To build from source instead,
# replace this block with a `make vmlinux` against a checked-out linux tree using
# `resources/guest_configs/microvm-kernel-*.config` from the firecracker repo.
# ---------------------------------------------------------------------------
fetch_kernel() {
  if [ -n "${FC_KERNEL_URL:-}" ]; then
    log "Fetching kernel from FC_KERNEL_URL=${FC_KERNEL_URL}"
    curl -fsSL "${FC_KERNEL_URL}" -o "${KERNEL_OUT}"
    return
  fi

  # Firecracker publishes per-arch CI guest kernels in its S3 bucket. The exact
  # object key encodes arch + kernel series; pin a known-good one here.
  local base="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/${ARCH}"
  local key="vmlinux-${FC_KERNEL_VERSION}.bin"
  local url="${base}/${key}"

  log "Fetching prebuilt CI kernel: ${url}"
  if ! curl -fsSL "${url}" -o "${KERNEL_OUT}"; then
    die "could not fetch ${url}. Set FC_KERNEL_URL to a known-good vmlinux, \
or build one from source (see comment above)."
  fi
}

# ---------------------------------------------------------------------------
# 2. HARNESS — the static binary that is PID 1 in the guest.
#
# The harness must be statically linked (musl) so it runs in a rootfs with no
# glibc loader and no shared libraries. We reuse the same release profile the
# harness Dockerfile uses (LTO + strip via services/harness/Cargo.toml).
# ---------------------------------------------------------------------------
build_harness() {
  if [ -n "${FC_HARNESS_BIN:-}" ]; then
    [ -f "${FC_HARNESS_BIN}" ] || die "FC_HARNESS_BIN=${FC_HARNESS_BIN} does not exist"
    log "Using prebuilt harness: ${FC_HARNESS_BIN}"
    HARNESS_BIN="${FC_HARNESS_BIN}"
    return
  fi

  local target
  case "${ARCH}" in
    x86_64)  target="x86_64-unknown-linux-musl" ;;
    aarch64) target="aarch64-unknown-linux-musl" ;;
    *) die "unsupported ARCH=${ARCH}" ;;
  esac

  log "Building lantern-harness (static musl, target=${target})"
  command -v cargo >/dev/null 2>&1 || die "cargo not found; install Rust or set FC_HARNESS_BIN"
  rustup target add "${target}" 2>/dev/null || true

  ( cd "${REPO_ROOT}/services/harness" \
      && cargo build --release --bin lantern-harness --target "${target}" )

  HARNESS_BIN="${REPO_ROOT}/services/harness/target/${target}/release/lantern-harness"
  [ -f "${HARNESS_BIN}" ] || die "harness build did not produce ${HARNESS_BIN}"
  log "Harness built: ${HARNESS_BIN} ($(du -h "${HARNESS_BIN}" | cut -f1))"
}

# ---------------------------------------------------------------------------
# 3. ROOTFS — a minimal ext4 image with the harness as /sbin/init.
#
# Layout matches ADR-0004 (harness baked into the image, init=/sbin/init on
# the kernel cmdline — see build_boot_args() in the Firecracker backend, which
# does NOT pass init=, so the rootfs default init must be the harness):
#
#   /sbin/init                -> lantern-harness (PID 1)
#   /usr/local/bin/lantern-harness (canonical path the README documents)
#   /run/lantern              -> tmpfs mount point for sockets + cert drive
#   /etc/lantern/harness.toml -> defaults file (per ADR-0004)
#
# We build the image with a loop mount. This needs root (or CAP_SYS_ADMIN);
# the CI job runs the script under sudo.
# ---------------------------------------------------------------------------
build_rootfs() {
  log "Creating ${FC_ROOTFS_SIZE_MB} MiB ext4 rootfs at ${ROOTFS_OUT}"
  rm -f "${ROOTFS_OUT}"
  dd if=/dev/zero of="${ROOTFS_OUT}" bs=1M count="${FC_ROOTFS_SIZE_MB}" status=none
  mkfs.ext4 -q -F "${ROOTFS_OUT}"

  local mnt
  mnt="$(mktemp -d)"
  # Best-effort cleanup even on failure.
  trap 'sudo umount "${mnt}" 2>/dev/null || true; rmdir "${mnt}" 2>/dev/null || true' RETURN

  sudo mount -o loop "${ROOTFS_OUT}" "${mnt}"

  sudo mkdir -p \
    "${mnt}/sbin" \
    "${mnt}/usr/local/bin" \
    "${mnt}/etc/lantern" \
    "${mnt}/run/lantern" \
    "${mnt}/tmp" \
    "${mnt}/proc" \
    "${mnt}/sys" \
    "${mnt}/dev"

  # Install the harness as both the documented path and as PID 1 init.
  sudo cp "${HARNESS_BIN}" "${mnt}/usr/local/bin/lantern-harness"
  sudo cp "${HARNESS_BIN}" "${mnt}/sbin/init"
  sudo chmod 0755 "${mnt}/usr/local/bin/lantern-harness" "${mnt}/sbin/init"

  # Minimal defaults file (ADR-0004). The manager overrides these via the
  # kernel cmdline (build_boot_args) and the per-VM env contract.
  sudo tee "${mnt}/etc/lantern/harness.toml" >/dev/null <<'TOML'
# Lantern harness defaults — overridden by the kernel cmdline / env contract.
# See services/harness/README.md "Boot contract".
run_dir = "/run/lantern"
secrets_socket = "/run/lantern/secrets.sock"
otlp_socket = "/run/lantern/otlp.sock"
TOML

  # ca-certificates so the harness mTLS client can verify TLS chains if needed.
  if [ -d /etc/ssl/certs ]; then
    sudo mkdir -p "${mnt}/etc/ssl/certs"
    sudo cp -a /etc/ssl/certs/. "${mnt}/etc/ssl/certs/" 2>/dev/null || true
  fi

  sync
  log "Rootfs populated."
}

# ---------------------------------------------------------------------------
# Run the build.
# ---------------------------------------------------------------------------
fetch_kernel
build_harness
build_rootfs

[ -s "${KERNEL_OUT}" ] || die "kernel artifact missing/empty: ${KERNEL_OUT}"
[ -s "${ROOTFS_OUT}" ] || die "rootfs artifact missing/empty: ${ROOTFS_OUT}"

# ---------------------------------------------------------------------------
# Export the paths the Firecracker backend reads.
#   FC_KERNEL_PATH / FC_ROOTFS_PATH — see FirecrackerBackend::new().
# ---------------------------------------------------------------------------
export FC_KERNEL_PATH="${KERNEL_OUT}"
export FC_ROOTFS_PATH="${ROOTFS_OUT}"

# Write a sourceable env file for interactive/local use.
ENV_FILE="${OUT_DIR}/fc-env.sh"
cat >"${ENV_FILE}" <<EOF
# Generated by infra/firecracker/build-image.sh — \`source\` this file.
export FC_KERNEL_PATH="${KERNEL_OUT}"
export FC_ROOTFS_PATH="${ROOTFS_OUT}"
EOF

# In CI, surface the paths to later steps via \$GITHUB_ENV.
if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "FC_KERNEL_PATH=${KERNEL_OUT}"
    echo "FC_ROOTFS_PATH=${ROOTFS_OUT}"
  } >>"${GITHUB_ENV}"
fi

log "Done."
log "  FC_KERNEL_PATH=${KERNEL_OUT} ($(du -h "${KERNEL_OUT}" | cut -f1))"
log "  FC_ROOTFS_PATH=${ROOTFS_OUT} ($(du -h "${ROOTFS_OUT}" | cut -f1))"
log "  env file: ${ENV_FILE} (source it to load the paths)"
