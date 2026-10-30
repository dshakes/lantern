# Runbook — region failover (active-passive)

Design and rationale: [ADR 0046](../adr/0046-multi-region-active-passive.md).
Targets: RPO ≤ 1 min (Postgres), ≤ 15 min (S3 bundles); RTO ≤ 30 min.

Everything below is opt-in. A deployment that never sets `PAL_REGION`,
`PAL_FENCE_EPOCH`, `PAL_READ_ONLY` or `PAL_CONTROL_PLANE_ENDPOINTS` and never
inserts a `pal_region_fence` row is unaffected.

| Knob | Where | Meaning |
| --- | --- | --- |
| `PAL_REGION` | control-plane, workflow-engine (Helm `region.name`) | region identity, stamped on runs/leases/journal + OTel `cloud.region` |
| `PAL_FENCE_EPOCH` | control-plane, workflow-engine (Helm `region.fenceEpoch`) | must equal `pal_region_fence.epoch` once armed |
| `PAL_READ_ONLY=1` | control-plane (Helm `region.readOnly`) | standby: HTTP 503 + `Retry-After: 30`, gRPC `UNAVAILABLE`, no migrations/background loops, `DataPlaneService` NOT_SERVING |
| `PAL_CONTROL_PLANE_ENDPOINTS` | data-plane agent (Helm `controlPlane.endpoints`, Terraform `pal_control_plane_endpoints`) | ordered regions, primary first |
| `PAL_CONTROL_PLANE_FAILBACK_INTERVAL` | data-plane agent | failback probe interval (default `60s`) |
| `bundles_replica_region` | Terraform (aws) | S3 CRR of the bundles/snapshots bucket |

## 0. Standing up the standby region

1. Create a cross-region **streaming read replica** of the primary Postgres
   (RDS cross-region read replica / Aurora Global / Cloud SQL replica).
   Alert on replication lag > 30 s.
2. Enable S3 CRR for the bundles/snapshots bucket (Terraform
   `bundles_replica_region`, or the provider's equivalent).
3. Install the chart in the standby region:
   `-f values.yaml -f values-prod.yaml -f values-region-standby.yaml`
   with `region.name=<standby>`, `region.fenceEpoch=<current epoch>`,
   `externalDatabase.host=<replica endpoint>`,
   `externalS3.bucket=<CRR destination>`. Redis is the per-region in-cluster
   subchart; nothing to replicate.
4. Verify the standby: `GET /readyz` is 200, `POST /v1/runs` returns 503 with
   `Retry-After`, and
   `grpcurl <standby>:50051 grpc.health.v1.Health/Check -d '{"service":"lantern.v1.DataPlaneService"}'`
   reports `NOT_SERVING`.
5. Point data planes at both regions:
   `controlPlane.endpoints: ["<primary>:443", "<standby>:443"]`. `GET :8090/status`
   on an agent shows the `endpoint` in use.

## 1. Arming the fence (once, while healthy)

Order matters: arming first would reject writers that don't send an epoch.

1. Roll the **active** region with `region.name=<active>` and
   `region.fenceEpoch=1` (control plane and workflow engine — anything sharing
   the database). Roll the standby with `region.fenceEpoch=1` too.
2. Confirm every writer carries it (new `run_locks` rows have `region` set):
   `SELECT region, count(*) FROM run_locks GROUP BY 1;`
3. Arm, on the primary:
   ```sql
   INSERT INTO pal_region_fence (epoch, active_region) VALUES (1, '<active>');
   ```
   From now on a write to `runs` / `run_locks` / `journal_events` from a session
   without epoch 1 fails with `pal_fence: … rejected`. If you see that error in
   logs right after arming, a writer was missed: `DELETE FROM pal_region_fence;`
   disarms instantly.

## 2. Failover (active region lost)

1. **Isolate the old primary.** Scale the old region's control plane and
   workflow engine to 0 if you can reach it; in any case make sure the old
   *database* can no longer accept writes (stop the instance, revoke its
   security-group ingress). The fence protects the new database from stale
   processes; it cannot see writes made to a second live primary.
2. **Promote the replica** (RDS "promote read replica" / Aurora "failover
   global cluster" / Cloud SQL "promote"). Note the replication lag at the
   moment of promotion — that is the data-loss window.
3. **Bump the epoch** on the promoted database:
   ```sql
   UPDATE pal_region_fence SET epoch = epoch + 1, active_region = '<new active>', updated_at = now();
   SELECT * FROM pal_region_fence;
   ```
   Any old-region process that can still reach this database is now fenced:
   its lease renewals, journal appends and run updates are rejected.
4. **Activate the standby**: `helm upgrade` it, swapping
   `values-region-standby.yaml` for `values-region-primary.yaml`, with
   `region.fenceEpoch=<new epoch>` (and `externalDatabase.host` unchanged — the
   replica endpoint is now the primary). This turns read-only off, runs
   migrations (no-op), and starts the workflow engine, scheduler, cron and the
   crash-recovery sweep.
5. **In-flight runs resume automatically.** The recovery sweep treats leases
   from the old epoch as orphaned immediately (no TTL wait) and re-drives them
   from the journal; completed steps are not re-executed.
6. **Traffic**: flip the public DNS / global load balancer to the new region.
   Data-plane agents move on their own: the old region is unreachable or
   `NOT_SERVING`, the new one now reports `SERVING`.
7. Verify: `SELECT region, count(*) FROM journal_events WHERE created_at > now() - interval '10 minutes' GROUP BY 1;`
   shows only the new region; agents' `/status` show the new `endpoint`.

## 3. Failback (optional, planned)

Failback is a planned failover in the other direction: rebuild the old region
as a replica of the new primary (step 0), wait for lag ≈ 0, then run section 2
with a maintenance window (step 1 becomes "set the active region read-only",
which also drains its data planes to the standby — they fail back to the
first `SERVING` endpoint on their own).

## Troubleshooting

* `pal_fence: write to … rejected: session epoch <unset>` — a writer is missing
  `PAL_FENCE_EPOCH`, or a transaction-mode pooler is dropping startup
  parameters (PgBouncer `ignore_startup_parameters`). Fails closed by design.
* `session epoch N is not the current epoch N+1` on the **new** region — step 4
  was rolled with the old epoch.
* Agents stuck disconnected with `no healthy control-plane endpoint` — every
  region is read-only or unreachable; check step 4.
* Single-region rollback of this feature: `DELETE FROM pal_region_fence;` and unset
  the env vars. The `region` columns can stay (nullable, unused).
