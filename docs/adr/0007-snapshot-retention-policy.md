# ADR 0007 — Snapshot retention: keep the last 3 per agent for 7 days

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Lantern runtime, storage
- **Tags:** runtime, snapshots, storage, retention

## Context

Lantern relies on Firecracker memory snapshots for two distinct purposes:

1. **Cold-start acceleration.** A snapshot taken after the agent's `init()` hook runs lets subsequent runs of the same `agent_version_id` restore in ~200ms via `MAP_PRIVATE` mmap (see [`04-runtime-isolation.md`](../architecture/04-runtime-isolation.md#snapshot-restore-for-fast-cold-starts)).
2. **HA + forensics.** Periodic snapshots of long-running VMs let us restore an idempotent workload on another node after a host failure (see [`04b-microvm-productionization.md`](../architecture/04b-microvm-productionization.md#node-death)) and let security review a frozen state after an incident.

These two uses pull retention in opposite directions:

- Cold-start acceleration wants exactly the *latest* snapshot per `(class, image_digest)` — anything else is dead storage.
- HA wants a *recent* snapshot per live VM — minutes old.
- Forensics wants snapshots to *outlive* the VM that produced them, ideally for days, possibly under legal hold.

Snapshots are large (typical Python agent: 200–800 MiB compressed). At ten thousand agent versions and a few snapshots each, retention math matters.

## Decision

Two-tier retention policy:

### Tier 1 — cold-start snapshots (per `agent_version_id`)
- **Keep:** the latest snapshot per `(agent_version_id, isolation_class)`. Exactly one.
- **Invalidate:** when the agent version changes (different digest → new cache key) or when the base-image denylist marks the old base image unsafe ([ADR 0004](0004-harness-baked-into-vm-image.md)).
- **Lifetime:** while the agent version exists. Evicted from S3 30 days after the version is deleted.

### Tier 2 — runtime snapshots (per live VM, for HA + forensics)
- **Keep:** the last **3** snapshots per `vm_id` (rolling window).
- **Retention:** **7 days** after the VM terminates.
- **Storage:** `s3://lantern-snapshots-prod/runtimes/firecracker/<tenant_id>/<vm_id>/<snapshot_id>.fcs`.
- **Lifecycle:** S3 lifecycle rule deletes objects 7 days after `last-modified` on the prefix. Tagged `LegalHold=false` by default; security flips the tag on incidents and the lifecycle skips them.
- **Indexing:** scheduler stores the snapshot metadata (sha256, bytes, taken_at, vm_id, run_id) in Postgres for queryability.

Snapshots taken on `Schedule.Snapshot` calls with `keep_running=false` are tier-2 (terminal-state forensic snapshot). Snapshots taken during `init()` flow are tier-1.

## Consequences

### Positive

1. **Bounded storage growth.** Tier 1 is O(agent_versions); tier 2 is O(live VMs × 3) with a 7-day decay. Capacity planning is tractable.
2. **HA recovery works.** Node death → scheduler picks the most recent of the 3 tier-2 snapshots ≤ 60s old and restores elsewhere ([`04b-microvm-productionization.md`](../architecture/04b-microvm-productionization.md#node-death)).
3. **Forensics window is generous enough for incident response.** 7 days covers weekend incidents that get triaged Monday. Legal hold extends indefinitely.
4. **Cold-start hit rate stays high.** One snapshot per `(version, class)` is exactly what the warm-pool lookup needs.

### Negative

1. **Storage cost.** A worst-case tenant with 1000 active VMs × 3 snapshots × 500 MiB ≈ 1.5 TiB per tenant. Mitigation: snapshots compressed with zstd-3; pricing model includes a per-tenant snapshot quota.
2. **A 7-day-old failure leaves no snapshot for replay.** Acceptable — we explicitly trade unbounded forensics for predictable cost. Legal hold is the escape hatch.
3. **Tier-1 invalidation on base-image denylist is cache-cold.** First post-fix run pays cold-boot cost (~1.5s vs ~200ms). Acceptable.
4. **3 is somewhat arbitrary.** Telemetry will tell us if 2 or 5 is better; this is the operational knob most likely to move.

## Alternatives considered

### Discard tier-2 snapshots immediately on VM termination
Saves storage. Loses HA-via-snapshot-restore-after-host-death and loses forensics entirely. We need both. Hard pass.

### Keep all snapshots forever
Bounded by S3 lifecycle = infinite. Cost scales linearly with cluster age. Forensic value plateaus quickly past ~30 days; legal hold covers the rare longer case.

### Keep last 1 (not 3) per VM
3 protects against the case where the most recent snapshot is itself corrupt — we fall back to the next-most-recent. With 1, snapshot corruption = no HA.

### Retain forever for hostile-class VMs only
Tempting; hostile-class workloads are the ones forensics actually cares about. The platform default still needs to support cross-class incidents, and the storage math at 7 days is fine. Hostile-class can opt into longer retention via per-tenant override.

### Tie retention to `agent_versions.created_at`
Then a frequently-updated agent loses HA snapshots fast. Retention should be VM-relative, not version-relative.

## References

- [`docs/architecture/04-runtime-isolation.md`](../architecture/04-runtime-isolation.md) — snapshot mechanics
- [`docs/architecture/04b-microvm-productionization.md`](../architecture/04b-microvm-productionization.md) — node-death recovery flow
- [`packages/proto/lantern/v1/runtime.proto`](../../packages/proto/lantern/v1/runtime.proto) — `Snapshot`, `restore_snapshot_id`
- [Firecracker snapshotting](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
