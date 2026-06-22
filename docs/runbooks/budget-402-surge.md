# Runbook — budget / quota 402 surge

> **Audience:** on-call operators.
> **Fires from:** `SchedulerQuotaRejectionSurge` (warning, **real**),
> `BudgetDenied402Surge` (warning, **TODO**).
> **Dashboards:** Lantern — Platform Overview, Data Plane & Runtime.

Lantern enforces spend and concurrency as policy. Two distinct 402 paths exist:

1. **Runtime quota** — `POST /v1/runtime/schedule` refuses a microVM when the
   tenant is over its max-concurrent-VM cap. Surfaced by the **real** metric
   `lantern_scheduler_schedule_total{result="quota"}` from the runtime-scheduler.
2. **Agent budget** — `POST /v1/runs`, `/v1/completions`, and voice refuse with
   402 when a hard-fail `agent_budgets` limit (cost/day, cost/run, tokens/day,
   runs/day, per-tool) is exceeded. This path has **no metric yet** (TODO).

A surge of 402s is usually one of: an intentional cap doing its job under real
load, a runaway agent burning budget, or a stuck-VM leak inflating the
concurrency count so legitimate runs are starved.

---

## What fired it

- **`SchedulerQuotaRejectionSurge`** (real) —
  `rate(lantern_scheduler_schedule_total{result="quota"}[15m]) > 0.2` for 15m.
  Tenants are repeatedly hitting the per-tenant microVM cap.
- **`BudgetDenied402Surge`** (TODO) — depends on `lantern_budget_denied_total`,
  a counter **not emitted yet**. Add it on the 402 branches of the budget
  enforcer in `services/control-plane/internal/handlers` (runs, completions,
  voice), expose on `/metrics`, then uncomment the rule in
  `infra/monitoring/prometheus/alerts.yml`.

---

## Triage

**Runtime quota (real path):**

```bash
# Is it one tenant or many?  Per-tenant quota + today's usage.
curl -s -H "Authorization: Bearer <jwt>" http://<cp>:8080/v1/runtime/quota

# How many VMs does the scheduler think are live?  A leak inflates this.
#   lantern_scheduler_active_vms (gauge) on :8085/metrics.
kubectl -n <ns> exec deploy/<runtime-scheduler> -- wget -qO- localhost:8085/metrics \
  | grep lantern_scheduler_active_vms
```

```sql
-- Stuck VMs: non-terminal for a long time inflate the concurrency count.
SELECT id, tenant_id, state, created_at
FROM vms
WHERE state NOT IN ('terminated','failed','stopped')
  AND created_at < now() - interval '1 hour'
ORDER BY created_at;
```

**Agent budget (until the metric ships):**

```sql
-- Which agents are over / near their daily cap today?
SELECT b.tenant_id, b.agent_name, b.max_cost_usd_per_day, b.hard_fail,
       u.cost_usd AS cost_today, u.runs_count
FROM agent_budgets b
JOIN agent_usage_daily u
  ON u.tenant_id = b.tenant_id AND u.agent_name = b.agent_name
 AND u.usage_date = current_date
WHERE b.hard_fail
  AND u.cost_usd >= 0.8 * b.max_cost_usd_per_day
ORDER BY u.cost_usd DESC;
```

---

## Remediation

1. **Stuck-VM leak inflating concurrency** → drain the stuck VMs
   (`DELETE /v1/runtime/vms/{id}?grace=30s`); the real fix is rooting out why
   they never reached terminal — see `data-plane-disconnected.md`. Do this
   before raising the cap.
2. **Legitimate load growth** → raise the cap deliberately, with the owner's
   sign-off: `PUT /v1/runtime/quota` (runtime) or `PUT /v1/agents/{name}/budget`
   (agent budget). Caps exist on purpose — raise, don't remove.
3. **Runaway agent burning budget** → the 402 is *protecting* the tenant. Do not
   raise the budget; investigate the agent (a loop, a retry storm). Pair with
   `run-failure-spike.md` if it's also erroring.

Confirm recovery: `result="quota"` rate trends to ~0; `active_vms` matches the
true count of running VMs.

---

## Escalate

- A tenant is blocked by a cap and the business wants it raised → **account
  owner / platform on-call** for the deliberate cap change (do not self-approve a
  budget bump for someone else's tenant).
- VMs leak faster than you can drain them → **runtime on-call** +
  `data-plane-disconnected.md`.
