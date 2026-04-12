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
| Architecture overview (`01-overview.md`) | 🟡 |
| Component reference (`02-components.md`) | 🟡 |
| Data model (`03-data-model.md`) | 🟡 |
| Runtime isolation deep dive (`04-runtime-isolation.md`) | 🟡 |
| Workflow engine deep dive (`05-workflow-engine.md`) | 🟡 |
| Model router (`06-model-router.md`) | 🟡 |
| Context management (`07-context-management.md`) | 🟡 |
| Streaming architecture (`08-streaming.md`) | 🟡 |
| Observability (`09-observability.md`) | 🟡 |
| Security & multi-tenancy (`10-security.md`) | 🟡 |
| Testing strategy (`11-testing.md`) | 🟡 |
| ADRs 0001–0010 | 🟡 |

## API surface

| Item | Status |
|---|---|
| OpenAPI 3.1 spec (`docs/api/openapi.yaml`) | 🟡 |
| gRPC protos (`packages/proto/`) | 🟡 |
| AsyncAPI for streams/events (`docs/api/asyncapi.yaml`) | 🟡 |

## Services

| Service | Language | Status |
|---|---|---|
| `control-plane` | Go | 🟡 spike — agents/runs CRUD, gRPC server, Postgres schema |
| `workflow-engine` | Go | 🟡 spike — step journaling, replay loop, in-memory queue |
| `runtime-manager` | Rust | 🟡 spike — K8s Job runtime; Firecracker stub |
| `gateway` | Rust | 🟡 spike — Axum, JWT auth, SSE proxy |
| `model-router` | Rust | 🟡 spike — OpenAI + Anthropic providers, big/small heuristic |
| `memory` | Go | ⬜ stub |
| `notifier` | Go | ⬜ stub |
| `billing` | Go | ⬜ stub |
| `scheduler` | Go | ⬜ stub |

## Runtimes

| Runtime | Status |
|---|---|
| `k8s-job` (trusted) | 🟡 spike |
| `firecracker` (untrusted) | ⬜ stub + ADR |
| `kata` (hostile) | ⬜ stub + ADR |
| `wasm` (pure-fn) | ⬜ stub + ADR |
| `devcontainer` (long-lived) | ⬜ stub + ADR |

## Packages / SDKs / CLI

| Package | Status |
|---|---|
| `sdk-ts` | 🟡 spike — `agent()`, `step()`, `step.map`, streaming |
| `sdk-python` | ⬜ stub |
| `sdk-go` | ⬜ stub |
| `cli` (Go) | 🟡 spike — `init`, `build`, `deploy`, `run`, `logs` |
| `proto` | 🟡 spike — agents.proto, runs.proto, events.proto |
| `shared-types` | ⬜ stub |
| `ui-kit` | ⬜ stub |

## Apps

| App | Status |
|---|---|
| `web` (Next.js dashboard) | 🟡 spike — runs list, run inspector with streaming |
| `docs-site` | 🟡 spike — Nextra-style scaffold |
| `landing` (YC-style) | 🟡 spike — landing + pitch deck |

## Infra

| Item | Status |
|---|---|
| `infra/helm/` Helm chart | 🟡 spike |
| `infra/docker/` dev compose | 🟡 spike |
| `infra/terraform/` modules | ⬜ stub |
| K8s manifests | ⬜ stub |

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
