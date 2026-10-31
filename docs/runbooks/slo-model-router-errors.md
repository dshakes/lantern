# Runbook: model-router error rate

> **Fires from:** `SLOErrorBudgetBurn` (SLOs: model-router-errors), `SLOSignalAbsent` where noted.
> **Policy:** [ADR 0041](../adr/0041-slo-error-budgets.md). **Dashboard:** "PAL SLOs and error budgets" (`pal-slo`).

## Reading the alert

Labels carry `slo`, `severity`, `burn_rate` and `window` (long/short). `critical` = page: budget is
burning at 14.4x (1h/5m) or 6x (6h/30m), i.e. 2% to 5% of the 28-day budget is gone already.
`warning` = ticket: 3x over 1d or 1x over 3d. Open the dashboard, pick the `slo`, and check
**Error budget remaining**: below 25% the freeze rule in ADR 0041 applies.

## What the SLI measures

`pal_model_router_requests_total{method,outcome}` on model-router `:9465`. Bad = `outcome="error"`:
gRPC `Internal`, `Unavailable`, `DeadlineExceeded`, `Unknown`, `ResourceExhausted`, `DataLoss` (all providers
failed, rate-limited, timed out). `client` outcomes (invalid argument, auth) are excluded. Only active when
the control-plane routes through the router (`PAL_USE_MODEL_ROUTER`), otherwise direct provider calls
bypass this SLI. Latency is exported (`..._request_duration_seconds`) but not an SLO: it is provider-bound.

## Triage

1. Which provider? Router logs name the failing provider (`all providers failed for capability ...`).
   Check the vendor status page and the tenant's key validity (`POST /v1/settings/llm-providers/{p}/test`).
2. Rate limits (`ResourceExhausted`): see per-tenant provider quota; consider adding a second provider key so
   failover has a target.
3. Router unhealthy (OOM, restarts): `kubectl get pods -l app.kubernetes.io/component=model-router`; gateway
   latency runbook: [gateway-latency.md](gateway-latency.md).

## Remediation

Control-plane falls back to the direct provider path automatically when the router errors, so user impact may
be lower than the burn suggests. If the router itself is at fault, set `PAL_USE_MODEL_ROUTER` off
([ga-staged-rollout.md](ga-staged-rollout.md)) while you fix it.

## Escalate

Provider-wide outage: communicate, nothing to fix on our side beyond failover.
