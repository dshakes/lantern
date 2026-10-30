# ADR 0041 — SLOs, error budgets and burn-rate alerting

- Status: Accepted
- Date: 2026-10-29
- Scope: control-plane, runtime-scheduler, model-router, runtime-manager, Helm chart, runbooks

## Context

Alerting before this ADR was liveness (`up`, `/readyz`) plus a few fixed-threshold
rules in `infra/monitoring/prometheus/alerts.yml`. There were no stated reliability
targets, so nobody could say whether the platform was "good enough", when to stop
shipping features, or which alert deserved a 3am page. Several SLIs had no metric at
all: the Rust services (model-router, runtime-manager) exported traces only.

## Decision

1. **Ten SLOs over a 28-day window**, each defined once in `monitoring.slos` in the Helm
   values (SLI = `bad / total`, objective, job, runbook). Everything else (recording
   rules, alerts, thresholds) is generated from that list by
   `templates/monitoring/prometheusrule.yaml`, so a target change is a one-line edit.

   | SLO | Objective | SLI (metric) |
   | --- | --------- | ------------ |
   | control-plane-api-availability | 99.9% | non-5xx of API requests (`http_server_request_duration_seconds_count`, `pal_traffic="api"`) |
   | control-plane-api-latency | 99% | API requests under 1s (same histogram, `le="1"`) |
   | run-success | 98% | `lantern_run_total{lantern_status}` (failed vs all) |
   | scheduling-availability | 99.5% | `lantern_scheduler_schedule_total` error vs ok+error |
   | scheduling-latency | 99% | `lantern_scheduler_schedule_duration_seconds` under 1s (new) |
   | model-router-errors | 99.5% | `lantern_model_router_requests_total{outcome}` (new) |
   | microvm-spawn-availability | 99.5% | `lantern_manager_spawn_duration_seconds_count{outcome}` (new) |
   | microvm-cold-boot-latency | 95% | cold boots under 5s (new) |
   | microvm-restore-latency | 99% | snapshot restores under 2s (new) |
   | egress-broker-errors | 99.5% | `lantern_egress_broker_decisions_total{outcome="error"}` (new) |

   Targets are deliberately set below what a healthy system delivers today and were
   chosen without production history; review them after the first full 28-day window.

2. **Alerts are multi-window, multi-burn-rate** (SRE workbook): page at 14.4x over
   1h and 5m, page at 6x over 6h and 30m, ticket at 3x over 1d and 2h, ticket at 1x
   over 3d and 6h. Both windows must exceed the threshold, so a burst that has already
   ended does not page (unit-tested). Sparse SLOs carry `minEventsPerHour` so one
   failure in a quiet hour is not a 100% burn.

3. **New instrumentation, minimal and in each service's own style.**
   - runtime-scheduler: `lantern_scheduler_schedule_duration_seconds{result}` histogram (client_golang).
   - control-plane: `pal.traffic` attribute (`api|probe|stream`) on the existing otelhttp metric so
     health probes and SSE/log streams (whose duration is the connection lifetime) do not pollute the API SLIs.
   - model-router and runtime-manager (Rust, previously no metrics): `prometheus` 0.14 with
     `default-features = false` (no protobuf dependency), a small `metrics.rs` per service, and an opt-in
     scrape listener on `PAL_METRICS_ADDR`. Unset = no port opened. The two
     `metrics.rs` files are duplicated on purpose: service Docker build contexts are the service directory,
     so a shared path crate would break the image builds.
     Ports: model-router 9465, runtime-manager 9466. The listener serves only `GET /metrics`.
   - Egress broker deny vs error: a policy deny is correct behaviour and counts as *good*; only platform faults
     (DNS, upstream connect, credential resolution) burn the SLO. A sustained majority-deny rate raises a
     separate ticket, `EgressBrokerDenySpike`, because it is a security signal rather than a reliability one.

4. **Delivery.** `monitoring.alerts.enabled` renders a `PrometheusRule` (needs the prometheus-operator CRDs,
   off by default, on in `values-prod.yaml`); `monitoring.dashboards.enabled` renders a Grafana dashboard
   ConfigMap (`pal-slo`). Every alert has a `runbook_url` to `docs/runbooks/slo-*.md`.
   Rules are verified by `infra/monitoring/prometheus/check-slo-rules.sh` (`promtool check rules` and
   `promtool test rules` over the rendered chart).

## Error-budget policy

Budget remaining is `slo:error_budget_remaining:ratio` (28d).

| Remaining | Action |
| --------- | ------ |
| above 50% | Normal feature work. |
| 25% to 50% | Reliability fixes for the burning SLO are prioritised in the next planning cycle; risky rollouts (flag flips such as RLS or authz enforcement) need an explicit owner call. |
| below 25% | Feature releases touching the affected service pause. Only reliability fixes, reverts and security patches ship until the budget recovers above 25%. |
| exhausted (below 0) | Freeze as above, plus a blameless post-incident review within 5 working days; the review either fixes the cause or amends the SLO with a written reason. |

A page-tier alert needs a human acknowledgement and a runbook-driven mitigation; a ticket-tier alert is
triaged within one working day. Emergency changes (security patches) are exempt from the freeze.

## Consequences

- Reliability is now a number with an owner. The legacy fixed-threshold rules stay for liveness; the burn
  alerts supersede `ControlPlane5xxRateHigh` and `RunFailureRateHigh` in practice and those can be retired
  once the SLO alerts have run clean for one cycle (not done here, to avoid a gap).
- The gateway and workflow-engine still emit traces only, so there is no SLO for the SSE/token streaming path
  or durable-run latency. This is the largest remaining blind spot (follow-up).
- The run-success SLI counts agent-logic failures, so a single bad customer agent can burn it. Per-agent
  labels exist in the metric, so a tenant/agent-excluded variant is possible; it was left out to avoid an
  unbounded exclusion list.
- Restore latency covers `Spawn` with a restore id; the standalone `Restore` RPC helper is not timed yet.
- Alerts only fire where the SLI has data. `SLOSignalAbsent` guards the two control-plane SLOs; a fully down
  service is caught by the existing `*Down` alerts rather than by burn alerts.
- Prometheus must scrape the new ports; the NetworkPolicy `allow-metrics-scrape` now admits 9465 and 9466.
  Scrape `job` names are assumed (`pal-*`, `lantern-*` still matched) and overridable per SLO.
- Cardinality: all new metrics use bounded label sets (method, outcome, kind, result); no tenant or VM ids.
