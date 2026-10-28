# MicroVM Productionization — From Spike to Production Data Plane

> **In one line:** control-plane gates and stamps, the Go `runtime-scheduler` places, the Rust `runtime-manager` spawns, and the Rust `harness` is PID 1 in the VM. **Try it:** `lantern run examples/headless-agents/01-hello/agent.yaml -f` ([guide](../guides/headless-agent-quickstart.md)).
>
> **What this is:** the system-level overview of how a `Run` request becomes a running microVM, how the in-VM harness talks back, and how the three services defined in `packages/proto/lantern/v1/runtime.proto` collaborate.
>
> **Companion to:** [`04-runtime-isolation.md`](04-runtime-isolation.md) — which classes exist and *why*. This doc is the *how*: the wiring between control-plane, scheduler, runtime-manager, and the in-VM harness.
>
> **Audience:** anyone touching `services/runtime-manager`, `services/runtime-scheduler`, the proto, or `services/harness`.

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
| `RuntimeScheduler` | cluster-wide; one leader (Postgres advisory-lock election) | Go | `services/runtime-scheduler/` |
| `RuntimeManager` | node-local; one per host | Rust | `services/runtime-manager/` |
| `RuntimeHarness` | inside the guest; one per VM | Rust (static musl) | `services/harness/` |

Each maps directly to a service block in `runtime.proto`. The split is the subject of [ADR 0003](../adr/0003-scheduler-as-separate-service.md).

---

## Data flow — happy path

1. **Caller → control-plane.** CLI or SDK POSTs `/v1/runtime/schedule` (or an `isolation: microvm` agent run is routed here by the run executor, [ADR 0022](../adr/0022-two-tier-agent-runtime.md)). The control-plane resolves the agent version, looks up its `AgentSpec` template (image digest, isolation class, limits, egress rules, secret refs), and **stamps `tenant_id` from the JWT** into the spec — see comment in `runtime.proto:106`. RBAC + per-tenant quota are checked here, *before* the scheduler ever sees the request.
2. **control-plane → scheduler.** `RuntimeScheduler.Schedule(spec, hint, cold_start_budget)`. Returns a `VmHandle` once a node is picked. The schedule decision uses:
   - The `IsolationClass` to pick a backend (`standard`/`untrusted` → Firecracker pool; `hostile` → Kata node-pool; `trusted` → K8s; `wasm` → in-process on a trusted host).
   - Warm-pool inventory per `(class, image_digest)` reported by each manager in its `Cluster()` response.
   - `PlacementHint` (region/AZ/node pin/spread topology).
3. **scheduler → runtime-manager.** `RuntimeManager.Spawn(spec, handle)` over gRPC to the chosen node. Manager either:
   - Picks a pre-restored VM out of the warm pool (target ≤ 30ms warm hit), or
   - mmap-restores a snapshot (target ≤ 200ms), or
   - Cold-boots from the OCI image (target ≤ 1.5s).

   These are targets; measured numbers are in [`docs/benchmarks/runtime-latency.md`](../benchmarks/runtime-latency.md).
4. **harness boot.** PID 1 in the guest is the harness binary, baked into the rootfs image — see [ADR 0004](../adr/0004-harness-baked-into-vm-image.md). On boot it:
   - Opens a vsock connection to the manager.
   - Sends `Heartbeat` every 5s; the manager treats a heartbeat older than 30s (`HEARTBEAT_STALE_SECS`) as stale.
   - Resolves each `SecretRef` via `VendSecret` (one round-trip per secret) — short-TTL JWT exchange, see [ADR 0005](../adr/0005-secret-vending-via-short-jwt.md).
   - Installs the egress filter from `AgentSpec.egress_rules` — see [ADR 0006](../adr/0006-egress-allowlist-at-harness.md). In broker mode (`LANTERN_EGRESS_MODE=broker`, [ADR 0026](../adr/0026-host-egress-broker.md)) the VM has no NIC; the harness instead forwards `127.0.0.1:3128` over vsock to the manager's host-side broker, which enforces the rules and injects `EgressRule.inject` credentials on the way out.
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
- Maintains an in-memory view of each node's free `vcpu_millis`, `memory_bytes`, warm-pool inventory, reported by the managers.
- Per-class queues. A `standard` request never blocks behind a `hostile` request (separate node pool).
- Snapshot locality: prefer the node that already has the snapshot file in its local snapshot cache. Falls back to S3 pull.
- Emits `StatusEvent` to subscribers. The scheduler is the **only** thing that writes `VmState` transitions to durable storage.
- Drain logic: on node-drain, snapshots in-flight idempotent VMs and reschedules them elsewhere; non-idempotent VMs are terminated with reason `node_drained`.

