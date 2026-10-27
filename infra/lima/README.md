# Firecracker on a Mac (Lima + nested virtualization)

Firecracker needs Linux KVM; macOS doesn't have it. On **Apple Silicon M3 or
newer with macOS 15+**, Virtualization.framework supports nested
virtualization — KVM works *inside* a Lima Linux guest, so Firecracker (and
the Kata runtime) run natively there while you develop on the Mac.

Verified on an M4 Max: a Firecracker microVM boots Ubuntu 22.04 to login in
**~1.6 s** inside the guest.

## Quick start (one command per step)

```bash
brew install lima
make lima-up           # create/start "firecracker-dev"; verify /dev/kvm, firecracker, jailer; install guest build deps
make lima-e2e          # build harness + manager + image in the VM, run the jailed lifecycle e2e, print the timing table
make lima-broker-e2e   # broker egress mode (ADR 0026): no NIC, vsock-only, credential injection
```

| Target | What it does |
| ------ | ------------ |
| `make lima-up` | Creates the VM from `firecracker-dev.yaml` if absent, starts it if stopped (idempotent when running). Fails fast with a clear message on M1/M2 or macOS < 15 (no nested virt). |
| `make lima-image` | Builds `vmlinux` + `rootfs.ext4` with the current harness (musl, all tools incl. `write_file`) as PID 1. Cached at `~/.cache/lantern-lima/image` in the VM; rebuilt only when the harness binary or `build-image.sh` changes. |
| `make lima-e2e` | `lima-image`, then builds the runtime-manager and runs `infra/firecracker/integration-test.sh` jailed (`FIRECRACKER_JAILER_*`, `EXPECT_VENDSECRET=1`). Timing table saved to `~/.cache/lantern-lima/timing/lifecycle-timing.md`. |
| `make lima-broker-e2e` | Same build, then `infra/firecracker/broker-e2e.sh` (needs outbound HTTPS to httpbin.org). |
| `make lima-down` | `limactl stop firecracker-dev`. |
| `make lima-clean` | `cargo clean --target-dir ~/.cache/lantern-lima/target` and removes the cached image files. |

Both e2e targets fail if the run leaves a firecracker process, snapshot
directory or jail behind. They wait (up to `LIMA_PORT_WAIT_SECS`, default
1800) when the manager port (`:50054`, broker `:51054`) is already in use by
another run in the VM, rather than killing it. Builds refuse to start when the
VM disk is over `LIMA_DISK_MAX_PCT` (default 85%); `make lima-clean` frees the
caches. The repo is mounted read-only in the guest, so all build output goes to
`~/.cache/lantern-lima` there, not into the repo.

If `make lima-up` reports no `/dev/kvm`, use the KVM CI workflow
(`.github/workflows/microvm-integration.yml`) or a remote Linux host instead;
the Docker backend (`RUNTIME_BACKEND=docker`) remains the zero-setup macOS dev
path.

The manual steps below are what the targets automate; keep them for debugging.

### Manual VM setup

```bash
limactl start infra/lima/firecracker-dev.yaml   # creates "firecracker-dev"
limactl shell firecracker-dev                   # /dev/kvm exists in here
```

The provision scripts install the pinned Firecracker release and open
`/dev/kvm`.

## Smoke-boot a microVM

Inside the guest, using the official Firecracker CI artifacts (v1.15.1 kernel series):

```bash
mkdir -p ~/fc-demo && cd ~/fc-demo
curl -sO http://spec.ccfc.min.s3.amazonaws.com/firecracker-ci/v1.15/aarch64/vmlinux-5.10.245
curl -sO http://spec.ccfc.min.s3.amazonaws.com/firecracker-ci/v1.15/aarch64/ubuntu-22.04.ext4
cat > vm.json <<'EOF'
{
  "boot-source": {"kernel_image_path": "vmlinux-5.10.245", "boot_args": "keep_bootcon console=ttyS0 reboot=k panic=1 pci=off"},
  "drives": [{"drive_id": "rootfs", "path_on_host": "ubuntu-22.04.ext4", "is_root_device": true, "is_read_only": false}],
  "machine-config": {"vcpu_count": 2, "mem_size_mib": 512}
}
EOF
firecracker --no-api --config-file vm.json   # boots to a root login on ttyS0
```

## Running the lifecycle e2e test by hand

The full integration test (boot + snapshot/stop/restore + fork×3 + timing) runs
inside the Lima guest where `/dev/kvm` is available.  The repo is mounted
read-only at the same host path inside the guest.

```bash
# Inside the guest (limactl shell firecracker-dev):
cd /path/to/repo

# Install build deps (first time only).
sudo apt-get install -y musl-tools e2fsprogs jq curl protobuf-compiler
rustup target add aarch64-unknown-linux-musl

# Build the harness (musl, static).
cargo build --release --target aarch64-unknown-linux-musl \
  --manifest-path services/harness/Cargo.toml
HARNESS_BIN="$PWD/services/harness/target/aarch64-unknown-linux-musl/release/lantern-harness"

# Build the kernel + rootfs (needs sudo for loop-mount; pass harness via env
# so sudo does not need cargo on its PATH).
sudo FC_HARNESS_BIN="$HARNESS_BIN" \
  bash infra/firecracker/build-image.sh /tmp/fc-image

# Build the runtime-manager.
cargo build --release --manifest-path services/runtime-manager/Cargo.toml
MANAGER_BIN="$PWD/services/runtime-manager/target/release/lantern-runtime-manager"

# Run the test.  Needs root for TAP + firecracker + loop devices.
sudo \
  FC_KERNEL_PATH=/tmp/fc-image/vmlinux \
  FC_ROOTFS_PATH=/tmp/fc-image/rootfs.ext4 \
  RUNTIME_BACKEND=firecracker \
  LANTERN_RUNTIME_BACKEND=firecracker \
  MANAGER_BIN="$MANAGER_BIN" \
  EXPECT_VENDSECRET=1 \
  LIFECYCLE_TIMING_DIR=/tmp/fc-timing \
  bash infra/firecracker/integration-test.sh

# Timing summary (markdown table printed to stderr during the run too).
cat /tmp/fc-timing/lifecycle-timing.md
```

The fork test also needs the jailer binary installed (the provision script
installs it automatically from the v1.15.1 tarball alongside `firecracker`).
If it is absent the test skips with `[SKIP]` — set `FIRECRACKER_JAILER_PATH`
to the jailer binary path to override.

## Running the Lantern runtime stack against it

The repo is mounted read-only at the same path inside the guest. To exercise
`RUNTIME_BACKEND=firecracker` end-to-end, build and run runtime-manager
*inside* the guest (it needs `/dev/kvm`), and point the scheduler on the host
at it via `LANTERN_NODE_ADDR_<NODE>` / `LANTERN_DEFAULT_MANAGER_ADDR` and the
Lima port forward. The `cargo test` suites for runtime-manager and harness
also run on the KVM CI runner on every push (`microvm-integration.yml`).

## Why not QEMU's `microvm` machine type?

It mimics Firecracker's machine model but **not its REST API** — the
runtime-manager's Firecracker backend drives the real Firecracker API socket,
so QEMU microvm would be a new backend, not a drop-in. Nested-virt Lima runs
the real thing.

## Cleanup

```bash
limactl stop firecracker-dev && limactl delete firecracker-dev
```
