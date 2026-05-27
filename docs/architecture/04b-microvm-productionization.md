# MicroVM Productionization — From Spike to Production Data Plane

> **What this is:** the system-level overview of how a `Run` request becomes a running microVM, how the in-VM harness talks back, and how the three services defined in `packages/proto/lantern/v1/runtime.proto` collaborate.
>
> **Companion to:** [`04-runtime-isolation.md`](04-runtime-isolation.md) — which classes exist and *why*. This doc is the *how*: the wiring between control-plane, scheduler, runtime-manager, and the in-VM harness.
>
> **Audience:** anyone touching `services/runtime-manager`, `services/runtime-scheduler` (new), the proto, or the harness binary.

---

## The pieces

```
                       ┌───────────────────────────────────────┐
   caller (SDK, CLI,   │                                       │
   workflow-engine)    │            control-plane              │
                ───────►   • JWT auth, RBAC, quota gate        │
                       │   • tenant_id stamping on AgentSpec   │
                       │   • turns Run → ScheduleRequest       │
                       └─────────────────────┬─────────────────┘
                                             │ gRPC (RuntimeScheduler.Schedule)
                                             ▼
                       ┌───────────────────────────────────────┐
                       │           runtime-scheduler           │
                       │   • per-class placement (Firecracker  │
                       │     pool / Kata pool / K8s / wasm)    │
                       │   • bin-packing, AZ spread, snapshot  │
                       │     locality, warm-pool hits          │
                       │   • emits StatusEvent stream          │
                       └────┬──────────────────────────────────┘
                            │ gRPC (RuntimeManager.Spawn)
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
       ┌────────┐      ┌────────┐      ┌────────┐
       │ node-1 │      │ node-2 │  …   │ node-N │
       │  rt-   │      │  rt-   │      │  rt-   │
       │ manager│      │ manager│      │ manager│
       └───┬────┘      └────────┘      └────────┘
           │ spawns / restores
           ▼
   ┌──────────────────────────────────────────┐
   │     Firecracker microVM (untrusted)      │
   │   ┌──────────────────────────────────┐   │
   │   │  harness  (PID 1, baked in)      │◄──┼── vsock
   │   │   • Heartbeat / VendSecret /     │   │
   │   │     Report stream → manager      │   │
   │   │   • egress allowlist enforcer    │   │
   │   │   • supervises worker            │   │
   │   └──────────────┬───────────────────┘   │
   │                  │ exec                    │
   │                  ▼                         │
   │   ┌──────────────────────────────────┐   │
   │   │  worker (user agent code)        │   │
   │   └──────────────────────────────────┘   │
   └──────────────────────────────────────────┘
```

Three services, one proto:

| Service | Scope | Language | Lives in |
|---|---|---|---|
| `RuntimeScheduler` | cluster-wide; one logical instance (HA pair) | Rust | `services/runtime-scheduler/` (new) |
| `RuntimeManager` | node-local; one per host | Rust | `services/runtime-manager/` (existing spike) |
| `RuntimeHarness` | inside the guest; one per VM | Rust (static musl) | `services/runtime-harness/` (new) |

Each maps directly to a service block in `runtime.proto`. The split is the subject of [ADR 0003](../adr/0003-scheduler-as-separate-service.md).

---

## Data flow — happy path

1. **Caller → control-plane.** Workflow engine or SDK POSTs `/v1/runs`. The control-plane resolves the agent version, looks up its `AgentSpec` template (image digest, isolation class, limits, egress rules, secret refs), and **stamps `tenant_id` from the JWT** into the spec — see comment in `runtime.proto:106`. RBAC + per-tenant quota are checked here, *before* the scheduler ever sees the request.
2. **control-plane → scheduler.** `RuntimeScheduler.Schedule(spec, hint, cold_start_budget)`. Returns a `VmHandle` once a node is picked. The schedule decision uses:
   - The `IsolationClass` to pick a backend (`standard`/`untrusted` → Firecracker pool; `hostile` → Kata node-pool; `trusted` → K8s; `wasm` → in-process on a trusted host).
   - Warm-pool inventory per `(class, image_digest)` reported by each manager in its `Cluster()` response.
   - `PlacementHint` (region/AZ/node pin/spread topology).
