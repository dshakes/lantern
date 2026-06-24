# Lantern Roadmap & Status

> **Use this file to know what exists, what is spiked, and what is stubbed.** Updated as work proceeds.

## Phase legend

- ✅ **Done** — implemented, tested, documented
- 🟡 **Spike** — minimum viable implementation, integration seam complete, gaps documented
- ⬜ **Stub** — file/folder exists, no implementation
- 🔲 **Not started**

## Architecture & docs

| Item | Status |
|---|---|
| README, CLAUDE.md, AGENT.md | ✅ |
| Provider research (`docs/research/01-providers.md`) | ✅ |
| Architecture overview (`01-overview.md`) | ✅ |
| Component reference (`02-components.md`) | ✅ |
| Data model (`03-data-model.md`) | ✅ |
| Runtime isolation deep dive (`04-runtime-isolation.md`) | 🟡 |
| Workflow engine deep dive (`05-workflow-engine.md`) | 🟡 |
| Model router (`06-model-router.md`) | 🟡 |
| Context management (`07-context-management.md`) | 🟡 |
| Streaming architecture (`08-streaming.md`) | 🟡 |
| Observability (`09-observability.md`) | 🟡 |
| Security & multi-tenancy (`10-security.md`) | 🟡 |
| Testing strategy (`11-testing.md`) | 🟡 |
| ADRs 0001–0010 | ✅ |
| ADR 0011 — RLS all tenant tables (`docs/adr/0011-rls-all-tenant-tables.md`) | ✅ |
| ADR 0013 — billing/scheduler gRPC; memory REST-only (`docs/adr/0013-billing-scheduler-grpc-memory-rest.md`) | ✅ |

## API surface

| Item | Status |
|---|---|
| OpenAPI 3.1 spec (`docs/api/openapi.yaml`) | ✅ |
| gRPC protos (`packages/proto/`) | ✅ |
| AsyncAPI for streams/events (`docs/api/asyncapi.yaml`) | 🟡 |

## Services

| Service | Language | Status |
|---|---|---|
| `control-plane` | Go | ✅ — agents/runs CRUD, auth (email+password, Google OAuth, JWT), API keys, LLM provider management, deployments, data planes, Postgres schema with RLS (policies enabled on all 34 tenant tables; enforcement staged via `LANTERN_RLS_ENFORCE`); gRPC :50051 service-token auth; OTel HTTP+gRPC spans; LLM idempotency keys; gRPC StreamRunEvents journal replay; durable crash-resume primitives |
| `workflow-engine` | Go | 🟡 spike — step journaling, replay loop, in-memory queue; LLM steps now dispatch through model-router gRPC (engine path wired but remains dormant — no live caller yet) |
| `runtime-manager` | Rust | 🟡 spike — K8s Job runtime, Firecracker integration seam; harness SO_PEERCRED peer auth + egress proxy injection (CI-gated, UNVERIFIED locally — no macOS linker) |
| `gateway` | Rust | 🟡 spike — Axum, JWT auth, SSE streaming proxy, rate limiting |
| `model-router` | Rust | ✅ — multi-provider (OpenAI, Anthropic, Google), streaming, capability-based routing, per-tenant key management, inline completions from control-plane |
| `memory` | Go | ⬜ stub — memory is served over REST by the control-plane (`/v1/memory/*`, `/v1/people/*`); no gRPC MemoryService (see ADR 0013) |
| `notifier` | Go | ⬜ stub |
| `billing` | Go | 🟡 spike — `billing.proto` + `BillingServiceServer` registered on gRPC; `EmitUsage`/`CheckBudget`/`GetUsage`/`SetBudget` wired; see ADR 0013 |
| `scheduler` | Go | 🟡 spike — `scheduler.proto` + `SchedulerServiceServer` registered on gRPC; `RegisterSchedule`/`ListSchedules`/`DeleteSchedule`/`Trigger` wired; creates runs via control-plane RunService; see ADR 0013 |
| `surface-gateway` | Rust | 🟡 spike — real tenant resolution (LANTERN_TENANT_ID) replacing platform IDs; rejects unknown installs |

## Surface gateway

| Item | Status |
|---|---|
| Surface gateway service (Rust) | 🟡 spike — message normalization, channel adapters |
| WhatsApp adapter | ⬜ stub |
| Slack adapter | ⬜ stub |
| iMessage adapter | ⬜ stub |
| Discord adapter | ⬜ stub |
| Telegram adapter | ⬜ stub |
| Voice adapter | ⬜ stub |
| SMS adapter | ⬜ stub |
| Email adapter | ⬜ stub |

## Runtimes

| Runtime | Status |
|---|---|
| `k8s-job` (trusted) | 🟡 spike |
| `firecracker` (untrusted) | 🟡 spike — snapshot/restore integration seam, syscall filtering config |
| `kata` (hostile) | ⬜ stub + ADR |
| `wasm` (pure-fn) | ⬜ stub + ADR |
| `devcontainer` (long-lived) | ⬜ stub + ADR |

