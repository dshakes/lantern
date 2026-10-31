# ADR 0054 — Agent promotion: environments, approval, canary, rollback

- Status: Accepted
- Date: 2026-10-31
- Scope: control-plane `internal/handlers/{promotion,promotion_logic,agent_snapshot}.go`, migration `0037_agent_promotion`, `runs.go` (version routing), `eval_runner.go` (evidence stamping), CLI `pal freeze|promote|approve|reject|rollback|canary|promotions|sandbox`, dashboard Deployments page, `scripts/e2e-agent-promotion.sh`
- Plan: AGENT-LIFECYCLE-PLAN Phase 6; builds on ADR 0052 (hermetic evals, 422 gate) and 0053 (`pal ci`)

## Context

`pal deploy` upserts a mutable agent and "deploys" it; there was no immutable
version of a tool-loop agent (the executor read the live `agents` row), no
environments, no approval, and `agent_experiments` never routed a run
(`PickVariant` had no caller). Anything that "promoted" changed production for
everyone at once.

## Decision

**The model proposes; deterministic gates and a human decide.**

### Versions are frozen content
`pal freeze` snapshots the working copy (prompt, model, workflow) into an
`agent_versions` row (`manifest.snapshot`, digest = SHA-256 of the canonical
snapshot). Same content returns the same version (idempotent); freezing never
moves traffic. The run executor and the eval runner execute the **snapshot of
the version a run/eval is bound to**; versions without a snapshot (legacy) run
the working copy as before.

### Environments
`agent_environments (tenant, agent, env in sandbox|staging|prod)` each point at
one version. An agent with a `prod` row is served from it (stable version, or
the canary split); an agent that never used environments keeps
`current_version_id` unchanged. The first prod promotion adopts the live
version as stable. Prod promotions also sync `current_version_id` so A2A cards
and receipts agree.

### Gates (`promotion_logic.go`, pure, fail closed)
`POST /v1/agents/{name}/promote`: the version exists; it is active in an earlier
environment (sandbox → staging → prod); staging/prod need a **server-run**
hermetic eval of exactly that content, passing every case, fresher than 24h and
not regressed against the env's baseline (`eval_baselines`, branch = env name,
re-pinned on each successful promotion); the agent is within budget
(`CheckBudget`, unreadable budget = fail). `PAL_PROMOTE_REQUIRE_SANDBOX_RUN=1`
additionally requires a recorded successful sandbox microVM run for prod.
Evidence is `eval_runs.source='hermetic'` stamped by `RunSuite`, bound to a
version by **content digest** (`draft:<digest>` if nothing frozen matches); a
caller-supplied `agentVersion` or a client-posted `/v1/eval-runs` row can never
satisfy a gate. A blocked attempt is audited.

### Approval
Prod always needs approval (other envs on request). A principal is classified
from verified claims only: API keys are `agent`, owner/admin sessions are
`human`. Only a human owner/admin may `approve`/`reject`; the gates are re-run at
approval time. Approval is idempotent (replay returns the applied promotion, one
audit row) and records `approver`/`approved_at`. One open (pending or canary)
promotion per (agent, env) is enforced by a partial unique index. The onboarding
agent's tool is `pal promote contract` (`propose_promotion`); approve/reject/
skip-gates are not in it.

### Canary and rollback
`--canary N` (prod, 1-99) creates an `agent_experiments` row (a = stable,
b = candidate, FNV-1a split on the run id, the existing machinery) linked from
the environment. `RunService.CreateRun` resolves the version through the
environment; routed runs carry `pal.variant` labels. Guards
(`maxErrorRate`, `maxCostRatio` vs stable, `minEvalScore`, `minRuns`) are
evaluated from real `runs` rows and newer hermetic evals, by
`POST .../canary/evaluate` and a 30s background loop. A trip rolls back
automatically (experiment concluded for stable, canary aborted); a pass over
`minRuns` completes the rollout. A guard cannot trip before 5 terminal runs.
**Rollback** (`pal rollback`, `POST .../environments/{env}/rollback`) is one call,
open to any `agents:write` principal (the safe direction), idempotent (the
promotion row is locked; an already rolled-back promotion returns `noop` and
writes nothing; concurrent calls produce exactly one audit row).

