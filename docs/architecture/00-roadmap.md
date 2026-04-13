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

## API surface

| Item | Status |
|---|---|
| OpenAPI 3.1 spec (`docs/api/openapi.yaml`) | ✅ |
| gRPC protos (`packages/proto/`) | ✅ |
| AsyncAPI for streams/events (`docs/api/asyncapi.yaml`) | 🟡 |

## Services

| Service | Language | Status |
|---|---|---|
| `control-plane` | Go | ✅ — agents/runs CRUD, auth (email+password, Google OAuth, JWT), API keys, LLM provider management, deployments, data planes, Postgres schema with RLS |
| `workflow-engine` | Go | 🟡 spike — step journaling, replay loop, in-memory queue |
| `runtime-manager` | Rust | 🟡 spike — K8s Job runtime, Firecracker integration seam |
| `gateway` | Rust | 🟡 spike — Axum, JWT auth, SSE streaming proxy, rate limiting |
| `model-router` | Rust | ✅ — multi-provider (OpenAI, Anthropic, Google), streaming, capability-based routing, per-tenant key management, inline completions from control-plane |
| `memory` | Go | ⬜ stub |
| `notifier` | Go | ⬜ stub |
| `billing` | Go | ⬜ stub |
| `scheduler` | Go | ⬜ stub |

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
| `sdk-ts` | 🟡 spike — `agent()`, `step()`, `step.map`, streaming |
| `sdk-python` | ⬜ stub |
| `sdk-go` | ⬜ stub |
| `cli` (Go) | ✅ — `init`, `build`, `deploy`, `run`, `logs`, `replay` commands |
| `proto` | ✅ — agents.proto, runs.proto, events.proto, models.proto, engine.proto |
| `shared-types` | ⬜ stub |
| `ui-kit` | ⬜ stub |

## Apps

| App | Status |
|---|---|
| `web` (Next.js dashboard) | ✅ — agents CRUD, agent detail (settings, versions, deployments, runs), runs list + detail with event stream, playground with live LLM streaming, settings (API keys, LLM providers, team, billing), connectors, surfaces, Google OAuth login, demo mode fallback |
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
| Integration (Testcontainers) | ⬜ stub |
| E2E API (k6) | ⬜ stub |
| E2E web (Playwright) | ⬜ stub |
| Security: SAST (Semgrep, gosec, cargo-audit) | ⬜ CI config only |
| Security: DAST (OWASP ZAP) | ⬜ CI config only |
| Security: image scan (Trivy) | ⬜ CI config only |
| Fuzz harnesses (sandbox boundary) | ⬜ stub |
| Chaos (Toxiproxy + replay) | ⬜ stub |