### runtime-manager (node-local lifecycle)
- One per host. Holds the `RuntimeBackend` trait impls (Firecracker, Kata, K8s Job, Wasmtime) — see [`04-runtime-isolation.md`](04-runtime-isolation.md#how-runtime-manager-actually-drives-all-of-this).
- Owns the per-host warm pool. PID-controller adjusts pool size to the running rate per `(class, digest)`.
- Terminates the `Heartbeat` and `Report` streams from each guest harness.
- Vends short-TTL secrets by calling the control-plane relay `POST /v1/runtime/secrets/resolve` ([ADR 0008](../adr/0008-runtime-secret-relay.md)); the manager never holds the decryption key.
- Exposes `Logs`/`Exec`/`Stats` for the dashboard's debug pane.

### runtime-harness (in-VM init)
- PID 1 inside the guest.
- One static binary, no dynamic deps, baked into the base image.
- Streams to the manager over vsock: `Heartbeat`, `Report`, plus the `VendSecret` and `Exec` calls.
- Egress: CONNECT allowlist proxy on `127.0.0.1:3128`, enforced by an iptables REDIRECT rule; fail-closed in prod when rules are declared and the REDIRECT is absent.
- Supervises the worker; restarts on crash up to `DEFAULT_MAX_RESTARTS` (5), then reports `VM_STATE_FAILED`.

---

## Security boundaries

A request crosses these trust boundaries; each is a checkpoint:

| Boundary | Trust transition | Enforced by |
|---|---|---|
| Caller → control-plane | external untrusted → tenant-authenticated | JWT verification, RBAC, tenant_id stamping |
| control-plane → scheduler | gRPC, `x-lantern-service-token` (`LANTERN_GRPC_SERVICE_TOKEN`) | service-auth interceptor, fail-closed in prod |
| scheduler → manager | gRPC, service token + client TLS (`LANTERN_RUNTIME_MANAGER_TLS_*`) | manager interceptor ([ADR 0025](../adr/0025-sandbox-spawn-contract-and-manager-authz.md)) |
| manager → harness | host → guest (vsock) | guest cannot reach manager except over vsock; no IP routing host↔guest |
| harness → worker | guest PID 1 → guest user process | seccomp profile, dropped caps, read-only rootfs |
| worker → internet | guest user process → outside world | harness egress allowlist + host CNI policy (defense in depth, [ADR 0006](../adr/0006-egress-allowlist-at-harness.md)) |
| worker → internet (broker mode) | guest user process → outside world | NO guest NIC; host-side egress broker over vsock enforces the allowlist and injects credentials, which never enter the VM ([ADR 0026](../adr/0026-host-egress-broker.md)) |

Invariants (these are load-bearing):

- The worker **never** sees raw long-lived secrets. It sees short-TTL tokens vended at boot ([ADR 0005](../adr/0005-secret-vending-via-short-jwt.md)).
- The harness **never** speaks to the control-plane directly. All traffic goes manager → control-plane (the manager forwards `Report` frames to `POST /v1/runtime/report`).
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

Control-plane spans carry the `lantern.*` attribute set (`lantern.tenant_id`, `lantern.run_id`, `lantern.step_id`, `lantern.isolation_class`). See the [observability guide](../guides/observability.md). The run-detail page in `apps/web/app/(dashboard)/runs/[id]` joins these with `journal_events` to produce the timeline.

Metrics on the same channel: `lantern_vm_boot_duration_seconds{class}`, `lantern_vm_running{node,class}`, `lantern_warm_pool_size{class,digest}`, `lantern_egress_denied_total{vm_id}`.

---

## Spawn contract, identity pinning, and sandbox lifecycle

Rationale and rollout: [ADR 0025](../adr/0025-sandbox-spawn-contract-and-manager-authz.md).

**Spawn contract.** The guest learns what to run from `spawn.json` at the root of
the read-only cert image the manager attaches to every Firecracker VM:
`{version, workload_cmd, env, egress_rules, workload_uid, workload_gid}`. JSON is
byte-exact (the old kernel-cmdline path mangled spaces and quotes); the cmdline is
kept only for harness builds that predate the file. The harness rejects unknown
`version`s, drops the workload, exec and shell children to `workload_uid`/`gid`,
and gives them an explicit env with `LANTERN_*` withheld except a non-secret
allowlist. The uid is set by the manager (`LANTERN_WORKLOAD_UID_DEFAULT`); a
caller-supplied `LANTERN_WORKLOAD_UID` is dropped.

**Identity pinning.** Per-VM certs are CN = `vm_id` and carry `OU=lantern-vm`. The
manager's `RuntimeManager` interceptor refuses any such cert and requires
`x-lantern-service-token` (`LANTERN_GRPC_SERVICE_TOKEN`), so a guest can reach only
`RuntimeHarness`, where each message is bound to its own `vm_id`. `ExecTool`
carries `tenant_id` and returns `NOT_FOUND` on mismatch. Snapshots record the
owning tenant and agent version; restoring across tenants is `NOT_FOUND`.

**Pause / resume / fork.**

1. `pause` — manager snapshots (memory + disk, streamed to the store in 1 MiB
   chunks), stops the VM, and the control-plane releases the tenant quota slot.
   State becomes `paused`; `snapshotId` is recorded on the VM.
2. `resume` — claims a quota slot (402 if none; 409 if the VM is not `paused`),
   restores the snapshot under the same `vm_id`, and the harness re-identifies.
3. `fork {count 1..LANTERN_MAX_FORK_COUNT}` — restores the snapshot `count` times
   (default cap 100, hard ceiling 1000); each fork gets a new `vm_id`, cert and
   agent identity, with `parentVmId` pointing at the source.  Fork spawns fan out
   with bounded concurrency (`LANTERN_FORK_CONCURRENCY`, default 16) so N=100
   forks saturate the node's restore pipeline without unbounded goroutine
   explosion.  Two CoW mechanisms keep fork disk I/O O(1):

   - **Memory** — the snapshot `.mem` file is hard-linked into every fork's jail.
     Firecracker maps it `MAP_PRIVATE`, so all forks share pages via the host page
     cache until a guest write triggers copy-on-write.  Falls back to a full byte
     copy only on `EXDEV` (cross-device) or if `chmod 0444` fails.

   - **Disk (rootfs)** — the snapshot `.rootfs` disk image is staged into each
     fork jail via the `FICLONE` ioctl (Linux copy-on-write reflink, O(1)).
     Physical disk extents are shared between the source snapshot and every fork
     until a guest write triggers block-level CoW.  **Requires the snapshot
     directory and the jail chroot (`FIRECRACKER_CHROOT_BASE`) to be on the same
     XFS filesystem with `reflink=1` mount option, or btrfs.**  The manager logs
     `"disk staged via FICLONE (CoW reflink, O(1) disk I/O)"` for each fork to
     confirm.  On a non-reflink filesystem (`EOPNOTSUPP`) or cross-device path
     (`EXDEV`) the manager **fails closed** with a typed error rather than
     silently falling back to an O(n) copy — `LANTERN_ALLOW_FULL_COPY_FORK=1`
     opts into the full-copy fallback for dev/CI environments that cannot use
     reflinks (e.g. ext4, tmpfs).

   Forking a running VM requires Firecracker ≥ 1.12 + jailer.  Per-fork failures
   come back in `forks[].error`; they do not fail the whole call.

Re-identification matters because a restored guest otherwise resumes with the
source VM's cert and id. Status: unit- and contract-tested, and exercised end to end by the KVM CI job described under *Lifecycle validation* below (see [`GA-READINESS.md`](../GA-READINESS.md)).

**Idle-suspend (auto-pause).** Set `idle_timeout_secs > 0` on the AgentSpec when
scheduling. The scheduler's idle sweeper (10 s tick, leader-gated) monitors
`VM.LastActivityAt` and auto-pauses any RUNNING VM idle longer than the threshold.
The state machine is `RUNNING → DRAINING+idle-pausing → PAUSED`, using the same
crash-safe CAS as operator Pause so a mid-auto-pause crash settles to PAUSED (not
TERMINATED) via `ReconcileNodeInventory`. The quota slot is released on PAUSED.
Idle costs nothing.

**Scope: sandbox-style (persistent) VMs only.** Idle-suspend targets VMs kept
RUNNING between requests so they can accept `exec` sessions without a cold start.
Workload VMs — VMs spawned with a `workload_cmd` that exits on completion — are not
candidates: the harness exits with the workload and the scheduler terminates the VM
via normal inventory reconciliation. Setting `idle_timeout_secs` on a workload VM
is harmless but has no effect.

**Activity signal and clock-skew protection.** `VM.LastActivityAt` is stamped with
the scheduler's own receive time. The harness heartbeat's `last_activity_unix_ms`
(guest wall clock) is used only as a change signal: when the value changes between
two beats, a new idle epoch started and the scheduler stamps its local time. This
protects against snapshot/restore clock skew — a just-resumed VM's guest clock is
behind by the paused duration; using scheduler time prevents the sweeper from
treating a freshly resumed VM as immediately idle. Any `RUNNING` transition (spawn
or resume) resets `LastActivityAt` to zero; the sweeper ignores the VM until the
first fresh harness heartbeat arrives.

**Transparent auto-resume.** Exec, ExecTool, and file-API requests (`/files`,
`/files/content`) to a VM with `idle_timeout_secs > 0` and shadow state `running`
first ask the scheduler to resume it (the sweeper does not update the shadow row).
`FailedPrecondition` means it is already running — concurrent requests never
double-resume; quota exhaustion → 402. A VM paused by an operator (`POST /pause`,
shadow `paused`) is never auto-resumed → 409. Terminal shadow states (terminated,
failed) pass through without a Resume call; the downstream path produces the
natural 404.

## Diagrams

<img src="../assets/diagrams/runtime-two-tier.svg" alt="Two-tier agent runtime, including the microVM trust chain: control-plane to runtime-scheduler to runtime-manager to Firecracker VM with harness PID 1" width="100%">

<img src="../assets/diagrams/sandbox-lifecycle.svg" alt="Sandbox lifecycle: running, pause (snapshot and stop), paused, resume (restore, re-identify, fresh exec token), and fork into N children each with a fresh identity" width="100%">

Lifecycle and identity semantics: [ADR 0025](../adr/0025-sandbox-spawn-contract-and-manager-authz.md).

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
- Harness restarts the worker up to 5 times (`DEFAULT_MAX_RESTARTS`).
- After that, harness reports `VM_STATE_FAILED` and exits cleanly.

### Scheduler crash
- HA via leader election on a Postgres advisory lock (`internal/leader`); state lives in Postgres (`internal/store`), so a new leader rebuilds from the store.
- In-flight `Schedule` calls fail-fast with `UNAVAILABLE`; control-plane retries with exponential backoff.

### Snapshot corruption
- SHA-256 mismatch on restore → manager logs and falls back to cold boot.
- Snapshot is quarantined (moved to `s3://…/corrupt/`) and the scheduler invalidates the cache key.

---

## Node filesystem requirements for fork scale

Fork staging uses two kernel CoW mechanisms to keep per-fork disk I/O O(1):

| Artifact | Mechanism | FS requirement |
|---|---|---|
| Memory snapshot (`.mem`) | Hard-link + `MAP_PRIVATE` | Any local filesystem (hard-links never cross device) |
| Disk snapshot (`.rootfs`) | `FICLONE` ioctl (reflink) | **XFS with `reflink=1`**, or **btrfs** — see below |

**Why `FICLONE` instead of hard-links for disk?**  Firecracker opens the rootfs image with write permissions; a hard-linked disk would let two simultaneously-running fork VMs mutate the same inode, corrupting each other.  `FICLONE` creates a new inode whose extents are shared via CoW — a write to fork A's extents does not affect fork B or the source snapshot.

**Production setup.**  Mount the snapshot store and the jail chroot base
(`FIRECRACKER_CHROOT_BASE`, default `/srv/jailer`) on the same XFS partition
formatted with `mkfs.xfs -m reflink=1`.  Both paths must be on the SAME
filesystem (same mount point) — the kernel does not allow cross-device reflinks
(`EXDEV`).

```bash
# Example: XFS with reflinks on a dedicated data volume
mkfs.xfs -m reflink=1 -m crc=1 /dev/nvme0n1p2
mount -o noatime /dev/nvme0n1p2 /data
mkdir -p /data/snapshots /data/jailer
# Then set env on the manager:
export LANTERN_SNAPSHOT_DIR=/data/snapshots
export FIRECRACKER_CHROOT_BASE=/data/jailer
```

**Verification.**  The manager logs `"disk staged via FICLONE (CoW reflink, O(1) disk I/O)"` with `src` and `dest` fields for each fork disk.  Confirm shared extents with:

```bash
sudo filefrag -v /data/jailer/firecracker/<vm_id>/root/snapshot/rootfs | head -10
# Physical start should match the source snapshot's extents until first guest write.
```

**Dev / CI fallback.**  Set `LANTERN_ALLOW_FULL_COPY_FORK=1` to allow a full byte copy when FICLONE is unavailable (ext4, tmpfs).  The manager logs a `WARN` and continues.  This is a deliberate degradation — N forks of a 1 GiB rootfs cost N GiB of disk I/O and storage.

---

## Interfaces

### gRPC (the proto)
`runtime.proto` is the source of truth: three services (`RuntimeScheduler`, `RuntimeManager`, `RuntimeHarness`). No REST shim between them — these are internal.

### REST (caller-facing, via control-plane)
The caller never speaks the runtime proto directly. The mapping:

| REST | Proto |
|---|---|
| `POST /v1/runtime/schedule` | `RuntimeScheduler.Schedule` |
| `GET /v1/runtime/vms`, `/vms/{id}` | `RuntimeScheduler.List` / shadow `runtime_vms` row |
| `DELETE /v1/runtime/vms/{id}` | `RuntimeScheduler.Terminate` |
| `POST /v1/runtime/vms/{id}/pause\|resume\|fork` | `RuntimeScheduler.Pause` / `Resume` / `Fork` |
| `GET /v1/runtime/vms/{id}/logs` (SSE) | `RuntimeManager.Logs` |
| `POST /v1/runtime/vms/{id}/exec` | `RuntimeManager.Exec` |
| `GET /v1/runtime/cluster` | `RuntimeScheduler.Cluster` |

The control-plane handles JWT auth, tenant stamping, and run-level persistence (`runs`, `journal_events`); the scheduler/manager are internal-only.

### Dashboard
`apps/web/app/(dashboard)/runs/[id]` consumes the SSE event stream and renders a node-by-node waterfall. Per-VM stats (CPU, memory, egress bytes) come from `RuntimeManager.Stats` via a control-plane proxy.

---

## How `runtime.proto` maps to actual services

| Proto symbol | Implementation |
|---|---|
| `RuntimeScheduler.*` | `services/runtime-scheduler/internal/handlers/` (placement in `internal/placement`, `internal/scoring`) |
| `RuntimeManager.Spawn` | `services/runtime-manager/src/service.rs` dispatching to `backends/{firecracker,kata,k8s,docker,wasm}.rs` |
| `RuntimeManager.Logs/Exec/ExecTool/Stats` | per-backend; Firecracker uses vsock plus the harness |
| `RuntimeHarness.Heartbeat` | `services/harness/src/heartbeat.rs` |
| `RuntimeHarness.VendSecret` | harness `secrets.rs` / `manager_client.rs`; manager calls the control-plane relay |
| `RuntimeHarness.Report` | harness streams to the manager, which forwards to the control-plane `POST /v1/runtime/report` |

---

## What's intentionally NOT in this design

- **No direct caller → manager path.** Callers go through control-plane → scheduler. The manager is internal; exposing it would bypass quota and RBAC.
- **No persistent per-VM disk.** Scratch is tmpfs; durable state lives in S3/Postgres/Redis. `devcontainer` class is the only exception and it's explicit.
- **No live migration.** If a node drains we restore from snapshot, not migrate memory pages. Live migration is too much surface area for too small a win.
- **No harness-initiated outbound RPC to control-plane.** All harness traffic terminates at the local manager.

---

## In-guest tool runner (shipped 2026-07-23)

The runtime-manager's `exec_tool` previously returned `TOOL_STATUS_UNAVAILABLE` because no in-guest runner existed (documented in ADR 0015). The harness now contains a typed tool registry in `services/harness/src/tool_runner.rs`:

- **`shell_exec`** — run a shell command with enforced timeout; returns stdout, stderr, exit code.
- **`http_fetch`** — HTTP request forced through the `127.0.0.1:3128` egress-allowlist proxy; 1 MiB response cap.
- **`read_file` / `write_file` / `list_dir`** — confined to `LANTERN_WORKSPACE` (default `/workspace`); these back the sandbox file API.
- Unknown tool names return `TOOL_STATUS_ERROR` (typed, never `UNAVAILABLE`).

Transport: the existing `RuntimeHarness.Exec` gRPC stream, with a `__lantern_tool_call__` sentinel in `argv[0]` followed by a JSON envelope. The harness intercepts the sentinel before the general exec audit path so serialized arguments never appear in audit logs (invariant #10). `TOOL_STATUS_UNAVAILABLE` now strictly means the VM is not found or the harness is unreachable.

This unblocks the microVM tier as a real step executor for the two-tier routing described in [ADR 0022](../adr/0022-two-tier-agent-runtime.md) and [09-agent-runtime.md](09-agent-runtime.md).

## Lifecycle validation (CI + Lima)

The full snapshot/stop/restore/fork cycle is exercised by
`infra/firecracker/integration-test.sh`, which runs on every push via
`.github/workflows/microvm-integration.yml` on a KVM-capable runner (Ubuntu
with `/dev/kvm`).  On Apple Silicon M3+/macOS 15+ you can run the same test
locally inside the Lima guest (`infra/lima/firecracker-dev.yaml`).

### What is asserted end to end

| Step | Assertion |
|------|-----------|
| Cold boot | harness starts as PID 1; no kernel panic |
| ExecTool shell_exec | tool output returned from inside the guest |
| write_file | state marker written to `/workspace` before snapshot |
| Snapshot | `snapshot_id` returned; byte count > 0 |
| Stop | no `firecracker` process for this vm_id remains after Stop |
| Restore (Spawn + restore_snapshot_id) | harness re-prints startup log; from_snapshot=true |
| Re-identification | PATCH /drives/certs logged before resume |
| read_file | state marker content matches what was written |
| Fork ×3 (jailer required) | 3 distinct vm_ids; each comes alive |
| COW isolation | fork-1.txt written in fork-1 is NOT visible in fork-2 |
| Fork teardown | no leaked firecracker processes after Stop ×3 |

### COW isolation design

Without the jailer each restored VM shares the same `rootfs.ext4` file on the
host; the Linux page cache makes block-device writes visible across all VMs
that loaded from the same snapshot.  The fix (`services/runtime-manager/src/
backends/firecracker.rs`) copies the global image to
`/run/lantern/rootfs/<vm_id>.ext4` during unjailed restores and issues a
`PATCH /drives/rootfs` API call before `PATCH /vm Resumed`.  Jailed restores
already get per-VM isolation through the chroot staging path.  The per-VM
copy is removed by `cancel()` on teardown.

### Timing artifact

Every lifecycle step is bracketed with ms-precision timestamps.  The script
writes `LIFECYCLE_TIMING_DIR/lifecycle-timing.{json,md}` and the CI job
uploads it as the **microvm-lifecycle-timing** artifact.  See
`docs/benchmarks/runtime-latency.md` for indicative numbers.

### Re-running locally in Lima

See `infra/lima/README.md` for the step-by-step guide.  The jailer binary is
installed by the Lima provision script alongside `firecracker` from the same
v1.15.1 tarball, so the fork test runs without any extra setup.

## See also

- [`09-agent-runtime.md`](09-agent-runtime.md) — **definitive two-tier runtime reference** — durable execution, journal, retry, health sweep
- [`../../examples/headless-agents/MANUAL-TEST.md`](../../examples/headless-agents/MANUAL-TEST.md) — step-by-step manual exercise of every endpoint, with an honest "what's real vs. stubbed" map
- [`04-runtime-isolation.md`](04-runtime-isolation.md) — which class, why, and what the hardening looks like
- [ADR 0022](../adr/0022-two-tier-agent-runtime.md) — two-tier routing: manifest `isolation` field, microVM tier, honest failure
- [ADR 0002](../adr/0002-runtime-class-per-workload.md) — agents declare class; scheduler picks backend
- [ADR 0003](../adr/0003-scheduler-as-separate-service.md) — scheduler split out of runtime-manager
- [ADR 0004](../adr/0004-harness-baked-into-vm-image.md) — harness baked into base images
- [ADR 0005](../adr/0005-secret-vending-via-short-jwt.md) — short-TTL secret vending
- [ADR 0006](../adr/0006-egress-allowlist-at-harness.md) — egress filtering in the guest
- [ADR 0026](../adr/0026-host-egress-broker.md) — broker egress mode: no guest NIC, host-side egress broker over vsock, credential injection
- [ADR 0007](../adr/0007-snapshot-retention-policy.md) — keep last 3 for 7 days
- [Firecracker snapshotting](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
- [State of MicroVM Isolation 2026](https://emirb.github.io/blog/microvm-2026/)