3. **scheduler → runtime-manager.** `RuntimeManager.Spawn(spec, handle)` over gRPC to the chosen node. Manager either:
   - Picks a pre-restored VM out of the warm pool (≤ 30ms warm hit), or
   - mmap-restores a snapshot (≤ 200ms), or
   - Cold-boots from the OCI image (≤ 1.5s).
4. **harness boot.** PID 1 in the guest is the harness binary, baked into the rootfs image — see [ADR 0004](../adr/0004-harness-baked-into-vm-image.md). On boot it:
   - Opens a vsock connection to the manager.
   - Sends `Heartbeat` every 5s; missed heartbeats for 30s force-terminate the VM.
   - Resolves each `SecretRef` via `VendSecret` (one round-trip per secret) — short-TTL JWT exchange, see [ADR 0005](../adr/0005-secret-vending-via-short-jwt.md).
   - Installs the egress filter from `AgentSpec.egress_rules` — see [ADR 0006](../adr/0006-egress-allowlist-at-harness.md).
   - Exec's the worker (user agent code).
5. **worker runs.** stdout/stderr stream out via the harness `Report` stream; OTel spans and Prometheus metrics ride the same channel as oneof bodies (`runtime.proto:380`).
6. **completion.** Worker exits, harness sends a final `Heartbeat` with `state=TERMINATED`, manager releases the VM, scheduler decrements its tally. If `idempotent=true` and the worker exited non-zero, the scheduler re-queues with a different node.

---

## Service responsibilities (the contract)

### control-plane (gatekeeper)
- Authenticates the caller (JWT or API key).
- Resolves agent version → `AgentSpec`.
- **Stamps** `tenant_id`, `agent_version_id`, `run_id`. The caller cannot set these; the comment in `runtime.proto:106` is enforced by control-plane validation.
- Checks per-tenant quota (concurrent VMs, daily $/tokens) against `agent_budgets` + `agent_usage_daily`.
- Returns the run ID immediately; the caller subscribes to `RuntimeScheduler.Events` (multiplexed by `vm_id`) for live status.

### runtime-scheduler (placement)
- Maintains an in-memory view of each node's free `vcpu_millis`, `memory_bytes`, warm-pool inventory — refreshed from `RuntimeManager.Cluster()` every 10s.
- Per-class queues. A `standard` request never blocks behind a `hostile` request (separate node pool).
- Snapshot locality: prefer the node that already has the snapshot file in its local snapshot cache. Falls back to S3 pull.
- Emits `StatusEvent` to subscribers. The scheduler is the **only** thing that writes `VmState` transitions to durable storage.
- Drain logic: on node-drain, snapshots in-flight idempotent VMs and reschedules them elsewhere; non-idempotent VMs are terminated with reason `node_drained`.

