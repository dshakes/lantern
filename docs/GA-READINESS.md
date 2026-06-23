# Lantern GA Readiness — validation matrix

A faithful go/no-go checklist: what is validated, how, and what still needs a human
hand before a true "ship to the world" claim. Updated 2026-06-22.

The guiding rule: **"compiles" ≠ "validated."** A green build that still 404s in a
browser (as the docs basePath bug did) is not validated. Each row says how the
claim was actually checked.

## Legend
- ✅ **Validated** — exercised and asserted (test/integration/live), evidence noted.
- 🟡 **CI-only** — verified by CI but not reproducible on the current dev host (no
  C toolchain / no browser); trustworthy but second-hand.
- 🔴 **Needs human** — requires access this environment doesn't have (paired
  phones, a browser, a billing account, a real cluster).

---

## Core platform (control plane)

| Area | Status | How validated |
|---|---|---|
| Control-plane Go suite (agents, runs, sessions, budgets, RLS, crash-replay, scheduler, secrets, workflow) | ✅ | `go test ./...` green — 9 packages, handlers 27s |
| RLS multi-tenant isolation (enforced runtime) | ✅ | `internal/db` RLS tests (cross-tenant denial under `lantern_app` role) |
| Budgets (HTTP 402 hard-fail) · eval-in-CI (422) · marketplace unpublish | ✅ | handler tests, P0 tier |
| Versioned migrations (golang-migrate baseline, ADR 0010) | ✅ | fresh-DB build + **adopt-on-existing** (records v1, zero DDL on a pre-migrated DB) |
| Prod secret guard (no dev admin/JWT in prod) | ✅ | `seedDev := !IsProd()` — dev tenant/admin only seeded when not prod |
| Data-plane tunnel + run-routing **end-to-end** | ✅ | `TestDataPlane_RoutingLoop_E2E` — real gRPC RunStream: queued run → RouteRun pins `data_plane_id` → assignment delivered live → Accept (→running) → Complete (→completed, cost/tokens persisted) |
| Tunnel + routing **live two-process smoke** | ✅ | `make smoke-dataplane` — boots the real control-plane + data-plane-agent **binaries**, agent dials `:50051` + registers via bootstrap token, `POST /v1/runs` routes to the plane, `DpRunAssignment` delivered over the tunnel. Passing locally. |
| workflow-engine (journal), runtime-scheduler (scoring/store/leader), data-plane-agent (tunnel) | ✅ | `go test` green (pure-Go packages) |

## SDKs & surfaces

| Area | Status | How validated |
|---|---|---|
| TypeScript SDK | ✅ | `vitest` 24/24 |
| bridge-core (personal-assistant logic) | ✅ | `node --test` 602/602 |
| WhatsApp + iMessage bridges | 🟡 typecheck / 🔴 runtime | `tsc --noEmit` clean both; **runtime needs live paired WhatsApp/iMessage** to confirm reply/loopback behaviour |
| Python SDK | 🟡 | tests run in CI (`pytest` not installed on dev host) |

## Hot path (Rust)

| Area | Status | How validated |
|---|---|---|
| gateway, model-router, runtime-manager build + clippy + tests | 🟡 | **CI only** — dev host has no working C toolchain (`xcode-select` broken), so no local `cargo` build. CI is authoritative; it has caught real bugs (the dead-code OTel spans, the quinn-proto CVE) that green-looking code hid. |
| Data-path OTel (tenant_id/run_id spans, OTLP export, traceparent) | 🟡 | unit tests + CI build; the two real bugs the reviewer found were fixed and re-verified green |

## Observability & ops

| Area | Status | How validated |
|---|---|---|
| Prometheus alerts (13 rules / 3 groups) | ✅ | YAML parses, every rule has `expr` + runbook annotation; TODO-metric rules flagged, not presented as live |
| Grafana dashboards (2) | ✅ | JSON parses |
| Runbooks (8 + index) | ✅ | all cross-links resolve |
| Vuln gate (govulncheck / cargo-audit / npm audit) | ✅ | CI `vuln` green; quinn-proto RUSTSEC-2026-0185 cleared |

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
5. **Rust hot-path local build** — 🔴 this host has no C toolchain/macOS SDK at all (not a config issue); CI is the authoritative builder.
6. **Bridges runtime** — 🔴 needs the owner's live paired channels.
7. **Exhaustive per-feature coverage** — the breadth (17 connectors, voice, MCP marketplace, A2A, receipts, workflows) is largely test-backed but not individually re-exercised this cycle.

## Verdict

**Private-beta / design-partner grade today.** Core platform, multi-tenant
isolation, the data-plane tunnel + routing loop, migrations, and the vuln gate are
validated. The remaining blockers to an unqualified "ship to the world" are a
finite, named list above — most needing a browser, a phone, a cluster, or a
billing top-up rather than more code.
