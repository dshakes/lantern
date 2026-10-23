# Lantern GA Readiness — validation matrix

A faithful go/no-go checklist: what is validated, how, and what still needs a human
hand before a true "ship to the world" claim. Updated 2026-10-23 to reflect GA phases 0–3 and the `ga-nextgen` hardening wave (roadmap: `docs/roadmap/2026-10-nextgen-sandbox-and-harness.md`).

The guiding rule: **"compiles" ≠ "validated."** A green build that still 404s in a
browser (as the docs basePath bug did) is not validated. Each row says how the
claim was actually checked.

## Legend
- ✅ **Validated** — exercised and asserted (test/integration/live), evidence noted.
- 🟡 **CI-only** — verified by CI but not reproducible on the current dev host (no
  browser); trustworthy but second-hand.
- 🔴 **Needs human** — requires access this environment doesn't have (paired
  phones, a browser, a billing account, a real cluster).

---

## Core platform (control plane)

| Area | Status | How validated |
|---|---|---|
| Control-plane Go suite (agents, runs, sessions, budgets, RLS, crash-replay, scheduler, secrets, workflow) | ✅ | `go test ./...` green across all control-plane packages |
| RLS policies on all 34 tenant tables (ADR 0011) | ✅ | `TestRLSEnforcement_AllTenantTables` catalog gate + `TestRLSEnforcement_Sessions` cross-tenant denial proof under `lantern_app` role |
| RLS handler cutover (`WithTenant`/`TenantPool()`) | ✅ | 0 non-exempt tenant-scoped `srv.Pool` sites remain in `internal/handlers`; every remaining site carries an `rls-exempt:` reason. `RLS*` tests + `go test -race -run RLS` green; workflow-engine tenant work also scoped (`TestRLSCatalog_NoUnscopedTenantQueries`) |
| RLS enforcement flip (`LANTERN_RLS_ENFORCE=1`) | 🟡 staged | Safe to flip per-env (set `LANTERN_APP_DB_PASSWORD`, `ALTER ROLE lantern_app`); not yet flipped in any environment. Check `lantern_app` GRANTs for the engine tables first. |
| Prod guards (Helm `LANTERN_ENV=production` default, `JWT_SECRET` wired, `values-prod.yaml`; Twilio-auth-off / claude-code fatal; Slack unsigned refused; API-key scope subset) | ✅ | Go guard tests; `helm template` renders with real subcharts for values / staging / prod |
| Tenant-wide spend cap + workflow/`web_search` metering | ✅ | handler tests for `/v1/budgets/tenant`, `RecordUsageSpend` (no `runs_count` bump), per-request LLM idempotency keys |
| gRPC service-token auth (control-plane `:50051`, workflow-engine `:50052`, scheduler `:50055`, model-router `:50053`, runtime-manager `:50054`) | ✅ | Go `grpcauth` tests + Rust interceptor tests; fail-closed in prod |
| Handler tests — auth, sessions, connectors (+24 DB-backed) | ✅ | Cross-tenant isolation asserted; credential round-trip verified; load-bearing assertions confirmed to fail on broken code |
| LLM idempotency keys (invariant #8) | ✅ | `llm_idempotency_test.go` green; `Idempotency-Key` header on OpenAI + Anthropic calls |
| gRPC StreamRunEvents journal replay (tenant-scoped) | ✅ | `runs_stream_test.go` — replay-terminal, tail-until-terminal, tenant-scoping |
| OTel HTTP + gRPC spans (EnrichSpan with tenant_id/run_id/step_id) | ✅ | `span_test.go` green; `otelhttp.NewHandler` wraps the full mux; no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` unset |
| billing gRPC (ADR 0013) | ✅ | `billing.proto` + registered `BillingServiceServer`; bufconn smoke green |
| scheduler gRPC — creates runs via RunService (ADR 0013) | ✅ | `scheduler.proto` + registered `SchedulerServiceServer`; bufconn smoke green; creates runs via RPC (invariant #2), not direct table write |
| Dashboard dashboard honesty (no fake demo data) | ✅ | `/runtime` and `/deployments` render real EmptyState; `api.ts` error paths surface real errors via toast |
| A2A cross-tenant isolation | ✅ | `a2a_test.go` 3/3 DB-backed; private agents return 404 to cross-tenant callers |
| Budgets (HTTP 402 hard-fail) · eval-in-CI (422) · marketplace unpublish | ✅ | handler tests, P0 tier |
| Versioned migrations (golang-migrate baseline, ADR 0010) | ✅ | fresh-DB build + **adopt-on-existing** (records v1, zero DDL on a pre-migrated DB) |
| Prod secret guard (no dev admin/JWT in prod) | ✅ | `seedDev := !IsProd()` — dev tenant/admin only seeded when not prod |
| Data-plane tunnel + run-routing **end-to-end** | ✅ | `TestDataPlane_RoutingLoop_E2E` — real gRPC RunStream: queued run → RouteRun pins `data_plane_id` → assignment delivered live → Accept (→running) → Complete (→completed, cost/tokens persisted) |
| Tunnel + routing **live two-process smoke** | ✅ | `make smoke-dataplane` — boots the real control-plane + data-plane-agent **binaries**, agent dials `:50051` + registers via bootstrap token, `POST /v1/runs` routes to the plane, `DpRunAssignment` delivered over the tunnel. Passing locally. |
| workflow-engine (journal), runtime-scheduler (scoring/store/leader), data-plane-agent (tunnel) | ✅ | `go test` green (pure-Go packages) |
| workflow-engine LLM + tool steps | ✅ | `llm_call` via `ModelService.Complete`, `tool_call` via `RuntimeManager.ExecTool` (tenant-scoped, ADR 0025); live through the data-plane `RouteRun` path. The bridge LLM path is still direct unless `LANTERN_USE_MODEL_ROUTER` is on (default OFF, ADR 0014) |
| Surface-gateway real tenant resolution | ✅ | Resolves `LANTERN_TENANT_ID`; rejects unknown installs instead of inventing a tenant |
| Dashboard HttpOnly JWT cookie (server-side token) | ✅ | Bridge tokens proxied via Next.js server route; auth JWT set as HttpOnly cookie |
| Dashboard durable run resume (crash-replay primitives) | ✅ | `durable_replay.go` — `journalCompletedStep` wired into workflow interpreter; RESUME path driven from journal on crash |

## SDKs & surfaces

| Area | Status | How validated |
|---|---|---|
| TypeScript SDK | ✅ | `vitest` 83 tests (includes `runtime` namespace) |
| bridge-core (personal-assistant logic) | ✅ | `node --test` (tsx) 1615 tests incl. the bridge-parity gate; `tsc` enforced in CI |
| WhatsApp + iMessage bridges | ✅ unit / 🔴 runtime | iMessage 121 + WhatsApp 122 tests, `tsc` clean; **runtime needs live paired WhatsApp/iMessage** and validation in the owner's real logs after deploy (commitment ledger, sent-log, mute drafting) |
| Python SDK | ✅ | 97 pytest (incl. `runtime` namespace); management namespace parity (budgets/evals/experiments/marketplace/mcp/receipts/feedback/rehearsals); `connectors.execute` + `sessions.close` bugs fixed; `AgentContext`/`step()` runtime stubs (`NotImplementedError`); not on PyPI |

## Hot path (Rust)

| Area | Status | How validated |
|---|---|---|
| gateway, model-router, runtime-manager, harness build + clippy + tests | ✅ | Rust builds on the dev host. runtime-manager 381+ and harness 175+ tests, including the Linux-only paths run in Docker (openat2 confinement, privilege drop, SO_PEERCRED). CI remains the authoritative gate. |
| Sandbox spawn contract, per-call manager authz, tenant-scoped ExecTool, snapshot ownership (ADR 0025) | ✅ unit / 🔴 e2e | Unit + Docker-Linux tests; **no microVM boot** on this host (needs Linux/KVM) |
| Sandbox pause / resume / fork (REST, SDKs, CLI, dashboard) | ✅ contract / 🔴 e2e | Handler + SDK tests against the fixed contract; real Firecracker snapshot/restore, fork of a running VM (needs Firecracker ≥1.12 + jailer) and guest network re-identify have never run |
| Data-path OTel (tenant_id/run_id spans, OTLP export, traceparent) | 🟡 | unit tests + CI build; the two real bugs the reviewer found were fixed and re-verified green |

## Observability & ops

| Area | Status | How validated |
|---|---|---|
| Prometheus alerts (13 rules / 3 groups) | ✅ | YAML parses, every rule has `expr` + runbook annotation; TODO-metric rules flagged, not presented as live |
| Grafana dashboards (2) | ✅ | JSON parses |
| Runbooks (8 + index) | ✅ | all cross-links resolve |
| Vuln gate (govulncheck / cargo-audit / npm audit) | ✅ | CI `vuln` green; quinn-proto RUSTSEC-2026-0185 cleared; 0 production npm vulnerabilities in web / docs / landing (next 15.5.28) |

## Docs & front door

| Area | Status | How validated |
|---|---|---|
| Docs site builds + deploys (GitHub Pages) | ✅ | static export 24/24, live at `dshakes.github.io/lantern/` |
| Internal links carry basePath | ✅ | built with `PAGES_BASE_PATH=/lantern`, generated HTML emits `/lantern/...`; verified on the live site |
| Landing build | ✅ | `next build` green, 7/7 static |
| Deployed docs serve correctly (routing + content) | ✅ | `make validate-docs-live` — all 21 live routes return 200 with real content (>800B), installation page renders `lantern dev`/ports/credentials |
| **Pixel-level visual/aesthetic QA** | 🔴 | builds + content are proven, but **no browser on this host** — needs a 2-min `npm run dev` eyeball for layout/styling before public launch |

## CI gate health

| Lane | Status | Note |
|---|---|---|
| qa, review, vuln, classify, cluster-e2e | ✅ | green on recent PRs |
| `security` (Claude review) | ✅ fixed | was hitting `error_max_turns` at 16 turns on large diffs → raised to 30 turns / $4 budget |
| `audit` (Codex cross-audit) | ✅ resilient | now **degrades gracefully** — a Codex quota/infra error posts a transparent "skipped" notice and the lane stays green instead of hard-failing the PR. It is a *supplementary* second opinion; the blocking gates (`review`, `security`, `vuln`) are unaffected. Top up the Codex quota to re-enable the actual second opinion. |

---

## Honest gaps that remain (not yet closed)

1. ~~Live full-stack process run.~~ ✅ **Closed** — `make smoke-dataplane` boots the real control-plane + data-plane-agent binaries and proves a routed run over the tunnel end-to-end.
2. ~~Codex audit lane hard-fails on billing.~~ ✅ **Closed** — the lane degrades gracefully now; a quota top-up restores the actual second opinion.
3. ~~No concurrency/load testing on the run path.~~ ✅ **Basic load closed** — `make loadtest-runs` fired 120 concurrent run-creates (≈471 req/s) with **zero 5xx/connection errors**. A multi-node *soak/chaos* run still needs a real cluster (🔴).
4. ~~Deployed docs unverified.~~ ✅ **Content closed** — `make validate-docs-live` proves all 21 routes serve 200 + real content. Pixel-level layout still needs a browser (🔴).
5. **RLS enforcement flip** — handler cutover is complete and `LANTERN_RLS_ENFORCE=1` is safe to flip, but it is not yet enabled in any environment. Needs a per-env rollout with the `lantern_app` role password and GRANT check.
6. **Firecracker / KVM end-to-end** — 🔴 spawn contract, privilege drop, and pause/resume/fork are unit-tested but no microVM has been booted on a Linux/KVM host with this code, including guest network re-identify after restore.
7. **Python SDK `AgentContext`** — management surface parity is done (97 tests); the runtime context (`step()`, `ctx.llm`) still raises `NotImplementedError`. Not on PyPI.
8. **Real-cluster `helm install`** — 🔴 charts render for values / staging / prod, but have not been installed on a live cluster.
9. **Pixel QA** — 🔴 needs a browser eyeball (also covers the dashboard VM Pause/Resume/Fork UI).
10. **Bridges runtime** — 🔴 needs the owner's live paired channels and validation in real logs.
11. **Exhaustive per-feature coverage** — the breadth (17 connectors, voice, MCP marketplace, A2A, receipts, workflows) is largely test-backed but not individually re-exercised this cycle.

## Verdict

**Private-beta / design-partner grade today.** Core platform, multi-tenant isolation
(RLS handler cutover complete), service-token auth on every gRPC trust boundary,
OTel observability, LLM idempotency, budgets, the data-plane tunnel + routing loop,
migrations, and the vuln gate are validated, and the Rust hot path now builds and
tests locally. The remaining blockers to an unqualified "ship to the world" are the
named 🔴 items: Firecracker/KVM end-to-end (incl. pause/resume/fork and guest
re-identify), live bridge validation in the owner's logs, a real-cluster
`helm install`, and pixel QA.
