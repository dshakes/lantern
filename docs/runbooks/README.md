# Lantern operator runbooks

Operational runbooks for running Lantern in production. Each is written for an
on-call operator: **symptom → what fired it → triage → remediation → escalate**,
grounded in this repo's real service names, ports, and tables.

Alert rules live in [`infra/monitoring/prometheus/alerts.yml`](../../infra/monitoring/prometheus/alerts.yml);
dashboards in [`infra/monitoring/grafana/`](../../infra/monitoring/grafana/).
Each alert's `runbook:` annotation points at one of the files below.

## Index

| Runbook | Covers | Alerts |
| ------- | ------ | ------ |
| [control-plane-5xx.md](control-plane-5xx.md) | control-plane down / not-ready | `ControlPlaneDown`, `ControlPlaneNotReady` |
| [run-failure-spike.md](run-failure-spike.md) | spike in failed runs | `RunFailureRateHigh` *(TODO metric)* |
| [budget-402-surge.md](budget-402-surge.md) | budget / runtime-quota 402 surge | `SchedulerQuotaRejectionSurge`, `BudgetDenied402Surge` *(TODO)* |
| [data-plane-disconnected.md](data-plane-disconnected.md) | data-plane heartbeat stale / no nodes | `DataPlaneHeartbeatStale`, `SchedulerNoRegisteredNodes` |
| [db-saturation.md](db-saturation.md) | Postgres connection saturation | `PostgresConnectionSaturation`, `PostgresExporterDown` |
| [scheduler-not-firing.md](scheduler-not-firing.md) | runtime placement + cron not firing | `SchedulerDown`, `SchedulerNoLeader`, `SchedulerScheduleErrorRateHigh`, `CronScheduleOverdue` |
| [gateway-latency.md](gateway-latency.md) | gateway / model-router down or slow | `GatewayDown`, `ModelRouterDown`, `*P99LatencyHigh` *(TODO)* |
| [db-restore.md](db-restore.md) | Postgres backup & restore (PITR / logical dump) | — *(DR procedure, not alert-driven)* |
| [ga-staged-rollout.md](ga-staged-rollout.md) | enabling staged GA features (RLS enforce, model-router cutover, Kata, in-VM tools) | — *(enable/verify/rollback procedure)* |

## Metric reality — read this before trusting a dashboard

As of GA prep, only the **runtime-scheduler** emits Prometheus metrics
(`:8085/metrics`, six metrics + Go/process collectors). DB-derived signals
(connection saturation, data-plane heartbeat, cron overdue) come from
**postgres_exporter** over real tables — see
[`infra/monitoring/prometheus/postgres-exporter-queries.yaml`](../../infra/monitoring/prometheus/postgres-exporter-queries.yaml).
Service liveness uses `up` / blackbox `/readyz` probes.

Several SLO alerts need in-app metrics that are **not emitted yet** and are
parked, commented, in the `lantern-TODO-needs-instrumentation` group of
`alerts.yml`. They are flagged **(TODO)** above and in their runbooks. Do not
enable a TODO rule until its metric ships and the series is confirmed in
Prometheus — a rule over a non-existent series is silently always-green.

| SLO | Metric to add | Where it should be emitted |
| --- | ------------- | -------------------------- |
| control-plane 5xx rate | `lantern_http_requests_total{method,route,status}` | control-plane HTTP mux middleware + `/metrics` |
| run failure rate | `lantern_runs_completed_total{status}` | workflow-engine journal terminal status / inline run executor |
| API budget 402 surge | `lantern_budget_denied_total{reason}` | control-plane budget enforcer (runs/completions/voice) |
| gateway/model-router p99 | `lantern_{gateway,model_router}_request_duration_seconds_bucket` | Rust hot-path histogram + `/metrics` (traces only today) |

## Scrape-job naming (must match `alerts.yml`)

The alert expressions key off these Prometheus `job` labels — configure your
scrape config / ServiceMonitors accordingly:

- `lantern-runtime-scheduler` → runtime-scheduler `:8085/metrics`
- `lantern-postgres-exporter` → postgres_exporter (control-plane DB)
- `lantern-control-plane`, `lantern-gateway`, `lantern-model-router` → `up`
  liveness targets
- `lantern-control-plane-readyz` → blackbox-exporter probe of
  `http://<control-plane>:8080/readyz`
