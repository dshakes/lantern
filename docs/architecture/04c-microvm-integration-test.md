# MicroVM Integration Test — Live Firecracker Boot Validation

> **What this is:** how we validate that a real Firecracker microVM actually
> boots, runs the harness, and honors the harness↔manager contract — the part
> the macOS dev host **cannot** exercise because it has no `/dev/kvm`.
>
> **Companion to:** [`04b-microvm-productionization.md`](04b-microvm-productionization.md)
> (the wiring) and [`11-testing.md`](11-testing.md) (the test strategy). This
> doc is specifically the *live boot* integration layer.
>
> **Audience:** anyone touching `services/runtime-manager`, `services/harness`,
> the runtime proto, or `infra/firecracker/`.

---

## Why a separate live-boot test

`services/runtime-manager/src/backends/firecracker.rs` is deliberately split so
that **everything that does not need KVM is unit-tested on any host** (config
derivation, boot-args, the lifecycle state machine, the vsock frame parser, the
process table). Those unit tests run in `cargo test` on macOS in CI today.

What they *cannot* prove is the part that only exists on a Linux + KVM host:

- the kernel + rootfs actually boot under Firecracker,
- the in-guest harness comes up as PID 1 and connects back to the manager,
- the harness presents a per-VM client cert (CN == `vm_id`, signed by the
  manager CA) and successfully calls `VendSecret` over **mTLS** (this is also
  our proof the harness is live — see the heartbeat caveat below),
- teardown reclaims the VM, TAP, and sockets.

This is the gap the live integration test fills. It runs **in CI on a
KVM-capable runner**, never on the dev host.

> This doc describes the test; it does not assert the test passes. The result
> is whatever CI reports on a KVM runner.

---

## The pieces

```
  infra/firecracker/build-image.sh
        │  fetches a KVM-bootable vmlinux + builds rootfs.ext4
        │  (rootfs init = static lantern-harness, per ADR-0004)
        │  exports FC_KERNEL_PATH / FC_ROOTFS_PATH
        ▼
  runtime-manager (RUNTIME_BACKEND=firecracker)
        │  FirecrackerBackend::new() -> available iff Linux + fc binary + /dev/kvm
        │  Spawn -> boot_vm(): provision per-VM cert, TAP, fc process, FC API, InstanceStart
        ▼
  guest microVM
        │  harness PID 1 -> Heartbeat stream + VendSecret over mTLS
        ▼
  infra/firecracker/integration-test.sh
           asserts (against the manager's JSON log):
             1. "Firecracker backend: available"
             2. "Firecracker: microVM started"
             3+4. "VendSecret: issued (value NOT logged)"  + value never leaked
                  (a successful mTLS vend proves the harness is live)
           then Stop -> teardown
```

> **Heartbeat caveat.** The manager-side `Heartbeat` handler is currently a stub
> that accepts the harness stream but logs nothing
> (`services/runtime-manager/src/service.rs` — "the manager side is a future
> workstream"), so there is no manager-side heartbeat log to assert against yet.
> A successful `VendSecret` is the proof of liveness: it can only succeed after
> the harness booted as PID 1 and established the same mTLS connection lifecycle
> the Heartbeat stream uses. When the manager-side heartbeat handler starts
> logging, add an explicit heartbeat assertion to the test.

### 1. `infra/firecracker/build-image.sh`

Builds the two boot artifacts the backend reads (`FC_KERNEL_PATH`,
`FC_ROOTFS_PATH`):

- **`vmlinux`** — a KVM-bootable uncompressed kernel. By default it fetches the
  Firecracker project's published CI guest kernel (pin via `FC_KERNEL_VERSION`
  or override with `FC_KERNEL_URL`). The script documents how to swap in a
  from-source build with a pinned `.config` instead.
- **`rootfs.ext4`** — a minimal ext4 image whose `/sbin/init` is the
  statically-linked `lantern-harness` (built with the musl target, matching the
  harness Dockerfile release profile). This follows
  [ADR-0004](../adr/0004-harness-baked-into-vm-image.md): the harness is baked
  into the image, not injected at boot.

Linux-only — it uses `mkfs.ext4` and a loop mount (needs root / `CAP_SYS_ADMIN`).