### Audit
`agent_promotion_audit` is append-only (trigger refuses UPDATE/DELETE; the only
exception is GDPR erasure, which sets a transaction-local flag), tenant RLS, one
row per decision (`promote_requested|blocked`, `approved`, `rejected`,
`canary_started|passed`, `promoted`, `rolled_back`, `version_frozen`,
`sandbox_run`), written in the same transaction as the state change. Spans carry
`pal.agent_name/env/promotion.action/actor_kind`.

### Sandbox e2e
`pal sandbox run <agent> --spec agent.yaml` promotes to sandbox, schedules the
AgentSpec through `/v1/runtime/schedule` (invariant #5; a stub scheduler is
refused), waits for `running`, executes the command via `/v1/runtime/vms/{id}/exec`,
records VM id / exit code / output hash as sandbox evidence (the VM must belong to
the tenant), and terminates the VM.

Measured (Lima/Firecracker, jailed, mTLS manager, own scheduler on :8585, 2026-10-31):
`pal sandbox run hello --exec "/bin/sh -c uname"` -> promoted to sandbox, real microVM booted,
exec returned `Linux`, exit 0, 6.9 s end to end including promote, schedule, boot and exec; evidence
and audit row recorded. Lima dev tooling fixes made on the way: `lima.sh runtime` forwards
`SCHEDULER_URL`, mints a throwaway VM signing CA (a real boot failed without one), and accepts
`DEV_TLS_DIR` for an mTLS manager (the harness heartbeat is TLS; a plaintext manager made exec
impossible: "harness not connected"). The guest rootfs is minimal: exec needs `/bin/sh -c ...`, not `echo`.

## Threat notes
- Approval cannot be reached by API keys, kiosk sessions or agents; the check uses
  signed claims, never a header or body field.
- Evidence forgery (client-posted eval rows, claimed versions, label reuse) is closed by
  `source` + digest binding; mutation-tested.
- Cross-tenant: all tables RLS-forced; approving/reading another tenant's promotion is 404.
- Gate decisions and audit details contain identifiers and counts only, no prompts or secrets.
- A canary tripped by a *poisoned signal* (someone failing runs) can only roll back to the
  stable version, the safe direction.

## Known limits / not done
- Guard stats use `runs` status/cost; per-run eval scoring on live traffic is not sampled
  (a newer hermetic eval of the canary is the eval guard).
- Frozen versions pin prompt, model and workflow only. Labels/tools/connectors/MCP attachments
  still come from the live agent row, so those are not immutable per version.
- Interactive sessions (`sessions.go`) and the bridges read the live agent row: `pal deploy`
  changes session behaviour immediately, outside promotion. Only runs are version-routed.
- Sandbox-run evidence (`PAL_PROMOTE_REQUIRE_SANDBOX_RUN`) is self-reported by the caller (the
  VM must exist in the tenant); treat that gate as advisory until the server records its own exec.
- A requester may approve their own request (no maker/checker split), and an owner session driven
  by an LLM counts as human. Use a dedicated agent API key for the onboarding agent.
- Rollback does not re-pin the env's eval baseline to the restored version.
- Freezing is refused for an agent with no system prompt and no workflow (template-backed agents
  need an explicit prompt first); canary guards are bounded (error rate <= 0.5, cost ratio <= 10,
  minRuns >= 5) so a proposer cannot configure a guard that cannot trip.
- A promotion canary's experiment cannot be concluded through `/v1/experiments/{id}/conclude`.
- Variant stats struct is serialized without JSON tags (`Terminal`, `Failed`, `AvgCost`).
- Workflow-agent hermetic evals remain unsupported (ADR 0052), so workflow versions
  cannot pass the eval gate yet.
- Existing `agent_experiments` created by hand still do not route runs; only
  environment canaries do.
- Sandbox e2e runs the agent's AgentSpec workload in the VM; tool-loop LLM agents execute in
  the control plane (model router), not inside the VM.
