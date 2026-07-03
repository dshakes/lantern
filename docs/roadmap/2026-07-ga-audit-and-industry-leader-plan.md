# Lantern — GA audit findings & industry-leader plan (2026-07)

One document, three horizons: (A) what a full-repo audit found and what was fixed
immediately, (B) the near-term hardening backlog, (C) the strategic roadmap that
makes "fully intelligent agentic reasoning, actionable with confidence" a real,
scientifically-grounded differentiator rather than a tagline.

Sources: six parallel audits (Go control-plane + engines, Rust services, dashboard
UI/UX, bridges/intelligence layer, SDKs/CLI/docs) plus a competitive-landscape and
research-frontier scan (2024–2026 literature). Every code finding below carries
file:line in the audit transcripts; items marked ✅ were fixed and verified green
the same day.

---

## A. P0s found and fixed (2026-07-03)

| Area | Defect | Fix |
|---|---|---|
| WhatsApp bridge | 👎-retry ran in the CONTACT's live session (`respondTo(jid)`), polluting real conversation history | ✅ isolated `${jid}::critique` session key + regression test |
| bridge-core | `episodes.jsonl` / `topic-index.jsonl` / `auto-actions.jsonl` grew unbounded on disk | ✅ shared `trimJsonlBytes` + line caps, tested |
| TS SDK | `runs.create` sent `agent_name`; handler decodes `agentName` — every create silently made an agent-less run | ✅ fixed both create+stream paths + wire-contract test |
| Python SDK | all four `.list()` methods crashed (`.get()` on a bare JSON array) AND all models expected snake_case where the API emits camelCase | ✅ bare-array tolerant parsing + `ApiModel` camelCase alias base; 71/71 tests |
| surface-gateway | Helm readinessProbe hits `/readyz`; route didn't exist → every pod NotReady → 100% webhook outage on chart deploys | ✅ `/readyz` route added |
| model-router | response cache key had no `tenant_id` — cross-tenant response + cost-attribution leak (invariant #7) | ✅ tenant-scoped cache key |
| model-router | provider HTTP clients had no timeouts — a hung provider blocked failover forever | ✅ connect(10s)/read(60s) timeouts |
| model-router | `idempotency_key` parsed but never sent to providers (invariant #8) — retries double-billed | ✅ `Idempotency-Key` header on both providers, 4 tests |
| CLI | `lantern deploy` printed "Deployed successfully!" for a simulated pipeline | ✅ honest SIMULATED output + README relabel |
| Docs | README/quickstart documented `lantern logs --run/--vm` flags that don't exist; docs-site pointed at the wrong make target | ✅ corrected |
| TS SDK | broken `./connectors` subpath export (no such build output); `LanternApiError` not exported | ✅ removed / exported |

### Fixed same-day by the delegated batch (verify in git log)

- workflow-engine: service-token auth on :50052, tenant scoping in
  Cancel/Resume/SignalRun (cross-tenant run hijack), `ReplayFromJournal`
  attempt-key fix (crash-resume double-billing / approval hangs).
- runtime-scheduler: service-token auth on :50055 + control-plane sends it;
  node-heartbeat token fail-closed.
- services/scheduler: parameterized `set_config` (SQL-injection primitive removed),
  outbound CreateRun deadline.
- control-plane: panic recovery on session processMessage + recovery redrive;
  `canceled`→`cancelled` terminal-state fix; llm_proxy ctx/timeouts on the two bare
  branches; delivery goroutines tracked for graceful shutdown.
- harness: DNS-rebinding SSRF (resolve-once-connect-to-validated-addr), security
  audits no longer droppable under stdout flood, `is_security_audit` covers all 4
  protected kinds.
- runtime-manager: idempotent Spawn/Schedule (registry pre-check; rekey no longer
  silently overwrites) — no more double-VM on retry.
- surface-gateway: dispatcher rewired to a real, authenticated control-plane path
  (was: unauthenticated POSTs to a nonexistent endpoint, errors swallowed).
- dashboard: fabricated deploy success removed; MCP attach wired to the real API;
  SSE auto-reconnect restored (`es.close()` on error removed); silent-failure
  catches surfaced; login redirect flash; toast a11y.
- TS SDK: management-surface parity build-out (sessions/connectors/budgets/evals/
  experiments/marketplace/mcp/receipts/feedback/rehearsals/forecast) so the README
  examples are real.

---

## B. Near-term hardening backlog (P1/P2, ordered)

1. **runtime-scheduler capacity/quota integrity** (real money): atomic capacity
   reservation between `Pick()` and `CreateVM`; hint-pinned placement must not skip
   capacity checks; `Terminate` must not free quota when the manager Stop failed;
   `loadVMs` must not resurrect deleted rows; add `idempotency_key` to
   `ScheduleRequest` (proto change → `make proto`).
2. **workflow-engine lifecycle**: pinned-connection advisory locks (pgx `Acquire`),
   `Stop()` must track per-run dispatch goroutines, terminal journal writes must
   not be errcheck-ignored, fair-share query actually round-robins tenants,
   span attributes per invariant #9 (use control-plane's `EnrichSpan`).
3. **In-guest Exec RPC** (`0.0.0.0:50056`) needs authn (token or mTLS), fail-closed
   in prod — same pattern as LANTERN_GRPC_SERVICE_TOKEN.
4. **surface-gateway webhook adapters**: degraded (no-secret) mode must refuse to
   start in prod/staging instead of warn-and-accept-forged-webhooks.
5. **Harness prod guards**: `LANTERN_WORKLOAD_UID` unset should refuse startup in
   prod (mirror the other startup guards); wire or delete the dead WarmPool.
6. **model-router**: honor provider `Retry-After` on 429 (not hardcoded 1s); delete
   dead `BudgetExceeded`; OTel counter when rate-limit fail-open triggers; remove
   the `unsafe transmute` in `complete_stream` by tightening the Provider trait.
7. **Gateway**: fail-closed when JWT tenant_id fails to parse (don't silently drop
   trust-boundary metadata).
8. **runtime-manager**: snapshot save must fail on unreadable artifacts (never
   persist empty bytes as success); `spawn_blocking` for mke2fs/fs calls in
   `boot_vm`; propagate `force_kill` errors on vm-id collision.
9. **SDK/CLI truthfulness sweep**: Go SDK sessions/connectors namespaces (CLAUDE.md
   parity claim is currently false); retry/backoff (429/503, full-jitter) in all
   three SDKs — mirror `packages/bridge-core/src/retry.ts` semantics; CLI help must
   stop advertising namespaces that don't exist; `lantern test --rehearse` either
   implemented (endpoint exists) or undocumented; sdk-go module-path vs README
   `go get` check; both secondary SDK READMEs undersell shipped features.
10. **Dashboard consistency**: migrate the 9 `personal/*` pages to shared
    primitives; Modal focus trap; replace native `confirm()/prompt()` with Modal;
    notification bell = real data or removed; onboarding wizard persists step
    state; landing gets sitemap/robots/OG/canonical.
11. **Bridges**: extract the duplicated overnight/quiet-hours queue into
    bridge-core (two divergent implementations today).
12. **docs/architecture/01-overview.md** is stale vs ADR 0009 (runtime substrate
    model) — the "read this first" doc must match.
13. **Wire `RunService.SignalRun` in the control-plane** (runs.go — currently
    `Unimplemented`): the surface-gateway dispatcher now sends correct,
    authenticated SignalRun calls for surface messages and approval responses;
    they no-op until the server side lands. Also add `LANTERN_AGENT_NAME` (new,
    required) to surface-gateway's docker-compose/Helm env so dispatch knows the
    target agent.
14. **Helm chart security-env hygiene**: the chart sets no `LANTERN_ENV` and
    wires no `LANTERN_GRPC_SERVICE_TOKEN` (and doesn't deploy workflow-engine /
    runtime-scheduler at all). Prod values must set `LANTERN_ENV` so the
    fail-closed startup guards (control-plane, workflow-engine :50052,
    runtime-scheduler :50055, node-heartbeat token) actually arm, and the
    shared service token must come from a chart secret. Same for
    `LANTERN_RUNTIME_SECRET_TOKEN` / `LANTERN_SIGNAL_TOKEN` where applicable.

---

## C. Strategic roadmap — "actionable with confidence", scientifically grounded

Positioning read from the landscape scan: OpenAI's platform is bifurcating
(AgentKit deprecation), LangGraph is orchestration-only, Temporal is durability
without AI semantics, AgentCore is AWS-locked, Composio is connectors-only,
Braintrust/Langfuse are bolt-on evals. Nobody ships Lantern's closed loop
(route → run → meter → eval → receipt → improve) end-to-end. The moat is making
that loop *measurably trustworthy*. Ranked by customer value × feasibility:

1. **Calibrated per-step confidence, gated to the existing approval node.**
   Attach a calibrated confidence score (verbalized + self-consistency + logit
   signals; see arXiv 2602.05073, 2601.15778) to every side-effecting
   `journal_events` step. Above threshold → auto-execute; below → route to the
   already-built human-takeover/approval machinery. This is the literal product
   motto, implemented on infrastructure that already exists (journal, approval
   nodes, takeover). *The single highest-leverage build.*
2. **pass^k + policy-adherence eval gating** (tau2-bench pattern): run each eval
   case k times, score policy/budget adherence not just task completion, gate the
   existing HTTP-422 CI baseline on pass^k — kills flaky single-run gates and adds
   the governance scoring enterprise buyers ask for. Schema extension to
   `eval_runs.cases_result`, no new infra.
3. **Temporal-fact memory (validity windows)** for the personal layer and
   `/v1/memory`: make staleness a schema property (Zep/Graphiti pattern —
   validity-windowed facts) instead of the per-signal patches the git history
   shows (news recency, presence expiry, connectivity). Retires a whole bug class.
4. **Receipt-standard interop**: track the FIDO Agentic Auth WG / Google AP2 /
   IETF signed-agent-action drafts and make `run_receipts` emit a
   standard-compatible envelope alongside the proprietary one. Receipts are
   already Ed25519 + journal-hash — this is a wire-format layer, and the
   standards race is happening now.
5. **Look-ahead action simulation** (SafeMCP pattern): before granting a
   side-effecting tool call, reason over declared egress/tool scopes
   (`LANTERN_EGRESS_RULES`, connector scopes) about blast radius; block/escalate
   on mismatch. Extends budget hard-fail from "too expensive" to "too dangerous."
   Answers the OWASP Agentic Top 10 story enterprises now ask about.
6. **Bandit-adaptive model routing** (RouteLLM/PILOT): the reward signal
   (run_feedback, eval_runs, cost/latency per model) is already collected; add an
   online contextual-bandit layer over the static capability map in the router.
   Ship as a new strategy behind the existing strategy selector, default off,
   A/B-able via `agent_experiments`.
7. **Reflection node type** in the workflow interpreter (LATS/Agent Q): when step
   confidence (#1) is low, re-run the subgraph with a critique prompt before
   escalating to a human. New node type analogous to `condition`/`approval`.
8. **Recommendations loop** (AgentCore-style): mine `journal_events` +
   `eval_runs` + `run_feedback` to auto-propose system-prompt/tool-description
   diffs as draft `agent_versions` — never auto-applied, always through the
   existing eval gate + experiments. Closes the self-improvement loop the
   evals/experiments infra already gestures at.
9. **Tiered general-purpose memory** (Letta-style core/recall/archival): biggest
   capability gap vs a well-funded specialist; evaluate integrating
   Letta/Zep before building — the `/v1/memory` REST surface can front either.
10. **Productize the personal intelligence layer** ahead of Microsoft Scout's
    GA (Oct 2026): the bridges' anti-fabrication engineering (ground-or-abstain,
    claim verifier, bot-tell guards) is the most differentiated asset in the repo
    and directly embodies the no-fake ethos. Biggest scope jump; needs its own
    spec before any build.

### Jarvis next-gen thread

Items 1, 3, 5, 7 compose directly into the Jarvis/personal layer: temporal facts
ground what it knows, per-action confidence decides ask-vs-act (today's
`life_event_prefs` auto/ask/off becomes a *learned, calibrated* threshold),
look-ahead simulation guards its Mac/Calendar/Mail actions, reflection retries
low-confidence drafts before the owner sees them. The bridge already refuses to
fabricate (verifiable-claims, presence staleness); confidence calibration is the
same discipline made quantitative.

### Sequencing

Q3-2026: B.1–B.5 (trust-boundary + money-integrity) → C.1 + C.2 (confidence +
pass^k, the motto shipped) → C.4 (receipts interop, cheap, timing-sensitive).
Q4-2026: C.3 + C.5 + C.6 → C.7/C.8 → C.9/C.10 evaluation-then-build.

Every C-item lands behind a flag, default off, validated through the platform's
own eval/experiment gates before any tenant sees it — the platform must be the
first customer of its own "actionable with confidence" machinery.
