# ADR 0056 — Post-deployment agent observability: trace tree, production evals, per-agent SLOs, anomaly incidents

Status: accepted (Phase 7 of the agent lifecycle plan)

## Context

After an agent ships, an owner must be able to answer "what did this run do", "is this agent
healthy", "did the new version make it worse" and "who is dealing with it" without reading
logs. We already have the raw material: `journal_events` (event-sourced run log), OTel spans,
`eval_runs`, `run_feedback`, the ADR 0052 LLM judge, and the ADR 0041 burn-rate rules. What is
missing is the product on top of them. No new database (CLAUDE.md).

## Decisions

1. **Trace tree is a read-time fold of the journal.** `GET /v1/runs/{id}/trace` builds a tree
   (steps, LLM calls with model/tokens/cost/latency, tool calls with args and result, retries,
   child runs) in `internal/obs`, a pure package. The only new journal fact is a `tool_call`
   event (tool name + arguments) emitted by the workflow interpreter for `tool` and `connector`
   nodes. Step latency is the delta of journal row timestamps.
   *Tenant isolation:* `journal_events` is RLS-exempt (no `tenant_id`), so the run-row ownership
   check (`runs.id AND tenant_id`, inside `WithTenant`) is the gate. A run in another tenant,
   a missing run and a malformed id are all `404`. Child runs are fetched with the same filter.
   *Secrets (invariant #10):* arguments are redacted twice: when written (`obs.Redact` in the
   interpreter) and again on every read, by key name (`api_key`, `authorization`, `*token`,
   `secret`, `password`, `credential`, ...) and by value shape (provider keys, bearer tokens,
   JWTs, cloud keys, `pal.secret/` refs, `password=`). Strings are length-bounded. `tokens_in`
   and `max_tokens` are deliberately not treated as secrets.
2. **Production evals are opt-in, sampled and budget-metered.** Per agent
   (`prod_eval_config`): `enabled` (default false), `sample_rate`, rubric, judge model,
   `daily_budget_usd`. Sampling is a stable hash of the run id, so it is reproducible and needs
   no RNG state. The judge is the ADR 0052 `evalJudge` with the producing model excluded
   (maker is not checker). Judge cost is capped per agent per day and also recorded with
   `RecordUsageSpend`, so it counts against the agent's budget. A judge error or a prompt-injection
   suspicion stores no score. Score drift per version: versions ordered by first scored run;
   flagged when the mean fell at least 0.05 and at least two standard errors versus the previous
   version (n at least 5 each).
3. **Per-agent SLOs are event ratios, evaluated in the application.** `agent_slos`:
   one objective (default 95%) shared by four SLIs: success, latency (under a target), cost per run
   (under a target) and eval score (at least a minimum). Each SLI is good/bad events, so one
   error-budget and burn-rate implementation serves all four. The multi-window table is the ADR
   0041 table unchanged (14.4x 1h/5m, 6x 6h/30m, 3x 1d/2h, 1x 3d/6h; both windows must exceed;
   minimum 20 events so a quiet hour cannot page).
   *Why not Prometheus:* ADR 0041 requires bounded label sets; a tenant/agent label is unbounded.
   Per-agent burn is therefore computed from `runs` on demand and by the sweep, using the same
   rules and constants. Platform SLOs stay in Helm/Prometheus.
4. **Anomaly detection is statistics, not a model.** Baseline = the agent's finished runs from the
   previous 7 days (excluding the recent window); recent = last 2 hours grouped by agent version
   (`PAL_OBS_RECENT_WINDOW`, `PAL_OBS_BASELINE_WINDOW`). Cost, latency and tool-call count use
   median vs baseline median with a MAD-based robust z (floored at 5% of the median so a perfectly
   flat baseline cannot make noise infinite); a finding needs z >= 4 AND a rise of at least 50%.
   Score needs z <= -4 AND a drop of at least 0.15. Error rate is a one-sided proportion z >= 4 AND
   at least 15 points higher. Minimums: 20 baseline runs, 5 recent runs per version. A metric with a
   zero baseline median is skipped (relative change undefined; this also keeps pre-`tool_call` history
   from flagging every new run). All thresholds live in `obs.DefaultThresholds`.
5. **Incidents.** An anomaly or an SLO page/ticket alert opens one row in `agent_incidents`
   (unique per tenant + agent + kind while not resolved, so repeats are absorbed). It records the
   first-bad version (earliest-appearing anomalous version), last-good version, a deterministic
   suspected cause (deploy correlation vs. same version), affected run ids and the numeric
   evidence. A model may only write the summary: the text is accepted only if it cites runs as
   `[run:<id>]`, every cited id belongs to the incident and no other UUID appears; otherwise the
   deterministic summary stands (`summary_source` says which). Detection never calls a model.
6. **Audit.** Acknowledge and resolve update the row and append to `agent_incident_events` in one
   transaction (actor, action, note); illegal transitions are `409` and write nothing. The same
   table is the timeline.
7. **Rollback interface (wiring deferred).** An incident carries `rollback {suggested, fromVersion,
   toVersion, reason}` and `ObsHandler.SetRollbackSink(RollbackSink)` is called once when a new incident
   suggests one. Nothing here depends on the Phase 6 promotion code. **Follow-up:** the canary/rollback
   controller implements `RollbackSink` (or polls `GET /v1/incidents`) and shows a one-click rollback.
8. **Operations.** A background sweep (`PAL_OBS_INTERVAL`, default 5m, `off` disables; writer-only)
   scans tenants with recent runs; `POST /v1/incidents/scan` runs it on demand. The sweep lists
   tenant ids with the privileged pool (annotated `rls-exempt`); everything else is `WithTenant`.
   Tables: `agent_slos`, `prod_eval_config`, `prod_eval_scores`, `agent_incidents`,
   `agent_incident_events`, all RLS-forced (migration 0040).

## Consequences

- Cost: one extra journal row per tool/connector step; the sweep reads at most 20k runs per agent.
  Ceiling noted in code (`loadStats`); move to SQL aggregates if exceeded.
- Anomaly detection needs history: agents with fewer than 20 baseline runs never alert (by design).
- The model summary and the production-eval judge were verified only against fixtures; see the PR
  for the explicit UNVERIFIED note on real-provider behaviour.
- Rollback is suggested, never performed, by this phase.