## Packages / SDKs / CLI

| Package | Status |
|---|---|
| `sdk-ts` | ✅ — `agent()`, `step()`, `step.map`, streaming; 24/24 vitest green |
| `sdk-python` | 🟡 spike — management namespaces at parity with sdk-go (agents, runs, sessions, connectors, budgets, evals, experiments, marketplace, MCP, receipts, feedback, rehearsals); 66 tests green; `AgentContext` / durable `step()` runtime still stubs (`NotImplementedError`); install from repo, not yet published to PyPI |
| `sdk-go` | ⬜ stub |
| `cli` (Go) | ✅ — `init`, `build`, `deploy`, `run`, `logs`, `replay` commands |
| `proto` | ✅ — agents.proto, runs.proto, events.proto, models.proto, engine.proto |
| `shared-types` | ⬜ stub |
| `ui-kit` | ⬜ stub |

## Apps

| App | Status |
|---|---|
| `web` (Next.js dashboard) | ✅ — agents CRUD, agent detail, runs + event stream, playground, settings, connectors, surfaces, Google OAuth; auth JWT now HttpOnly cookie (server-side); `/runtime` and `/deployments` render real EmptyState (no fake demo data); bridge tokens proxied server-side (not in client bundle) |
| `docs-site` | 🟡 spike — Nextra-style scaffold |
| `landing` (YC-style) | ✅ — landing page with feature sections, pricing, pitch deck |

## Infra

| Item | Status |
|---|---|
| `infra/helm/` Helm chart | 🟡 spike — chart with all services, configurable values, single `helm install` |
| `infra/docker/` dev compose | 🟡 spike — Postgres, Redis, MinIO, all services |
| `infra/terraform/` modules | ⬜ stub |
| K8s manifests | ⬜ stub |

## Examples

| Example | Status |
|---|---|
| `hello-world` | 🟡 spike — minimal agent, agent.yaml + agent.ts |
| `research-agent` | 🟡 spike — web search, structured report, parallel fan-out |
| `code-reviewer` | 🟡 spike — GitHub PR review with inline comments |
| `customer-support` | 🟡 spike — vector memory, approval gates, human-in-the-loop |
| `data-pipeline` | 🟡 spike — scheduled pipeline, multi-source, multi-channel distribution |
| `deploy-guardian` | 🟡 spike — deployment watcher, pre-flight checks, human approval |
| `talent-scout` | 🟡 spike — multi-platform candidate search, personalized outreach |
| `whatsapp-assistant` | 🟡 spike — personal WhatsApp agent, calendar/email/tasks |

## Local dev

| Item | Status |
|---|---|
| `make dev` (full stack) | ✅ — docker-compose with Postgres, Redis, MinIO, all services |
| `make dev-infra` (infra only) | ✅ — run services individually against shared infra |
| `make run-api` (control-plane) | ✅ — Go API server with auto-migration, dev seed data |
| `make dashboard-dev` (Next.js) | ✅ — hot-reload dashboard on :3000 |
| `make ci-local` (lint + test + audit) | 🟡 spike — same matrix as CI |
| `make proto` (codegen) | ✅ — Go + TS generation from protos |

## Tests

| Item | Status |
|---|---|
| Unit (Go/Rust/TS) | 🟡 spike — at least one per service/package |
| Control-plane handler tests (DB-backed) | ✅ — 24+ handler tests covering auth (JWT, expiry, no-enumeration), sessions (lifecycle + cross-tenant isolation), connectors (credential round-trip + cross-tenant isolation), RLS catalog gate, A2A tenant isolation, runs+stream |
| bridge-core (TS) | ✅ — 613 tests green (node:test + tsx), in CI (`make test-ts`) |
| runtime-scheduler (Go) | ✅ — full suite in `make test-go` (CGO off) |
| Python SDK | 🟡 CI-only — 66 pytest tests pass in CI; pytest not installed on dev host |
| gRPC auth (grpcauth) | ✅ — 7/7 green |
| billing + scheduler gRPC bufconn smoke tests | ✅ — green in CI |
| Integration (Testcontainers) | ⬜ stub |
| E2E API (k6) | ⬜ stub |
| E2E web (Playwright) | ⬜ stub |
| Security vuln gate (govulncheck / cargo-audit / npm audit) | ✅ — CI `vuln` green |
| Security: SAST (Semgrep, gosec) | ⬜ CI config only |
| Security: DAST (OWASP ZAP) | ⬜ CI config only |
| Security: image scan (Trivy) | ⬜ CI config only |
| Fuzz harnesses (sandbox boundary) | ⬜ stub |
| Chaos (Toxiproxy + replay) | ⬜ stub |
