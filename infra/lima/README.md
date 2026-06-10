# Firecracker on a Mac (Lima + nested virtualization)

Firecracker needs Linux KVM; macOS doesn't have it. On **Apple Silicon M3 or
newer with macOS 15+**, Virtualization.framework supports nested
virtualization — KVM works *inside* a Lima Linux guest, so Firecracker (and
the Kata runtime) run natively there while you develop on the Mac.

Verified on an M4 Max: a Firecracker microVM boots Ubuntu 22.04 to login in
**~1.6 s** inside the guest.

## Quick start

```bash
brew install lima
limactl start infra/lima/firecracker-dev.yaml   # creates "firecracker-dev"
limactl shell firecracker-dev                   # /dev/kvm exists in here
```

The provision scripts install the pinned Firecracker release and open
`/dev/kvm`. If the VM fails the `/dev/kvm` check, your Mac is M1/M2 or
pre-macOS-15 — use the KVM CI workflow (`.github/workflows/microvm-integration.yml`)
or a remote Linux host instead; the Docker backend (`RUNTIME_BACKEND=docker`)
remains the zero-setup macOS dev path.

## Smoke-boot a microVM

Inside the guest, using the official Firecracker CI artifacts:

```bash
mkdir -p ~/fc-demo && cd ~/fc-demo
curl -sO http://spec.ccfc.min.s3.amazonaws.com/firecracker-ci/v1.10/aarch64/vmlinux-6.1.102
curl -sO http://spec.ccfc.min.s3.amazonaws.com/firecracker-ci/v1.10/aarch64/ubuntu-22.04.ext4
cat > vm.json <<'EOF'
{
  "boot-source": {"kernel_image_path": "vmlinux-6.1.102", "boot_args": "keep_bootcon console=ttyS0 reboot=k panic=1 pci=off"},
  "drives": [{"drive_id": "rootfs", "path_on_host": "ubuntu-22.04.ext4", "is_root_device": true, "is_read_only": false}],
  "machine-config": {"vcpu_count": 2, "mem_size_mib": 512}
}
EOF
firecracker --no-api --config-file vm.json   # boots to a root login on ttyS0
```

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
