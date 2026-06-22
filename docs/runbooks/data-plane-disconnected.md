# Runbook — data plane disconnected / heartbeat stale

> **Audience:** on-call operators.
> **Fires from:** `DataPlaneHeartbeatStale` (critical), `SchedulerNoRegisteredNodes`
> (critical).
> **Dashboards:** Lantern — Data Plane & Runtime.

A **data plane** runs agent workloads in the customer's infra (EKS/GKE/AKS); the
**control plane** never touches user code directly. The two are joined by the
data-plane tunnel — the data-plane-agent maintains a connection and RunStream,
and heartbeats into the control-plane's `data_planes` table roughly every 30s.
When that heartbeat goes stale, runs routed to that plane stall: the control
plane can't reach the workloads.

---

## What fired it

- **`DataPlaneHeartbeatStale`** — `lantern_data_plane_seconds_since_heartbeat`
  (a gauge derived from `data_planes.last_heartbeat` by the postgres_exporter
  custom query, see `infra/monitoring/prometheus/postgres-exporter-queries.yaml`)
  exceeded 120s for one plane. Heartbeat cadence is ~30s, so >120s = missed
  several in a row. Labels carry `data_plane_id`, `cloud`, `region`.
- **`SchedulerNoRegisteredNodes`** — `lantern_scheduler_nodes == 0` for 5m. The
  scheduler sees zero healthy runtime-manager nodes; placement is impossible.

---

## Triage

```sql
-- Which planes are stale, and by how much?
SELECT id, cloud, region, status,
       EXTRACT(EPOCH FROM (now() - last_heartbeat))::int AS secs_since_hb
FROM data_planes
ORDER BY last_heartbeat ASC;
```

```bash
# Control-plane side: is it accepting heartbeats / RunStream connections?
kubectl -n <ns> logs deploy/<control-plane> --tail=200 \
  | grep -i 'heartbeat\|runstream\|data.plane\|tunnel'

# Data-plane side (in the CUSTOMER cluster / namespace): is the agent alive and
# is its tunnel connected?  The data-plane-agent runs the heartbeat loop.
kubectl -n <dp-ns> get pods -l app.kubernetes.io/name=data-plane-agent
kubectl -n <dp-ns> logs deploy/<data-plane-agent> --tail=200 \
  | grep -i 'tunnel\|heartbeat\|reconnect\|disconnect'

# Runtime-scheduler view of nodes (the :8085 metrics it exposes).
kubectl -n <ns> exec deploy/<runtime-scheduler> -- wget -qO- localhost:8085/metrics \
  | grep -E 'lantern_scheduler_(nodes|active_vms|is_leader)'
```

Decide which side broke:
- **`last_heartbeat` stale but the data-plane-agent pod is Running** → network /
  tunnel path between the clusters (egress policy, expired token, LB/DNS).
- **data-plane-agent pod not Running** (CrashLoop/Pending/evicted) → the data
  plane itself is the problem; the control plane is fine.
- **`lantern_scheduler_nodes == 0` but planes heartbeat fine** → runtime-manager
  nodes aren't registering with the scheduler (different layer); check
  runtime-manager pods and the scheduler's node-registration logs.

---

## Remediation

1. **Tunnel dropped, agent healthy** → the agent self-reconnects; if it doesn't,
   restart it: `kubectl -n <dp-ns> rollout restart deploy/<data-plane-agent>`.
   Verify cross-cluster egress allows the tunnel endpoint and the join token /
   credential hasn't expired or rotated.
2. **data-plane-agent crash/pending** → triage like any pod (`describe`,
   `--previous` logs, resources, image). Recover the pod; the heartbeat resumes.
3. **Plane is genuinely gone** (decommissioned) → deregister it so it stops
   alerting and nothing routes to it: `DELETE /v1/data-planes/{id}`.
4. **`nodes == 0`** → recover the runtime-manager DaemonSet/pods on the plane;
   confirm they re-register (`lantern_scheduler_nodes` climbs off 0).

Confirm recovery: `seconds_since_heartbeat` drops back under ~30s for the plane,
`lantern_scheduler_nodes > 0`, and a test run routes to that plane and completes.

---

## Escalate

- The plane is in customer infra and the break is on their side (egress, quota,
  node pool) → coordinate with the **customer / account owner**; the control
  plane cannot fix the remote cluster.
- Tunnel auth/credential rotation is the cause → **platform on-call** (do not mint
  or rotate credentials ad hoc).
