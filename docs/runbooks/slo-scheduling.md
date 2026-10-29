# Runbook: scheduling availability and latency

> **Fires from:** `SLOErrorBudgetBurn` (SLOs: scheduling-availability, scheduling-latency), `SLOSignalAbsent` where noted.
> **Policy:** [ADR 0041](../adr/0041-slo-error-budgets.md). **Dashboard:** "Lantern SLOs and error budgets" (`lantern-slo`).

## Reading the alert

Labels carry `slo`, `severity`, `burn_rate` and `window` (long/short). `critical` = page: budget is
burning at 14.4x (1h/5m) or 6x (6h/30m), i.e. 2% to 5% of the 28-day budget is gone already.
`warning` = ticket: 3x over 1d or 1x over 3d. Open the dashboard, pick the `slo`, and check
**Error budget remaining**: below 25% the freeze rule in ADR 0041 applies.

## What the SLI measures

Runtime-scheduler `:8085/metrics`: `lantern_scheduler_schedule_total{result}` (bad = `error`; `quota` and
`standby` are not failures) and `lantern_scheduler_schedule_duration_seconds` (placement decision under 1s;
the spawn dispatch to the runtime-manager is asynchronous and is covered by
[slo-microvm-spawn.md](slo-microvm-spawn.md)). Burn alerts are suppressed below 10 schedules per hour.

## Triage

1. No leader or no nodes? `SchedulerNoLeader` / `SchedulerNoRegisteredNodes` explain most error bursts:
   [scheduler-not-firing.md](scheduler-not-firing.md), [data-plane-disconnected.md](data-plane-disconnected.md).
2. Errors with healthy leader/nodes: `kubectl logs deploy/<release>-runtime-scheduler | grep -i "placement failed"`.
   FailedPrecondition means no feasible node (capacity, confidential-compute or region constraint).
3. Latency: the placement engine reads the cluster store; check CPU throttling of the scheduler pods and
   node count growth.

## Remediation

Add node capacity, restart a wedged leader (the advisory lock moves), or fix the node registration path.

## Escalate

Page infra if placement is failing for all tenants.
