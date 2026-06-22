# Runbook — scheduler not firing (cron + runtime placement)

> **Audience:** on-call operators.
> **Fires from:** `SchedulerDown` (critical), `SchedulerNoLeader` (critical),
> `SchedulerScheduleErrorRateHigh` (warning), `CronScheduleOverdue` (critical).
> **Dashboards:** Lantern — Data Plane & Runtime, Platform Overview.

Two distinct "scheduling" subsystems share this runbook because both are
leader-elected tickers gated on a Postgres advisory lock:

1. **runtime-scheduler** (`:50055` gRPC / `:8085` REST+metrics) — places agent
   microVMs onto nodes. Emits real Prometheus metrics
   (`services/runtime-scheduler/internal/metrics/metrics.go`).
2. **cron scheduler** — fires time-based agent runs from the `schedules` table
   (`next_fire_at`). No in-app metric yet; its health is observed via the
   `lantern_schedules_overdue` postgres_exporter gauge.

Both are designed so exactly **one** replica holds the lock and ticks; if leader
election produces no leader, nothing fires.

---

## What fired it

- **`SchedulerDown`** — `up{job="lantern-runtime-scheduler"} == 0` for 2m. The
  scheduler `/metrics` (:8085) is unscrapable; the process is down.
- **`SchedulerNoLeader`** — `sum(lantern_scheduler_is_leader) == 0` for 3m. No
  replica holds the advisory lock. Standbys serve `result="standby"` and nothing
  is placed.
- **`SchedulerScheduleErrorRateHigh`** — Schedule RPC error fraction > 10% over
  10m. Placement is reaching the scheduler but failing.
- **`CronScheduleOverdue`** — `lantern_schedules_overdue > 0` for 5m: enabled
  schedules whose `next_fire_at` is in the past beyond the grace window. The cron
  ticker has stalled (commonly: lost/contended advisory lock).

---

## Triage

```bash
# runtime-scheduler pods + its own metrics (leader, nodes, active VMs, errors).
kubectl -n <ns> get pods -l app.kubernetes.io/name=runtime-scheduler
kubectl -n <ns> exec deploy/<runtime-scheduler> -- wget -qO- localhost:8085/metrics \
  | grep -E 'lantern_scheduler_(is_leader|nodes|active_vms|schedule_(total|errors_total))'

# Logs — leader acquisition, lock contention, placement failures.
kubectl -n <ns> logs deploy/<runtime-scheduler> --tail=200 \
  | grep -i 'leader\|lock\|placement\|schedule'
```

```sql
-- Cron: what's overdue and by how much?
SELECT id, tenant_id, agent_name, cron_expr, enabled, next_fire_at,
       now() - next_fire_at AS overdue_by
FROM schedules
WHERE enabled AND next_fire_at < now()
ORDER BY next_fire_at ASC;

-- Who holds (or is contending for) the advisory locks?  A stuck holder blocks
-- election; granted=false rows are waiters.
SELECT pid, locktype, mode, granted
FROM pg_locks
WHERE locktype = 'advisory';
```

Diagnose by signal:
- **`is_leader` sums to 0 across replicas** → election is broken. Usually a
  previous leader's session never released the lock (ungraceful kill) or all
  replicas are unhealthy. The `pg_locks` query shows a granted advisory lock
  held by a dead/zombie backend.
- **`is_leader == 1` somewhere but errors high** → election is fine; placement is
  failing. Check `lantern_scheduler_nodes` (0 → `data-plane-disconnected.md`) and
  the placement logs.
- **Cron overdue but runtime-scheduler healthy** → the cron ticker specifically
  lost its lock or its pod is down; check the cron scheduler deployment.

---

## Remediation

1. **No leader (stale advisory lock)** — restart the scheduler so a fresh
   replica re-acquires: `kubectl -n <ns> rollout restart deploy/<runtime-scheduler>`
   (or the cron scheduler deployment for `CronScheduleOverdue`). If a zombie
   backend still holds the lock, terminate it:
   ```sql
   SELECT pg_terminate_backend(pid)
   FROM pg_locks WHERE locktype = 'advisory' AND granted;  -- confirm pid first
   ```
2. **Scheduler down / CrashLoop** — triage the pod (`describe`, `--previous`
   logs, resources, DB reachability for the lock). Recover it; election resumes.
3. **High error rate with a leader** — almost always downstream: no healthy nodes
   or a degraded runtime. Follow `data-plane-disconnected.md`.
4. **One bad schedule wedging the ticker** — if a single malformed schedule
   throws every tick, disable it (`PUT /v1/schedules/{id}` enabled=false) to
   unblock the rest, then fix it.

Confirm recovery: `sum(lantern_scheduler_is_leader) == 1`, error rate back under
threshold, `lantern_schedules_overdue` returns to 0, and a test schedule fires.

---

## Escalate

- Advisory-lock contention won't clear after a restart → **DB on-call** (a
  zombie/stuck backend on the DB side) + `db-saturation.md`.
- Placement keeps failing because nodes are gone → **runtime on-call** +
  `data-plane-disconnected.md`.
