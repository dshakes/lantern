# ADR 0004 — The runtime harness is baked into the VM base image

- **Status:** Accepted
- **Date:** 2026-05-18
- **Deciders:** Lantern runtime team
- **Tags:** runtime, harness, security, boot

## Context

Every Lantern microVM runs an in-guest init process — the **harness**. It is PID 1 in the guest, supervises the worker, terminates the `Heartbeat` / `VendSecret` / `Report` streams to the manager (see `RuntimeHarness` in `runtime.proto`), and enforces the egress allowlist from inside the guest.

There are two ways to deliver this binary into the guest:

1. **Bake it into the base image** alongside the kernel and rootfs. Every agent image `FROM lantern/runtime-base:vX.Y` already contains `/sbin/lantern-harness`.
2. **Inject it at boot** via virtio-fs / 9p / a kernel cmdline-mounted initramfs that the manager prepares per-VM.

Inject-at-boot is appealing for fast iteration: the manager can upgrade the harness without rebuilding every base image. But it bloats the trusted boot surface and complicates snapshotting.

## Decision

The harness is **baked into the VM base image**. Specifically:

- Lantern publishes a small number of base images (`lantern/runtime-base:python-3.11`, `:node-20`, `:go-1.23`, `:minimal`).
- Each base image ships with `/sbin/lantern-harness` (a statically-linked musl binary), a `/etc/lantern/harness.toml` defaults file, and a `init=/sbin/lantern-harness` kernel cmdline.
- Agent images `FROM` a base image. The agent's bundle adds the worker binary and dependencies. The harness is unchanged.
- The harness version is pinned per base-image version. A harness upgrade is a base-image rev.

Snapshots are taken *after* the harness has booted and is waiting on its first heartbeat ack. Restore therefore comes up with a working harness already in place.

## Consequences

### Positive

1. **Snapshots are self-contained.** A snapshot mmap'd onto a new node has the harness already mapped into memory. No per-node injection step on restore — restore time stays at ≤ 30ms warm / ≤ 200ms cold.
2. **Smaller trusted boot surface.** No virtio-fs share, no manager-prepared initramfs. The boot path is `kernel → init=/sbin/lantern-harness`, nothing else.
3. **Auditability.** The harness binary is signed when the base image is built and the digest is in the image manifest. We can prove which harness ran a given workload from `agent_versions.bundle_digest`.
4. **Simpler manager.** No per-VM filesystem prep step on spawn. The Firecracker driver is just "boot this image with these resources."
5. **Egress allowlist works at boot.** The nftables rules are applied by the harness *before* the worker exec, so there is no window where the worker can talk to the internet unfiltered.

### Negative

1. **Harness upgrades require a base-image rebuild and rollout.** Mitigation: base images version independently of agent code; CI rebuilds and re-publishes all base images on harness change. Auto-PR opens against the marketplace agents that pin a stale base image.
2. **A bug in the harness is "frozen into the snapshot."** Mitigation: the scheduler invalidates snapshots whose base-image digest is on a denylist (used for security fixes). Cold boot until the agent rev's base image catches up.
3. **Larger base images.** The harness is ~8 MB statically linked. Mitigation: trivial against the rest of the image.

## Alternatives considered

### Inject the harness at boot via virtio-fs
The manager exports a directory containing the current harness binary; the kernel cmdline mounts it and execs. Lets us upgrade the harness independently of base images.

Rejected because:
- Snapshots become non-portable: a snapshot taken with harness vX.Y can be restored only on a node that exports vX.Y. Snapshot locality becomes harness-version locality.
- The virtio-fs share is a guest↔host channel we'd otherwise not need. Expanding the trusted boot surface for a small operational win.
- Boot path has more failure modes (share not mounted, version mismatch, kernel cmdline misformed).

### No in-VM harness at all
Let the worker speak directly to the manager over vsock. Rejected because:
- Egress filtering has to happen *inside* the guest (host firewall is defense-in-depth; primary enforcement is in-guest per [ADR 0006](0006-egress-allowlist-at-harness.md)). Something has to apply nftables before the worker runs.
- Secret vending needs a process that survives worker restarts — that's the harness.
- The worker is user code; we can't trust it to send accurate heartbeats or to forward OTel correctly.

### Initramfs injection
Manager builds a custom initramfs per VM containing the harness, kernel cmdline points at it. Same downside as virtio-fs (snapshots become non-portable, more host↔guest plumbing) with extra build complexity.

## References

- [`docs/architecture/04b-microvm-productionization.md`](../architecture/04b-microvm-productionization.md) — where the harness fits
- [`packages/proto/lantern/v1/runtime.proto`](../../packages/proto/lantern/v1/runtime.proto) — `RuntimeHarness` service
- [Firecracker snapshotting](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md) — why portable snapshots matter
