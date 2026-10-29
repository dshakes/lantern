# Runbook: control-plane API availability and latency

> **Fires from:** `SLOErrorBudgetBurn` (SLOs: control-plane-api-availability, control-plane-api-latency), `SLOSignalAbsent` where noted.
> **Policy:** [ADR 0041](../adr/0041-slo-error-budgets.md). **Dashboard:** "Lantern SLOs and error budgets" (`lantern-slo`).

## Reading the alert

Labels carry `slo`, `severity`, `burn_rate` and `window` (long/short). `critical` = page: budget is
burning at 14.4x (1h/5m) or 6x (6h/30m), i.e. 2% to 5% of the 28-day budget is gone already.
`warning` = ticket: 3x over 1d or 1x over 3d. Open the dashboard, pick the `slo`, and check
**Error budget remaining**: below 25% the freeze rule in ADR 0041 applies.

## What the SLI measures

`http_server_request_duration_seconds` (otelhttp) on the control-plane `:9464` listener, restricted to
`lantern_traffic="api"` (health probes and SSE/log streams are excluded: a stream's duration is its lifetime,
not latency). Availability = not a 5xx. Latency = answered within 1s (`le="1"` bucket).

## Triage

1. Is it a total outage? `ControlPlaneDown` / `ControlPlaneNotReady` would also be firing: use
   [control-plane-5xx.md](control-plane-5xx.md) and [db-saturation.md](db-saturation.md).
2. Partial 5xx: find the route. The metric has no route label, so use traces
   (`http.response.status_code=5xx`, group by span name `METHOD /v1/...`) or
   `kubectl logs deploy/<release>-control-plane | grep '"status":5'`.
3. Latency burn with a healthy 5xx rate: check Postgres (`pg_stat_activity` waiting, pool saturation per
   [db-saturation.md](db-saturation.md)), then the model-router seam if `LANTERN_USE_MODEL_ROUTER` is on
   (see [slo-model-router-errors.md](slo-model-router-errors.md)).
4. Recent deploy or flag flip (`LANTERN_RLS_ENFORCE`, `LANTERN_AUTHZ_ENFORCE`)? Roll back first, debug after:
   [ga-staged-rollout.md](ga-staged-rollout.md), [rls-flip.md](rls-flip.md).

## Remediation

Roll back the last control-plane release, scale replicas if CPU-bound, fail over / restore the database per
[db-restore.md](db-restore.md). Confirm recovery: the 5m burn rate drops below 1 on the dashboard.

## `SLOSignalAbsent`

The SLI has no series for 30 minutes, so the burn alerts cannot fire. Check that Prometheus scrapes
`:9464` with job `lantern-control-plane` (the `job` in `monitoring.slos.<name>.job`), that the NetworkPolicy
`allow-metrics-scrape` admits your Prometheus namespace, and that `LANTERN_METRICS_ADDR` is not disabled.

## Escalate

Page the platform owner if the page-tier alert is still firing 30 minutes after a rollback.
