# Runbook: microVM spawn availability and latency

> **Fires from:** `SLOErrorBudgetBurn` (SLOs: microvm-spawn-availability, microvm-cold-boot-latency, microvm-restore-latency), `SLOSignalAbsent` where noted.
> **Policy:** [ADR 0041](../adr/0041-slo-error-budgets.md). **Dashboard:** "PAL SLOs and error budgets" (`pal-slo`).

## Reading the alert

Labels carry `slo`, `severity`, `burn_rate` and `window` (long/short). `critical` = page: budget is
burning at 14.4x (1h/5m) or 6x (6h/30m), i.e. 2% to 5% of the 28-day budget is gone already.
`warning` = ticket: 3x over 1d or 1x over 3d. Open the dashboard, pick the `slo`, and check
**Error budget remaining**: below 25% the freeze rule in ADR 0041 applies.

## What the SLI measures

Runtime-manager `:9466/metrics`, `lantern_manager_spawn_duration_seconds{kind,outcome}`: the time of the
backend schedule/restore call inside `RuntimeManager.Spawn`. `kind=cold` (new boot, target 95% under 5s) and
`kind=restore` (snapshot restore, 99% under 2s). Availability = outcome `ok`. Idempotent re-spawns of a live
vm_id return before this timer and are not counted.

## Triage

1. Errors: `kubectl logs deploy/<release>-runtime-manager | grep -iE "spawn|schedule failed"`. Common causes:
   KVM or jailer missing on the node, TAP/IP exhaustion, image pull failure, measurement gate refusing an
   image (ADR 0031), snapshot store unreachable (restore only).
2. Cold-boot latency: image pull time (cold node), disk pressure, host CPU saturation, many concurrent forks
   (`LANTERN_FORK_CONCURRENCY`).
3. Restore latency: snapshot store (S3/MinIO) latency or size growth; see the pause/resume notes in CLAUDE.md.
4. Only one node? Compare per-instance rates; cordon the bad node so the scheduler stops placing there.

## Remediation

Drain and replace the bad node, free host resources, or fall back to a different isolation tier.

## Escalate

Page infra on availability burn across multiple nodes.
