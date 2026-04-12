# Lantern

**The open-source serverless platform for production AI agents.**

[![Build](https://img.shields.io/github/actions/workflow/status/dshakes/lantern/ci.yml?branch=main&style=flat-square)](https://github.com/dshakes/lantern/actions)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-lantern.dev-8B5CF6?style=flat-square)](https://docs.lantern.dev)
[![Discord](https://img.shields.io/discord/placeholder?label=discord&style=flat-square&color=5865F2)](https://discord.gg/lantern)

Ship an agent in 60 seconds. Run it on infrastructure that scales from zero to a million parallel runs with crash-proof durable execution, Firecracker microVM isolation, and automatic multi-LLM routing. Self-host with one Helm install or use the managed cloud.

---

## Why Lantern

The agent ecosystem is split between **frameworks** that run on your laptop and **proprietary clouds** that lock you to one model vendor. Neither solves the real problem: running long-lived, stateful, multi-step AI agents **reliably in production** at any scale, on any model, with strong isolation and zero ops.

### Comparison

| Feature | Claude Agents | Google Vertex | AWS Bedrock | Microsoft AutoGen | **Lantern** |
|---|---|---|---|---|---|
| Durable execution (crash-proof) | No | No | No | No | **Yes -- Temporal-grade** |
| Multi-LLM routing | Claude only | Google models | AWS models | Any (manual) | **Auto-route by capability** |
| MicroVM isolation | Shared sandbox | Shared | Shared | Shared | **Firecracker per-run** |
| Omnichannel (WhatsApp, iMessage, Voice) | No | No | No | No | **11 surfaces at launch** |
| End-to-end streaming | Partial | No | No | No | **Token-level, no buffering** |
| Personal workflows | No | No | No | No | **E2E encrypted, mobile-first** |
| Self-hostable | No | No | No | Yes (OSS) | **Yes, one Helm install** |
| Visual builder + code | No | No | Partial | No | **Both, same format** |
| Human-in-the-loop approvals | Limited | No | No | Basic | **Durable, any surface** |
| 30+ connectors built-in | No | Some | Some | No | **Yes** |
| Cost-aware model routing | No | No | No | No | **Big/small auto-select** |

### Key differentiators

**Durable Execution** -- Like Temporal for AI. Every `step()` is checkpointed to Postgres. If a run crashes at step 47, it resumes from step 47, not from scratch. Steps are idempotent, replayable, and exactly-once.

**Capability-Based Model Routing** -- Say `model: "auto"` and Lantern picks the best model for each step at the best price. Cheap prompts go to small models; reasoning-heavy steps escalate to large ones. Automatic failover across providers. Customers report 60% cost savings.

**MicroVM Sandboxing** -- Every run gets its own Firecracker microVM with syscall filtering and egress controls. 150ms warm start via snapshot/restore. Real isolation, not just containers.

**Drive Agents from Anywhere** -- WhatsApp, iMessage, Slack, Discord, Telegram, voice calls, SMS, email, web, mobile, API. First-class surface gateway, not bolted-on integrations.

**Personal Workflows** -- Connect your Gmail, Calendar, and personal accounts. E2E encrypted with per-tenant keys. No enterprise sales call needed -- your agent, your data.

**Cost Intelligence** -- Every run tracks cost per step. The model router optimizes spend in real time. Budget alerts, dead-letter queues for overspend, and full cost attribution in the dashboard.

---

## Quick start

```bash
# Install the CLI
brew install dshakes/tap/lantern  # or: go install github.com/dshakes/lantern/packages/cli@latest

# Create your first agent
lantern init my-agent --template research
cd my-agent

# Run locally
lantern run my-agent --input '{"topic": "AI agent frameworks 2026"}'

# Deploy to the cloud
lantern deploy
```

---

## The 60-second tour

```ts
// agent.ts — declarative + typed
import { agent, step, tool } from "@lantern/sdk";

export default agent({
  name: "research-agent",
  model: "auto",            // Lantern picks the right model per step
  tools: [tool.web, tool.python, tool.fs],
  memory: { kind: "vector", scope: "user" },

  async run({ input, ctx }) {
    const plan = await step("plan", async () =>
      ctx.llm.json({ schema: PlanSchema, prompt: `Plan: ${input}` })
    );

    // Parallel fan-out — Lantern runs these on separate workers, durably
    const findings = await step.map(plan.subqueries, async (q) =>
      ctx.tools.web.search(q)
    );

    // Falls back to a smaller, cheaper model when the synthesis fits
    const report = await step("synthesize", async () =>
      ctx.llm.stream({ prompt: synthPrompt(findings), preferSmall: true })
    );

    return report;
  },
});
```

```bash
lantern deploy        # builds, snapshots, pushes, deploys
lantern run research-agent --input "..."   # streams live
lantern logs --follow # tail across replicas
lantern replay r_01HXY2 --from-step plan   # rerun from any step
```

---

## Architecture

```
                        ┌──────────────────┐
    WhatsApp ──────────▶│                  │
    Slack    ──────────▶│  Surface Gateway │
    iMessage ──────────▶│  (Rust)          │
    Voice    ──────────▶│                  │
                        └────────┬─────────┘
                                 │
    SDK ────────────────▶┌───────┴─────────┐
    CLI ────────────────▶│   API Gateway   │
    Dashboard ──────────▶│   (Rust/Axum)   │
                         └───────┬─────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                   ▼
    ┌─────────────────┐  ┌──────────────┐   ┌──────────────┐
    │  Control Plane  │  │ Model Router │   │  Workflow     │
    │  (Go)           │  │ (Rust)       │   │  Engine (Go)  │
    └─────────────────┘  └──────────────┘   └──────┬───────┘
                                                    │
                                            ┌───────┴───────┐
                                            ▼               ▼
                                     ┌────────────┐  ┌────────────┐
                                     │ Firecracker│  │  K8s Job   │
                                     │ MicroVMs   │  │  Runtime   │
                                     └────────────┘  └────────────┘
```

See [`docs/architecture/`](docs/architecture/) for the deep version -- component reference, data model, runtime isolation, workflow engine, model router, streaming, observability, security, and testing strategy.

---

## Examples

| Example | Description |
|---|---|
| [`hello-world`](examples/hello-world/) | Minimal agent demonstrating the basics of `agent()`, `step()`, and `lantern deploy` |
| [`research-agent`](examples/research-agent/) | Researches a topic with web search, produces a structured report with sources and findings |
| [`code-reviewer`](examples/code-reviewer/) | Reviews GitHub PRs, posts inline comments with suggestions, submits a verdict |
| [`customer-support`](examples/customer-support/) | Support agent with vector memory, approval gates, and human-in-the-loop review |
| [`data-pipeline`](examples/data-pipeline/) | Scheduled weekly pipeline: HubSpot + Stripe + Analytics into reports across Slack, email, Sheets, Notion |
| [`deploy-guardian`](examples/deploy-guardian/) | Watches deployments, runs pre-flight checks, gates rollouts with human approval |
| [`talent-scout`](examples/talent-scout/) | Searches candidates across LinkedIn, GitHub, Stack Overflow; generates personalized outreach |
| [`whatsapp-assistant`](examples/whatsapp-assistant/) | Personal WhatsApp agent for calendar, email, tasks, reminders, and expenses |

---

## Local development

```bash
git clone https://github.com/dshakes/lantern
cd lantern

# Start the full dev stack (Postgres, Redis, MinIO, all services)
make dev

# Or start just infrastructure and run services individually
make dev-infra
cd services/gateway && cargo run
```

Run tests and linting (same checks as CI):

```bash
make ci-local
```

---

## Repository layout

```
lantern/
├── apps/
│   ├── web/              Next.js 15 dashboard (RSC + streaming)
│   ├── docs-site/        Documentation site
│   └── landing/          Marketing + pitch
├── services/
│   ├── control-plane/    Go — agents/runs CRUD, gRPC, Postgres
│   ├── workflow-engine/  Go — durable execution, event sourcing
│   ├── runtime-manager/  Rust — Firecracker / Kata / Wasm orchestrator
│   ├── gateway/          Rust — Axum API gateway, streaming proxy
│   ├── model-router/     Rust — multi-LLM, cache, big/small routing
│   ├── memory/           Go — vector + KV + episodic memory
│   ├── notifier/         Go — webhooks, email, Slack, SMS, push
│   ├── billing/          Go — metering, usage, cost attribution
│   └── scheduler/        Go — cron, delayed jobs, backpressure
├── runtimes/
│   ├── k8s-job/          Trusted lightweight steps
│   ├── firecracker/      Untrusted user code, fast cold start
│   ├── kata/             Hostile workloads, K8s RuntimeClass
│   ├── wasm/             Pure-function steps via WASI
│   └── devcontainer/     Long-running IDE-like agents
├── packages/
│   ├── sdk-ts/           TypeScript SDK (primary)
│   ├── sdk-python/       Python SDK
│   ├── sdk-go/           Go SDK
│   ├── cli/              `lantern` CLI (Go)
│   ├── proto/            gRPC protos (source of truth)
│   ├── shared-types/     Generated types (TS/Python/Go/Rust)
│   └── ui-kit/           React component library
├── infra/
│   ├── helm/             Helm chart (self-host with one install)
│   ├── docker/           Dev compose stack
│   ├── terraform/        AWS/GCP modules
│   └── k8s/              Manifests
├── examples/             8 end-to-end agent samples
├── docs/
│   ├── architecture/     System design, sequence diagrams, roadmap
│   ├── adr/              Architecture Decision Records
│   ├── api/              OpenAPI 3.1, AsyncAPI, gRPC reference
│   ├── user-guides/      Quickstarts, recipes, concepts
│   └── research/         Provider landscape research
├── CLAUDE.md             Working agreement for AI assistants
├── AGENT.md              Agent bundle specification
└── README.md             This file
```

---

## Contributing

We welcome contributions. Before your first PR:

1. Read [`CLAUDE.md`](CLAUDE.md) for repo conventions and architectural invariants.
2. Read the relevant [ADR](docs/adr/) if your change affects a load-bearing decision.
3. Run `make ci-local` before pushing -- it runs the same matrix as CI.

See the [architecture docs](docs/architecture/) for how the system fits together.

---

## Quick links

- [Architecture overview](docs/architecture/01-overview.md) -- components, data flow, sequence diagrams
- [Roadmap](docs/architecture/00-roadmap.md) -- what is done, spiked, and planned
- [Agent bundle spec](AGENT.md) -- the `agent.yaml` file format
- [ADR index](docs/adr/) -- every load-bearing decision
- [API reference](docs/api/) -- OpenAPI, gRPC, AsyncAPI
- [Provider research](docs/research/01-providers.md) -- landscape analysis

---

## License

Apache 2.0. See [LICENSE](LICENSE).