### 2. `infra/firecracker/integration-test.sh`

The assertions. It:

1. **Gates on `/dev/kvm`** — exits `0` with a `SKIP` line when nested virt is
   absent, so it is safe to invoke anywhere.
2. Mints a manager **mTLS CA + server cert** and points the manager at them via
   the env contract in `services/runtime-manager/src/tls.rs`
   (`LANTERN_MANAGER_TLS_CA/CERT/KEY` for the server; `LANTERN_VM_SIGNING_CA_CERT/KEY`
   for the CA that signs per-VM client certs). With the signing CA configured,
   `boot_vm` issues a leaf cert with CN == `vm_id` for the harness to present.
3. Boots `runtime-manager` with `RUNTIME_BACKEND=firecracker` + the `FC_*` paths
   + an env-resolvable test secret (`EnvSecretResolver` reads
   `LANTERN_SECRET_<encoded-uri>`).
4. **Spawns** a hello microVM whose `AgentSpec` declares the test secret (so the
   VendSecret allowlist passes inside the guest).
5. Polls the manager's structured JSON log for the success signals above.
6. Asserts the secret **value never appears** in the log (invariant #10).
7. **Stops** the VM.

Assertions are made against log lines rather than re-implementing the gRPC
client surface, keeping the test resilient to internal type renames while still
proving the live behavior.

### 3. `.github/workflows/microvm-integration.yml`

A GitHub Actions job that probes for KVM, and only when present: installs the
toolchain (musl Rust target, the Firecracker release binary, `grpcurl`), builds
the image, and runs the integration test under `sudo` with
`LANTERN_RUNTIME_BACKEND=firecracker` + the `FC_*` paths. Triggered on PRs that
touch the runtime backend / harness / this infra, on `workflow_dispatch`, and on
a weekly cron.

---

## Runner requirement: KVM / nested virtualization

Firecracker needs `/dev/kvm`. GitHub's hosted `ubuntu-latest` runners do **not**
expose nested virt, so the workflow **self-skips (green, not red)** there. To run
the live boot for real, register a KVM-capable **self-hosted runner** and set the
repo/org variable `MICROVM_RUNNER_LABEL` to its label (e.g. `kvm`). Candidates:

- bare-metal / nested-virt-enabled self-hosted host,
- GCP instance with nested virtualization enabled,
- AWS `*.metal` instance,
- Azure `Dv5`/`Ev5` with nested virtualization.

The default value (`ubuntu-latest`) keeps the workflow valid and self-skipping
out of the box.

---

## Running it locally on a Linux/KVM host

On any Linux box with KVM (check: `ls -l /dev/kvm`):

```bash
# 1. Tools: firecracker on PATH, plus grpcurl, openssl, jq, mkfs.ext4.
#    (Apt: e2fsprogs jq; firecracker + grpcurl from their GitHub releases.)

# 2. Build the boot image. Needs root for the loop mount; the script appends
#    FC_KERNEL_PATH / FC_ROOTFS_PATH to its env file.
sudo bash infra/firecracker/build-image.sh /tmp/fc-image
source /tmp/fc-image/fc-env.sh        # loads FC_KERNEL_PATH / FC_ROOTFS_PATH

# 3. Run the live boot validation (builds + runs runtime-manager, boots a VM,
#    asserts boot + heartbeat + mTLS secret vend, tears down).
sudo --preserve-env=FC_KERNEL_PATH,FC_ROOTFS_PATH \
  bash infra/firecracker/integration-test.sh
```

On a host without `/dev/kvm` the test prints `SKIP` and exits `0` — same
behavior as the CI gate.

---

## References

- [`04b-microvm-productionization.md`](04b-microvm-productionization.md) — the wiring
- [`ADR-0004`](../adr/0004-harness-baked-into-vm-image.md) — harness baked into the image
- [`ADR-0005`](../adr/0005-secret-vending-via-short-jwt.md) — secret vending contract
- `services/runtime-manager/src/backends/firecracker.rs` — the backend under test
- `services/runtime-manager/src/tls.rs` — the mTLS env contract
- `services/harness/README.md` — the in-guest boot contract
