# ADR 0046 — Multi-region: active-passive control plane with DB-level fencing

**Status:** Accepted (enablers shipped, flag-gated; automated promotion is future work)
**Date:** 2026-10-29
**Deciders:** Platform team

---

## Context

`docs/architecture/01-overview.md` promised "multi-region durability in the
managed offering"; `17-deployment-model.md` described multi-data-plane routing.
In code the platform was single-region: one Postgres, one Redis, one bucket,
data-plane agents pinned to a single `CONTROL_PLANE_ENDPOINT`, and no notion of
which region wrote a row.

The dangerous part of going multi-region is not replication — managed Postgres
and S3 replicate fine — it is **split-brain after a failover**. Run execution
is guarded by `run_locks` leases (control-plane `acquireRunLease`,
recovery sweep) and by idempotency keys `(run_id, step_id, attempt)` on side
effects (invariant #8). A lease is a TTL row; nothing stops a still-alive old
primary from renewing it, appending to `journal_events`, or flipping
`runs.status` if it can still reach the database the standby was promoted to
(a global writer DNS name, a flipped connection pooler, a half-finished
cut-over). Idempotency keys stop duplicate *provider* calls; they do not stop
two regions from both believing they own a run.

## Decision

### Target topology (active-passive)

| Layer | Active region | Standby region | Replication |
| --- | --- | --- | --- |
| Control plane | read-write, all background loops | `PAL_READ_ONLY=1`: reads only, 503 on mutations, no migrations / cron / recovery / janitors | — |
| Postgres | primary | streaming replica (managed: RDS cross-region read replica / Cloud SQL / Aurora Global) | async WAL |
| Redis | per region | per region | **none** — caches, rate limits, SSE pub/sub only; rebuilt after failover |
| S3 bundles/snapshots | primary bucket | CRR destination | S3 CRR + Replication Time Control (15 min SLA) |
| Workflow engine, runtime scheduler | running | scaled to 0 | — |
| Data-plane agents | — | — | register to their first healthy region (`PAL_CONTROL_PLANE_ENDPOINTS`) |

Active-active was rejected: invariant #2 (the engine is the only writer of run
state) and invariant #7 (no cross-tenant joins) both assume one authoritative
database; multi-writer Postgres would put conflict resolution in the run state
machine.

### Region identity (`PAL_REGION`)

Every control-plane and workflow-engine connection sends the session GUC
`pal.region`. Migration `0030_region_fencing` adds a nullable `region` column
to `runs`, `run_locks` and `journal_events` whose DEFAULT reads that GUC, so
every insert is stamped by the database without touching any of the dozens of
insert sites. The control plane adds `cloud.region` / `pal.region` to its OTel
resource. Unset → NULL / no attribute.

### Fencing epochs (the split-brain guard)

* `region_fence` is a single-row table `{epoch, active_region}`. **No row =
  unarmed**, which is every existing deployment.
* Every process sends `pal.fence_epoch` from `PAL_FENCE_EPOCH`.
* Trigger `pal_fence_guard` (BEFORE INSERT/UPDATE on `runs`, `journal_events`;
  INSERT/UPDATE/DELETE on `run_locks`) compares the session epoch with
  `region_fence.epoch`. Once armed, a missing or different epoch raises
  SQLSTATE `55000` with message prefix `pal_fence:` — fail closed.
* Accepted `run_locks` writes are stamped with `fence_epoch`. The lease
  acquisition paths (`acquireRunLease`, `acquireRecoveryLock`,
  `findOrphanedRuns`) also treat a lease from an **older** epoch as void, so the
  promoted region resumes in-flight runs immediately instead of waiting out the
  TTL. Runs resume from the journal (invariant #3); completed steps are not
  re-executed and side effects dedup on their idempotency keys.
* Promotion = bump `region_fence.epoch`, then roll the promoted region with the
  new `PAL_FENCE_EPOCH`. The old region's sessions still carry the old epoch,
  so the database itself refuses their writes — no reliance on the old
  binary noticing anything.

The check lives in the database (not Go) on purpose: the component we are
fencing is the one whose behaviour we cannot trust after a partition.
`SECURITY DEFINER` functions with a pinned `search_path` let the RLS role
`lantern_app` evaluate the fence without a grant on `region_fence`.

The runtime-scheduler's advisory-lock leader election needs no epoch: advisory
locks are session state on the primary and are not replicated, so a promoted
replica starts with no leader and the scheduler is region-local anyway.

### Data-plane failover

`PAL_CONTROL_PLANE_ENDPOINTS` is an ordered list. The agent health-checks
`lantern.v1.DataPlaneService` (standard gRPC health) and connects to the first
`SERVING` endpoint; a read-only standby reports `NOT_SERVING` and refuses
`Register`/`Heartbeat`/`RunStream` with `UNAVAILABLE`. On a fallback endpoint
the agent probes higher-priority endpoints every
`PAL_CONTROL_PLANE_FAILBACK_INTERVAL` (60s) and fails back after two
consecutive healthy probes. One endpoint (the default) skips probing entirely.

### RPO / RTO targets

| | Target | Driven by |
| --- | --- | --- |
| RPO, run state (Postgres) | ≤ 1 min (typically seconds) | async replica lag; alert on lag > 30s |
| RPO, bundles/snapshots (S3) | ≤ 15 min | CRR Replication Time Control |
| RPO, Redis | n/a | holds nothing durable |
| RTO | ≤ 30 min, operator-driven | runbook `docs/runbooks/region-failover.md` |

Async replication means a failover can lose the last few seconds of journal.
A run whose `step_completed` was lost re-executes that step on the promoted
region with the same idempotency key, so provider-side dedup (invariant #8)
still applies; side effects without provider dedup can repeat once. That is
the price of async replication and is stated, not hidden.

## What is enabled by default

Nothing. With `PAL_REGION`, `PAL_FENCE_EPOCH`, `PAL_READ_ONLY` and
`PAL_CONTROL_PLANE_ENDPOINTS` unset and no `region_fence` row, the only
observable change is three nullable columns and an inert trigger
(one single-row lookup per guarded write). Helm renders identically unless
`region.*` / `controlPlane.endpoints` are set; Terraform creates no resources
unless `bundles_replica_region` is set.

## Out of scope / remaining

* **Automated promotion.** Detection, quorum and the promote sequence are an
  operator runbook today. Automating it needs an external arbiter (not a
  database in either region) and is a separate ADR.
* **Fencing the old database.** If the old primary *Postgres* is still
  accepting writes, the trigger in the new database cannot see them. Step 1 of
  the runbook isolates the old primary (stop writers / revoke network). The
  fence protects the promoted database from stale *processes*, not a second
  live primary.
* Engine-side lease stealing on a stale epoch (the engine's own leases expire
  by TTL; their renewals are already rejected by the fence).
* Read routing to a local replica in the active region, per-tenant region
  pinning / data residency, Redis replication, GCP/Azure Terraform for CRR.
* A transaction-mode connection pooler must pass the `pal.*` startup
  parameters (PgBouncer `ignore_startup_parameters` drops them — then the
  fence rejects everything once armed, i.e. fails closed).