### runtime-manager (node-local lifecycle)
- One per host. Holds the `RuntimeBackend` trait impls (Firecracker, Kata, K8s Job, Wasmtime) — see [`04-runtime-isolation.md`](04-runtime-isolation.md#how-runtime-manager-actually-drives-all-of-this).
- Owns the per-host warm pool. PID-controller adjusts pool size to the running rate per `(class, digest)`.
- Terminates the `Heartbeat` and `Report` streams from each guest harness.
- Vends short-TTL secrets — calls control-plane's secret store and caches with the requested TTL (capped at 15 min).
- Exposes `Logs`/`Exec`/`Stats` for the dashboard's debug pane.

### runtime-harness (in-VM init)
- PID 1 inside the guest.
- One static binary, no dynamic deps, baked into the base image.
- Three streams to the manager over vsock: `Heartbeat`, `Report`, `VendSecret`.
- Enforces the egress allowlist via nftables in the guest's network namespace.
- Supervises the worker; restarts on crash up to a small bound, then reports `VM_STATE_FAILED`.

---

## Security boundaries

A request crosses these trust boundaries; each is a checkpoint:

| Boundary | Trust transition | Enforced by |
|---|---|---|
| Caller → control-plane | external untrusted → tenant-authenticated | JWT verification, RBAC, tenant_id stamping |
| control-plane → scheduler | gRPC mTLS, workload identity | SPIFFE-style SVID per pod |
| scheduler → manager | gRPC mTLS, workload identity | same |
| manager → harness | host → guest (vsock) | guest cannot reach manager except over vsock; no IP routing host↔guest |
| harness → worker | guest PID 1 → guest user process | seccomp profile, dropped caps, read-only rootfs |
| worker → internet | guest user process → outside world | harness egress allowlist + host CNI policy (defense in depth, [ADR 0006](../adr/0006-egress-allowlist-at-harness.md)) |

Invariants (these are load-bearing):

- The worker **never** sees raw long-lived secrets. It sees short-TTL tokens vended at boot ([ADR 0005](../adr/0005-secret-vending-via-short-jwt.md)).
- The harness **never** speaks to the control-plane directly. All traffic goes manager → control-plane.
- `tenant_id` is on every gRPC metadata header; cross-tenant joins are rejected at the manager.

---

## Observability flow

Every layer emits OTel spans correlated by `trace_id` that flows down with `ScheduleRequest` and back up in every `StatusEvent`.

```
worker  ── OTLP spans ──► harness ── HarnessReport.otlp_traces ──► manager
                                                                     │
                                                                     ├── OTel collector (per-node DaemonSet)
                                                                     │
manager ── spans ─────────────────────────────────────────────────►  │
scheduler ── spans ──────────────────────────────────────────────►   │
control-plane ── spans ──────────────────────────────────────────►   │
                                                                     ▼
                                                            ┌─────────────────┐
                                                            │  Tempo / Loki / │
                                                            │   Prometheus    │
                                                            └────────┬────────┘
                                                                     │
                                                                     ▼
                                                            apps/web dashboard
                                                            (run-detail waterfall)
```

Every span carries the standard Lantern attribute set: `tenant_id`, `run_id`, `step_id`, `agent_version`, `vm_id`, `isolation_class`. The run-detail page in `apps/web/app/(dashboard)/runs/[id]` joins these with `journal_events` to produce the timeline.

Metrics on the same channel: `lantern_vm_boot_duration_seconds{class}`, `lantern_vm_running{node,class}`, `lantern_warm_pool_size{class,digest}`, `lantern_egress_denied_total{vm_id}`.

---

## Failure modes & recovery

### Node death
1. Manager process dies, or the node disappears from the scheduler's `Cluster()` response for > 30s.
2. Scheduler marks every VM on that node `VM_STATE_FAILED` with `reason=node_lost`.
3. For VMs with `idempotent=true` *and* a recent snapshot (≤ 60s old), scheduler issues a fresh `Schedule` on another node using `restore_snapshot_id=<latest>` — see [ADR 0007](../adr/0007-snapshot-retention-policy.md) for retention.
4. For non-idempotent VMs, the run is marked failed and the caller is notified via `Events`.

### Harness crash inside a healthy VM
- Manager detects via 30s missed-heartbeat threshold.
- Force-terminates the microVM and reschedules per the idempotency rule.

### Worker crash, harness alive
- Harness restarts the worker up to `restart_count < 3`.
- After that, harness reports `VM_STATE_FAILED` and exits cleanly.

### Scheduler crash
- HA pair with leader election in etcd. Followers replay the scheduler's WAL (the `StatusEvent` log) to rebuild in-memory state.
- In-flight `Schedule` calls fail-fast with `UNAVAILABLE`; control-plane retries with exponential backoff.

### Snapshot corruption
- SHA-256 mismatch on restore → manager logs and falls back to cold boot.
- Snapshot is quarantined (moved to `s3://…/corrupt/`) and the scheduler invalidates the cache key.

---

## Interfaces

### gRPC (the proto)
`runtime.proto` is the source of truth. Three services, twelve RPCs. No REST shim between them — these are internal.

### REST (caller-facing, via control-plane)
The caller never speaks the runtime proto directly. The mapping:

| REST | Proto |
|---|---|
| `POST /v1/runs` | `RuntimeScheduler.Schedule` |
| `GET /v1/runs/{id}/events` (SSE) | `RuntimeScheduler.Events` (filtered to `run_id`) |
| `DELETE /v1/runs/{id}` | `RuntimeScheduler.Terminate` |
| `POST /v1/runs/{id}/snapshot` | `RuntimeScheduler.Snapshot` |
| `GET /v1/runs/{id}/logs` (SSE) | `RuntimeManager.Logs` |

The control-plane handles JWT auth, tenant stamping, and run-level persistence (`runs`, `journal_events`); the scheduler/manager are internal-only.

### Dashboard
`apps/web/app/(dashboard)/runs/[id]` consumes the SSE event stream and renders a node-by-node waterfall. Per-VM stats (CPU, memory, egress bytes) come from `RuntimeManager.Stats` via a control-plane proxy.

---

## How `runtime.proto` maps to actual services

| Proto symbol | Implementation |
|---|---|
| `RuntimeScheduler.Schedule` | `services/runtime-scheduler/src/handlers/schedule.rs` |
| `RuntimeScheduler.Events` | scheduler's broadcast bus, fed by every manager's status stream |
| `RuntimeScheduler.Snapshot` | scheduler picks the node, forwards to `RuntimeManager.Spawn`-adjacent snapshot RPC |
| `RuntimeManager.Spawn` | `services/runtime-manager/src/backends/{firecracker,kata,k8s,wasm}.rs` |
| `RuntimeManager.Logs/Exec/Stats` | per-backend; Firecracker uses vsock console + harness shell |
| `RuntimeHarness.Heartbeat` | `services/runtime-harness/src/heartbeat.rs` — vsock client |
| `RuntimeHarness.VendSecret` | manager-side: calls control-plane secret store, caches short-TTL token |
| `RuntimeHarness.Report` | manager-side: forwards to local OTel collector DaemonSet |

---

## What's intentionally NOT in this design

- **No direct caller → manager path.** Callers go through control-plane → scheduler. The manager is internal; exposing it would bypass quota and RBAC.
- **No persistent per-VM disk.** Scratch is tmpfs; durable state lives in S3/Postgres/Redis. `devcontainer` class is the only exception and it's explicit.
- **No live migration.** If a node drains we restore from snapshot, not migrate memory pages. Live migration is too much surface area for too small a win.
- **No harness-initiated outbound RPC to control-plane.** All harness traffic terminates at the local manager.

---

## See also

- [`../../examples/headless-agents/MANUAL-TEST.md`](../../examples/headless-agents/MANUAL-TEST.md) — step-by-step manual exercise of every endpoint, with an honest "what's real vs. stubbed" map
- [`04-runtime-isolation.md`](04-runtime-isolation.md) — which class, why, and what the hardening looks like
- [ADR 0002](../adr/0002-runtime-class-per-workload.md) — agents declare class; scheduler picks backend
- [ADR 0003](../adr/0003-scheduler-as-separate-service.md) — scheduler split out of runtime-manager
- [ADR 0004](../adr/0004-harness-baked-into-vm-image.md) — harness baked into base images
- [ADR 0005](../adr/0005-secret-vending-via-short-jwt.md) — short-TTL secret vending
- [ADR 0006](../adr/0006-egress-allowlist-at-harness.md) — egress filtering in the guest
- [ADR 0007](../adr/0007-snapshot-retention-policy.md) — keep last 3 for 7 days
- [Firecracker snapshotting](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
- [State of MicroVM Isolation 2026](https://emirb.github.io/blog/microvm-2026/)
