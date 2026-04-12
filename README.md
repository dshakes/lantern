# Lantern

**Open-source serverless platform for production AI agents.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-lantern.dev-8B5CF6?style=flat-square)](https://docs.lantern.dev)
[![Discord](https://img.shields.io/discord/placeholder?label=discord&style=flat-square&color=5865F2)](https://discord.gg/lantern)

Lantern runs long-lived, multi-step AI agents in production with crash-proof durable execution, Firecracker microVM isolation, cost-optimized multi-LLM routing, and end-to-end token streaming. Deploy with one Helm install or use the managed cloud.

> **Status:** Active development. Core services are at spike maturity (functional, tested at the seam, gaps documented). See the [roadmap](docs/architecture/00-roadmap.md) for what is done, spiked, and stubbed.

---

## Table of contents

- [Why Lantern](#why-lantern)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [SDK usage](#sdk-usage)
- [Repository layout](#repository-layout)
- [Services](#services)
- [Local development](#local-development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Examples](#examples)
- [Contributing](#contributing)
- [License](#license)

---

## Why Lantern

The agent ecosystem is split between frameworks that run on your laptop and proprietary clouds that lock you to one model vendor. Neither solves the real problem: running stateful, multi-step AI agents reliably in production at any scale, on any model, with strong isolation.

| Capability | Claude Agents | Vertex AI | AWS Bedrock | AutoGen | **Lantern** |
|---|---|---|---|---|---|
| Durable execution (crash-proof) | No | No | No | No | **Temporal-grade** |
| Multi-LLM routing | Claude only | Google only | AWS only | Manual | **Auto by capability** |
| MicroVM isolation | Shared | Shared | Shared | Shared | **Firecracker per-run** |
| End-to-end streaming | Partial | No | No | No | **Token-level** |
| Omnichannel surfaces | No | No | No | No | **11 at launch** |
| Self-hostable | No | No | No | Yes | **One Helm install** |
| Visual builder + code | No | No | Partial | No | **Both, same format** |
| Cost-aware model selection | No | No | No | No | **Automatic** |

### Key differentiators

**Durable execution.** Every `step()` is checkpointed to Postgres. A run that crashes at step 47 resumes from step 47, not from scratch. Steps are idempotent, replayable, and exactly-once.

**Capability-based model routing.** Say `model: "auto"` and Lantern picks the cheapest model that meets the quality bar for each step. Reasoning-heavy steps escalate to frontier models. Fast tool dispatch goes to small models. Automatic failover across providers.

**MicroVM isolation.** Every run gets its own Firecracker microVM with syscall filtering and egress controls. 150ms warm start via snapshot/restore. Four isolation classes from trusted (bare K8s Job) to hostile (Kata + seccomp deny-all-but).

**Omnichannel surfaces.** WhatsApp, Slack, Discord, Telegram, SMS, voice, email, web, mobile, API. First-class surface gateway with webhook verification and session management, not bolted-on integrations.

**Cost intelligence.** Every run tracks cost per step. The model router optimizes spend in real time. Budget alerts, per-tenant caps, and full cost attribution in the dashboard.

---

## Architecture

```
 CONTROL PLANE (Lantern-hosted or self-hosted)
 =====================================================================

                         +--------------------+
     WhatsApp -----------|                    |
     Slack --------------|  Surface Gateway   |
     Telegram -----------|  (Rust/Axum)       |
     Voice --------------|                    |
                         +---------+----------+
                                   |
     SDK --------------------+-----+----------+
     CLI --------------------|  API Gateway   |
     Dashboard --------------|  (Rust/Axum)   |
                             +-----+----------+
                                   |
               +-------------------+-------------------+
               v                   v                   v
     +------------------+  +--------------+   +----------------+
     |  Control Plane   |  | Model Router |   |   Scheduler    |
     |  (Go)            |  | (Rust)       |   |   (Go)         |
     +--------+---------+  +--------------+   +----------------+
              |
              |  Postgres, Redis, S3
              |
     +--------+---------+----------+-----------+
     |  Memory (Go)     | Notifier | Billing   |
     |  pgvector        | (Go)     | (Go)      |
     +------------------+----------+-----------+

                    | gRPC tunnel (mTLS, outbound-only)
                    | metadata only -- customer data never crosses
                    |
 ===================|=================================================
                    |
 DATA PLANE (customer VPC: EKS / GKE / AKS / bare metal)
 =====================================================================

          +---------+----------+
          | Data Plane Agent   |
          | (Go)               |
          | tunnel, dispatch,  |
          | heartbeat, metrics |
          +---------+----------+
                    |
          +---------+-------------------+
          v                             v
   +------------------+       +------------------+
   | Workflow Engine   |       | Runtime Manager  |
   | (Go)              |       | (Rust)           |
   | durable execution |       | isolation orch.  |
   +--------+----------+       +--------+---------+
            |                           |
            |                  +--------+---------+
            |                  v                  v
            |           +-----------+      +-----------+
            |           | Firecracker|      |  K8s Job  |
            |           | MicroVMs   |      |  Runtime  |
            |           +-----------+      +-----------+
            |
            +--- local Postgres, Redis (customer-managed)
```

### Control plane

**Control plane** (Go) -- system of record for agents, versions, runs, tenants, API keys. gRPC + REST APIs. Postgres. Hosted as multi-tenant SaaS or self-hosted.

**API gateway** (Rust/Axum) -- authentication, rate limiting, streaming proxy (SSE + WebSocket + gRPC bidi). Single entry point for external clients.

**Model router** (Rust) -- multi-LLM endpoint. Capability-based addressing (`reasoning-large`, `chat-small`, `auto`), prompt caching, semantic deduplication, cost-aware routing, provider failover.

**Surface gateway** (Rust/Axum) -- omnichannel message adapter. Webhook verification, session management, unified event format across providers.

**Supporting services** (Go) -- scheduler (cron, delayed jobs), memory (three-tier: core/recall/archival with pgvector), notifier (webhook, email, Slack, SMS), billing (usage metering, budget enforcement).

### Data plane

**Data plane agent** (Go) -- lightweight connector deployed in the customer's VPC. Maintains a persistent outbound gRPC tunnel (mTLS) to the control plane. Receives run assignments, dispatches to the local workflow engine, and reports status/metrics back. Only metadata crosses the tunnel boundary -- customer code, inputs, outputs, secrets, and LLM responses never leave the VPC.

**Workflow engine** (Go) -- durable execution. Event-sourced run state with journal, replay, and recovery. The only service that mutates run state. Runs in the data plane so agent execution stays in the customer's network.

**Runtime manager** (Rust) -- orchestrates compute isolation. K8s Jobs, Firecracker microVMs, Kata Containers, Wasmtime. Snapshot/restore for fast cold start. Four isolation classes: trusted, standard, untrusted, hostile.

### Deployment modes

| Mode | Control plane | Data plane | Best for |
|---|---|---|---|
| **Fully managed** | Lantern-hosted | Lantern-hosted | Teams wanting zero ops |
| **Hybrid** | Lantern SaaS | Customer VPC | Data sovereignty, compliance |
| **Self-hosted** | Customer-hosted | Customer-hosted | Air-gap, FedRAMP, full control |

See [`docs/architecture/17-deployment-model.md`](docs/architecture/17-deployment-model.md) for the full deployment architecture.

All inter-service communication is gRPC (protobuf3). Protos are the single source of truth: [`packages/proto/lantern/v1/`](packages/proto/lantern/v1/).

For the full architecture, see [`docs/architecture/`](docs/architecture/).

---

## Quick start

```bash
# Install the CLI
brew install dshakes/tap/lantern
# or: go install github.com/dshakes/lantern/packages/cli@latest

# Scaffold an agent
lantern init my-agent --template research
cd my-agent

# Run locally against the dev stack
lantern run my-agent --input '{"topic": "AI agent frameworks 2026"}'

# Deploy
lantern deploy
```

---

## SDK usage

### TypeScript (primary)

```ts
import { agent, step, tool } from "@lantern/sdk";

export default agent({
  name: "research-agent",
  model: "auto",
  tools: [tool.web, tool.python, tool.fs],
  memory: { kind: "vector", scope: "user" },

  async run({ input, ctx }) {
    // Plan -- uses a reasoning model automatically
    const plan = await step("plan", async () =>
      ctx.llm.json({ schema: PlanSchema, prompt: `Plan: ${input.query}` })
    );

    // Parallel fan-out -- each runs on a separate worker, durably
    const findings = await step.map("search", plan.subqueries, async (q) =>
      ctx.tools.web.search(q)
    );

    // Synthesize -- falls back to a cheaper model when it fits
    return await step("synthesize", async () =>
      ctx.llm.stream({ prompt: synthPrompt(findings), preferSmall: true })
    );
  },
});
```

### Python

```python
from lantern import agent, step

@agent(name="research-agent", model="auto")
async def run(input: dict, ctx):
    plan = await step("plan", lambda: ctx.llm.complete(
        prompt=f"Plan: {input['topic']}"
    ))
    return {"plan": plan}
```

### CLI

```bash
lantern deploy            # build, snapshot, push, promote
lantern run my-agent \
  --input '{"query": "..."}'  # stream output live
lantern logs --follow     # tail across replicas
lantern replay r_01HXY2 \
  --from-step plan        # rerun from any checkpoint
```

Full agent bundle spec: [`AGENT.md`](AGENT.md).

---

## Repository layout

```
lantern/
  services/
    control-plane/          Go    -- agents, runs, tenants, auth, API keys
    workflow-engine/        Go    -- durable execution, event sourcing, journal
    gateway/                Rust  -- API edge, auth, rate limiting, streaming proxy
    model-router/           Rust  -- multi-LLM, caching, cost routing
    runtime-manager/        Rust  -- Firecracker, Kata, K8s Job, Wasm orchestration
    surface-gateway/        Rust  -- omnichannel webhooks, session management
    scheduler/              Go    -- cron, delayed jobs, fair-share queue
    memory/                 Go    -- core/recall/archival, pgvector
    notifier/               Go    -- webhooks, email, Slack, SMS, push
    billing/                Go    -- usage metering, cost attribution, budgets
    data-plane-agent/       Go    -- outbound tunnel for hybrid deployments
  packages/
    sdk-ts/                 TS    -- primary SDK: agent(), step(), tools, runtime
    sdk-python/             Py    -- secondary SDK: @agent decorator, step()
    sdk-go/                 Go    -- Go SDK (stub)
    cli/                    Go    -- `lantern` CLI (Cobra)
    proto/                  proto -- gRPC definitions (source of truth)
    shared-types/           *     -- generated types for all languages
    ui-kit/                 TS    -- shared React component library
  apps/
    web/                    TS    -- Next.js 15 dashboard (RSC + streaming)
    landing/                TS    -- marketing site (Next.js 15, Framer Motion)
    docs-site/              TS    -- documentation site
  runtimes/
    k8s-job/                        trusted workloads
    firecracker/                    standard/untrusted (microVM)
    kata/                           hostile (Kata Containers)
    wasm/                           pure-function (Wasmtime/WASI)
    devcontainer/                   long-running, IDE-like
  infra/
    docker/                         docker-compose dev stack
    helm/                           Helm charts (all-in-one, control-plane, data-plane)
    terraform/                      AWS/GCP IaC modules
  examples/                         8 reference agent implementations
  docs/
    architecture/                   17 design documents
    adr/                            Architecture Decision Records
    api/                            OpenAPI 3.1, AsyncAPI, gRPC reference
    user-guides/                    quickstarts, recipes, concepts
```

---

## Services

### Technology choices

| Layer | Language | Rationale |
|---|---|---|
| Control plane, workflow engine, scheduler, memory, notifier, billing | Go 1.23 | K8s-native, single binary, mature gRPC + Postgres ecosystem |
| Gateway, model router, runtime manager, surface gateway | Rust 2024 | Hot path. Predictable latency, memory safety, Firecracker interop |
| Dashboard, landing, docs | TypeScript / Next.js 15 | RSC + streaming. SDK's primary language |
| Primary SDK | TypeScript | Where the agent ecosystem lives |
| Secondary SDKs | Python, Go | AI/ML users, infra users |
| CLI | Go / Cobra | Static binary, cross-compile, reuses gRPC client |
| API contracts | protobuf3 | Single source of truth across languages |

### Data stores

| Store | Use | Image |
|---|---|---|
| PostgreSQL 16 + pgvector | Primary database. Agents, runs, journal, memory embeddings | `pgvector/pgvector:pg16` |
| Redis 7 | Session cache, rate limiting, pub/sub, queue | `redis:7-alpine` |
| S3 / MinIO | Agent bundles, Firecracker snapshots, large attachments | `minio/minio:latest` |

### Proto surface

Four proto files in [`packages/proto/lantern/v1/`](packages/proto/lantern/v1/):

| File | Services | Key types |
|---|---|---|
| `agents.proto` | `AgentService` | Agent, AgentVersion, CRUD + versioning RPCs |
| `runs.proto` | `RunService` | Run, StreamEvent (11 event types), lifecycle RPCs |
| `models.proto` | `ModelService` | Complete, Embed, Tokenize. 15 capability enums, optimization targets |
| `engine.proto` | `WorkflowEngineService`, `RuntimeManagerService` | Execute/Resume/Signal/Cancel, Schedule/Snapshot/Restore, 6 isolation classes |

Regenerate after editing protos:

```bash
make proto
```

---

## Local development

### Prerequisites

- Docker and Docker Compose
- Go 1.23+
- Rust (latest stable)
- Node.js 22+ and npm
- Python 3.11+ (for Python SDK tests)

### Start the dev stack

```bash
# Full stack: Postgres, Redis, MinIO, all services, dashboard
make dev

# Infrastructure only (run services individually for faster iteration)
make dev-infra
make run-api          # control-plane with correct env vars
cd services/gateway && cargo run
```

### Default dev credentials

| Service | Credentials |
|---|---|
| PostgreSQL | `lantern:lantern@localhost:5432/lantern` |
| MinIO console | `lantern:lanternsecret` at `localhost:9001` |
| Dashboard login | `admin@lantern.dev` / `lantern` |
| JWT secret | `lantern-dev-jwt-secret-do-not-use-in-production` |

### Useful make targets

| Target | What it does |
|---|---|
| `make dev` | `docker compose up --build` (full stack) |
| `make dev-infra` | Start Postgres, Redis, MinIO only |
| `make run-api` | Run control-plane locally with dev DB credentials |
| `make build` | Compile everything (Go + Rust + TypeScript) |
| `make proto` | Regenerate Go + TypeScript from proto definitions |
| `make test` | Run all test suites (Go, Rust, TypeScript, Python) |
| `make lint` | Lint all code (golangci-lint, clippy, eslint) |
| `make audit` | Security audit (govulncheck, cargo-audit, npm audit) |
| `make ci-local` | Full CI matrix locally: lint + test + audit |
| `make clean` | Remove build artifacts and docker volumes |
| `make docker-build` | Build all container images |

### Frontend development

```bash
make dashboard-dev    # Next.js 15 dashboard at localhost:3000
make landing-dev      # Landing page at localhost:3000
```

---

## Testing

```bash
make test             # all suites
make test-go          # control-plane, workflow-engine, scheduler
make test-rust        # gateway, model-router, runtime-manager
make test-ts          # sdk-ts (vitest)
make test-python      # sdk-python (pytest)
```

Go tests run with `-race -count=1`. Rust tests use `cargo test`. TypeScript uses Vitest. Python uses pytest.

Run `make ci-local` before pushing -- it runs the same lint + test + audit matrix as CI.

---

## Deployment

### Three deployment modes

**Fully managed** -- Lantern hosts control plane and data plane. Multi-tenant K8s clusters. Best for teams that want zero ops.

**Hybrid** (primary) -- Lantern SaaS control plane, customer-hosted data plane. Agent code and data never leave the customer VPC. The data-plane-agent maintains an outbound gRPC tunnel (no inbound firewall rules needed).

**Self-hosted** -- Customer hosts both planes. Full control, no telemetry. Air-gap and FedRAMP compatible.

### Helm

Three charts in [`infra/helm/`](infra/helm/):

```bash
# All-in-one (includes Postgres, Redis, MinIO as subcharts)
helm install lantern infra/helm/lantern \
  --set secrets.jwtSecret=<secret> \
  --set secrets.postgresPassword=<password>

# Control plane only (for hybrid mode)
helm install lantern-cp infra/helm/lantern-control-plane

# Data plane only (deployed to customer clusters)
helm install lantern-dp infra/helm/lantern-data-plane
```

### Terraform

IaC modules for AWS and GCP in [`infra/terraform/`](infra/terraform/). The CLI can generate Terraform configuration for a customer data plane:

```bash
lantern infra install --cloud aws --region us-east-1
```

### Docker images

```bash
make docker-build     # builds all images locally
```

Images are published to `ghcr.io/dshakes/lantern`.

---

## Examples

| Example | What it demonstrates |
|---|---|
| [`hello-world`](examples/hello-world/) | Minimal agent: `agent()`, `step()`, deploy |
| [`research-agent`](examples/research-agent/) | Web search, `step.map()` parallel fan-out, structured report |
| [`code-reviewer`](examples/code-reviewer/) | GitHub PR review, inline comments, tool calls |
| [`customer-support`](examples/customer-support/) | Vector memory, approval gates, human-in-the-loop |
| [`data-pipeline`](examples/data-pipeline/) | Scheduled weekly pipeline, multi-source ETL, Slack/email/Sheets |
| [`deploy-guardian`](examples/deploy-guardian/) | Pre-flight checks, durable approval gates, monitoring hooks |
| [`talent-scout`](examples/talent-scout/) | Multi-platform candidate search, personalized outreach |
| [`whatsapp-assistant`](examples/whatsapp-assistant/) | Personal WhatsApp agent: calendar, email, tasks, reminders |

---

## Contributing

Before your first PR:

1. Read [`CLAUDE.md`](CLAUDE.md) for repo conventions and the 10 architectural invariants.
2. Read the relevant [ADR](docs/adr/) if your change affects a load-bearing decision.
3. Run `make ci-local` before pushing.

### Standard flow for new features

1. Find or write the architecture doc in `docs/architecture/`.
2. Write or update the proto in `packages/proto/` if the feature crosses a service boundary. Run `make proto`.
3. Implement the service-side change. Follow existing patterns.
4. Wire the SDK in `packages/sdk-ts/`.
5. Wire the CLI if user-facing.
6. Wire the dashboard if user-facing.
7. Test at every layer: unit, integration, e2e.
8. Update docs.

### Do not introduce

- A new language without an [ADR](docs/adr/).
- A new database. Postgres + Redis + S3 + pgvector cover current needs.
- A new dependency without running `govulncheck` / `cargo audit` / `npm audit`.
- Direct LLM calls. Go through the model router.
- Cross-tenant joins. Every row has `tenant_id`.
- Hardcoded model names. Use capability addressing (`reasoning-large`, `auto`).

---

## Quick links

| Resource | Path |
|---|---|
| Architecture overview | [`docs/architecture/01-overview.md`](docs/architecture/01-overview.md) |
| Roadmap | [`docs/architecture/00-roadmap.md`](docs/architecture/00-roadmap.md) |
| Agent bundle spec | [`AGENT.md`](AGENT.md) |
| ADR index | [`docs/adr/`](docs/adr/) |
| API reference | [`docs/api/`](docs/api/) |
| Proto definitions | [`packages/proto/lantern/v1/`](packages/proto/lantern/v1/) |
| Provider research | [`docs/research/01-providers.md`](docs/research/01-providers.md) |

---

## License

Apache 2.0. See [LICENSE](LICENSE).
