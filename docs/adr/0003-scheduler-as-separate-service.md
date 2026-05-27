# ADR 0003 — Runtime scheduler is a separate service from runtime-manager

- **Status:** Accepted
- **Date:** 2026-05-14
- **Deciders:** Lantern runtime team
- **Tags:** runtime, scheduling, architecture

## Context

The existing `services/runtime-manager` spike does two jobs:

1. **Placement** — given a workload, decide which node should run it.
2. **Lifecycle** — on the chosen node, spawn / snapshot / stop the VM.

These are different concerns at different scopes. Placement needs a cluster-wide view: free vCPU per node, warm-pool inventory across the fleet, snapshot locality, AZ spread, per-tenant quota. Lifecycle is strictly node-local: drive Firecracker, hold vsock sockets to the harness, manage the local warm pool.

In the spike they share a process because that's the shortest path to a demo. In production this becomes painful:

- The placement decision is on the hot path of every run. Co-locating it with node-local lifecycle means every node runs a copy of the placement logic, with no consistent view.
- The state needed for good placement (warm-pool inventory across the fleet) lives in N processes, not one.
- Failure isolation is wrong: a single node's manager crashing should not affect cluster-wide scheduling, and vice versa.
- We want HA for placement (etcd-leadered scheduler pair) but per-node lifecycle is intrinsically pinned to a host — different deployment topology.

## Decision

Split into two services with the contract defined in `runtime.proto`:

- **`runtime-scheduler`** — new service. Cluster-scoped. HA pair with etcd leader election. Implements `RuntimeScheduler` (placement, events stream, cluster-wide list/terminate/snapshot). Talks to every `runtime-manager` over gRPC.
- **`runtime-manager`** — existing spike, narrowed. Node-local. One process per host. Implements `RuntimeManager` (per-node Spawn/Stop/Logs/Exec/Stats). Owns the local warm pool and the per-host backend drivers (Firecracker, Kata, K8s, Wasmtime).

The control-plane talks to the scheduler. The scheduler talks to the managers. Managers never call other managers.

Cluster state lives in the scheduler:
- `nodes` table: warm-pool inventory, free capacity, last heartbeat — refreshed every 10s from each manager's `Cluster()` response.
- `vms` table: every live VM and its current `VmState`. Single writer (the scheduler).

Per-node state lives in the manager:
- Local warm pool of pre-restored Firecracker VMs.
- Open vsock streams to each guest harness.
- Snapshot cache directory.

## Consequences

### Positive

1. **One brain for placement.** The scheduler sees the whole cluster. Bin-packing, AZ spread, snapshot locality, quota — all decided once with a consistent view.
2. **Failure isolation matches reality.** A manager crash kills one node's VMs (which would be killed anyway). A scheduler crash fails over to the standby via etcd lease.
3. **The manager stays small.** It's a node agent: one process, no consensus, no global state, easy to reason about and to operate.
4. **Cleaner gRPC surface.** `RuntimeScheduler` is the only thing the control-plane needs to know. `RuntimeManager` is internal-east-west.

### Negative

1. **Extra network hop on every spawn.** control-plane → scheduler → manager. Mitigation: scheduler and managers are in the same K8s cluster; latency budget is ~5ms.
2. **Two services to deploy and version.** Mitigation: same `runtime.proto`, same release train, both written in Rust by the same team.
3. **Split-brain risk if etcd is sick.** Mitigation: scheduler refuses to make placement decisions without a valid lease. Pending requests queue rather than executing inconsistently.
4. **More state to bootstrap on scheduler startup.** Mitigation: scheduler's view of `vms` is rebuilt by querying every manager's `Cluster()` + `List()`; takes ~2s for a 100-node cluster.

## Alternatives considered

### Keep them merged; pick a "leader" manager that does scheduling
Either every manager runs placement (inconsistent views, race conditions on the warm pool) or one node is elected leader (now the manager is a distributed system pretending not to be one). Both lose.

### Use the K8s scheduler directly
The K8s scheduler is excellent for pods, but our placement signal is `(isolation_class, warm-pool inventory, snapshot locality)` — none of which K8s knows about. We'd be writing a scheduler extender that's larger than the standalone scheduler. Plus, `wasm` and `devcontainer` classes interact with K8s differently; `standard` and `untrusted` go through firecracker-containerd, which K8s sees as opaque shims.

### Use Nomad / a generic scheduler
Same problem as K8s: domain-specific placement signals (snapshot cache locality, harness-reported warm-pool state) make a custom scheduler the right answer. Embedding our logic in a generic scheduler is a heavier integration than the scheduler itself.

### Library, not service: every control-plane instance does its own scheduling
Then quota and warm-pool views are inconsistent across control-plane replicas. We had this in the spike; it produced over-commitment incidents within a week of multi-replica deploys.

## References

- [`docs/architecture/04b-microvm-productionization.md`](../architecture/04b-microvm-productionization.md) — system overview
- [`packages/proto/lantern/v1/runtime.proto`](../../packages/proto/lantern/v1/runtime.proto) — both service surfaces
- [Firecracker snapshotting](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md) — why locality matters
