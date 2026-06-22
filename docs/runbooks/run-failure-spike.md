# Runbook — run failure-rate spike

> **Audience:** on-call operators.
> **Fires from:** `RunFailureRateHigh` (critical) — **currently TODO**, see below.
> **Dashboards:** Lantern — Platform Overview.

A run is one execution of an agent. A spike in failed runs means agents are
erroring for a class of input, a dependency (model-router, a connector, the
runtime) is degraded, or a bad agent version was promoted.

---

## Status of this alert (READ FIRST)

`RunFailureRateHigh` is **not active yet**. It depends on
`lantern_runs_completed_total{status="failed"}`, a counter that is **not emitted
today**. The rule is parked, commented, in the
`lantern-TODO-needs-instrumentation` group of
`infra/monitoring/prometheus/alerts.yml`.

**To ship it:** emit `lantern_runs_completed_total{status}` (status =
`succeeded|failed|cancelled`) where the run terminal status is written — the
workflow-engine journal (`KindRunFailed` / `KindRunCompleted`,
`services/workflow-engine/internal/journal/event_kinds.go`) or the control-plane
inline run executor. Expose it on a `/metrics` endpoint, confirm the series in
Prometheus, then uncomment the rule.

Until then, run health is observed from the database and logs (below), not a
Prometheus series.

---

## Triage (works today, via the DB)

Runs live in the `runs` table; the event-sourced log is `journal_events`.

```sql
-- Failure rate over the last 30 min, all tenants.
SELECT
  count(*)                                        AS total,
  count(*) FILTER (WHERE status = 'failed')       AS failed,
  round(100.0 * count(*) FILTER (WHERE status = 'failed') / nullif(count(*),0), 1) AS pct_failed
FROM runs
WHERE created_at > now() - interval '30 minutes';

-- Which agents / versions are failing?  Concentration points at a bad deploy.
SELECT agent_id, count(*) AS failed
FROM runs
WHERE status = 'failed' AND created_at > now() - interval '30 minutes'
GROUP BY agent_id ORDER BY failed DESC LIMIT 20;
```

```bash
# Tail the run executor / workflow-engine for the error class.
kubectl -n <ns> logs deploy/<control-plane> --tail=200 | grep -i 'run.*fail\|error'
kubectl -n <ns> logs deploy/<workflow-engine> --tail=200
```

Inspect a representative failing run's journal for the failing step:

```sql
SELECT seq, kind, step_id, payload
FROM journal_events
WHERE run_id = '<failing-run-id>'
ORDER BY seq;
```

---

## Remediation

1. **Failures concentrated on one agent version** (just promoted) → roll back to
   the prior `agent_versions` version / undo the experiment promotion. This is
   the most common cause of a sudden spike.
2. **Failures span all agents** → a shared dependency is down. Check
   `gateway-latency.md` (model-router) and the connector being called. A
   model-router outage shows as every LLM step failing.
3. **Failures are budget 402s, not errors** → not a failure spike; go to
   `budget-402-surge.md`.
4. **Failures are runtime placement** (`failed to schedule`) → go to
   `scheduler-not-firing.md` / `data-plane-disconnected.md`.

Confirm recovery: the SQL failure-rate query trends back to baseline.

---

## Escalate

- A bad agent version is in production and rollback is unclear → the owning
  team / **platform on-call**.
- Shared dependency outage (model-router, runtime) → its respective runbook +
  **platform on-call**.
