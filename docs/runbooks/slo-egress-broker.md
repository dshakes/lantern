# Runbook: egress broker errors and deny spike

> **Fires from:** `SLOErrorBudgetBurn` (SLOs: egress-broker-errors; ticket EgressBrokerDenySpike), `SLOSignalAbsent` where noted.
> **Policy:** [ADR 0041](../adr/0041-slo-error-budgets.md). **Dashboard:** "PAL SLOs and error budgets" (`pal-slo`).

## Reading the alert

Labels carry `slo`, `severity`, `burn_rate` and `window` (long/short). `critical` = page: budget is
burning at 14.4x (1h/5m) or 6x (6h/30m), i.e. 2% to 5% of the 28-day budget is gone already.
`warning` = ticket: 3x over 1d or 1x over 3d. Open the dashboard, pick the `slo`, and check
**Error budget remaining**: below 25% the freeze rule in ADR 0041 applies.

## What the SLI measures

`lantern_egress_broker_decisions_total{outcome}` on runtime-manager `:9466` (broker mode only,
`LANTERN_EGRESS_MODE=broker`, ADR 0026). `allow` and `deny` are correct decisions; `error` is a platform fault:
DNS resolution failed/timed out, upstream connect failed, or credential-resolution failed for an injecting
rule. Only `error` burns the SLO. Policy denies are deliberately *not* an SLO breach.

## Triage: `SLOErrorBudgetBurn`

1. DNS: the manager host resolver (`resolv.conf`, VPC resolver health).
2. Upstream connect failed: the destination is down, or the node's egress path (NAT, security group) is broken.
   Test from the manager host.
3. Credential resolution failed: the relay to the control-plane secret resolver (`LANTERN_CONTROL_PLANE_URL`,
   `LANTERN_RUNTIME_SECRET_TOKEN`, ADR 0008). Check the control-plane `/v1/runtime/secrets/resolve` 5xx/403s.
4. Audit trail: `egress` audit events with `decision=deny` and a `reason` attribute are in the manager log
   (`target=lantern_audit`); this identifies the failing reason and host.

## Triage: `EgressBrokerDenySpike` (ticket)

More than half of decisions over 15m are policy denies. A workload may be probing blocked hosts (security
signal: find the VM from the audit events and review the tenant) or an allowlist rule is wrong/missing after a
spec change. Do not widen an allowlist to silence this without owner review.

## Escalate

Treat a deny spike from a single tenant with private/metadata-IP reasons as a security incident.
