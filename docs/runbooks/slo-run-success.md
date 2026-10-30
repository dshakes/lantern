# Runbook: run success rate

> **Fires from:** `SLOErrorBudgetBurn` (SLOs: run-success), `SLOSignalAbsent` where noted.
> **Policy:** [ADR 0041](../adr/0041-slo-error-budgets.md). **Dashboard:** "PAL SLOs and error budgets" (`pal-slo`).

## Reading the alert

Labels carry `slo`, `severity`, `burn_rate` and `window` (long/short). `critical` = page: budget is
burning at 14.4x (1h/5m) or 6x (6h/30m), i.e. 2% to 5% of the 28-day budget is gone already.
`warning` = ticket: 3x over 1d or 1x over 3d. Open the dashboard, pick the `slo`, and check
**Error budget remaining**: below 25% the freeze rule in ADR 0041 applies.

## What the SLI measures

`pal_run_total{pal_status}` from the inline executor (`rest.go` `RecordRunTotal`). Bad = `failed`.
Microvm-tier runs are not counted yet. This SLO includes agent-logic failures, so a burn can be one broken
agent, not the platform: the first question is *concentrated or broad?*

## Triage

1. Concentrated: group failures by agent in the dashboard/Explore:
   `sum by (pal_agent_name) (rate(pal_run_total{pal_status="failed"}[30m]))`. One agent = a bad
   agent version or its connector; hand to the owner, consider rollback of that agent version.
2. Broad: follow [run-failure-spike.md](run-failure-spike.md) (provider key invalid, model-router down,
   budget 402s: [budget-402-surge.md](budget-402-surge.md)).
3. Budget denials are not failures here but look similar to users: check `pal_run_budget_blocks_total`.

## Remediation

Roll back the offending agent version or restore the provider/model-router. Runs are durable (invariant #3);
failed runs can be re-driven by the operator once the cause is fixed.

## Escalate

If more than 3 tenants are affected, treat as a platform incident.
