# Lantern — Serverless Agents, Production Grade

> **Lantern is the serverless platform for AI agents.** Ship an agent in 60 seconds, run it on global infrastructure that scales from zero to a million parallel runs, and never think about Kubernetes, microVMs, model routing, retries, or context windows again.

```
$ lantern init my-agent --template research
$ lantern deploy
✓ built  lantern.dev/acme/research-agent@v1
✓ pushed snapshot 412 MB → 18 MB compressed
✓ live   https://acme.lantern.run/research-agent
$ lantern run research-agent --input "Compare Postgres vs ScyllaDB for time-series at 1M w/s"
▸ live  https://app.lantern.dev/runs/r_01HXY2... (streaming)
```

---

## Why Lantern

The agent ecosystem is split between **frameworks** that run on your laptop (LangGraph, CrewAI, Mastra) and **proprietary clouds** that lock you to one model vendor (OpenAI Assistants, Bedrock Agents, Vertex Agent Builder). Neither solves the real problem: **running long-lived, stateful, multi-step AI agents reliably in production at any scale, on any model, with strong isolation and zero ops**.

Lantern is what you get when you start from that problem and build down:

| Layer | Lantern gives you |
|---|---|
| **Definition** | A single declarative `agent.yaml` (or TS/Python decorator) that compiles to a portable agent bundle |
| **Runtime** | Strong-isolation microVMs (Firecracker) on Kubernetes, with sub-second cold starts via snapshot/restore |
| **Orchestration** | Durable workflow engine: linear, parallel fan-out, map-reduce, sagas, human-in-loop, signals, queries — all crash-safe |
| **Models** | Any LLM (OpenAI, Anthropic, Google, xAI, Mistral, Llama, local). Cost-aware big/small routing. Automatic failover. Prompt + semantic cache |
| **Context** | Token budgeter, hierarchical summarization, tool-result compaction, vector + KV memory, automatic cache reuse |
| **Streaming** | First-class SSE + WebSocket + gRPC bidi from runtime → API → SDK → dashboard. Token-by-token, tool-call-by-tool-call |
| **Reliability** | At-least-once durable execution, idempotency keys, exponential backoff, circuit breakers, dead-letter queues |
| **Observability** | OTel traces of every LLM call, tool call, and step. Live run inspector. Replay any failed run from any step |
| **Security** | mTLS everywhere, syscall + egress filtering, signed agent bundles, SOC2-aligned audit log, per-tenant encryption keys |
| **Notifications** | Webhooks, email, Slack, SMS, in-app, push — for run completion, failure, approval gates, budget alerts |
| **DX** | TS/Python/Go SDKs, `lantern` CLI, Next.js dashboard, hosted docs, OpenAPI 3.1, gRPC, AsyncAPI |

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

## Architecture at a glance

```
                          ┌─────────────────┐
                          │    Dashboard     │  Next.js 15 / RSC
                          │   (web)         │  Live runs, observability
                          └────────┬────────┘
                                   │ HTTPS + WS
              ┌────────────────────▼─────────────────────┐
              │              API Gateway (Rust)          │  Axum + Tower
              │  Auth · rate limit · streaming proxy     │  mTLS in
              └────┬─────────────────────────────────┬───┘
                   │ gRPC                            │ gRPC stream
       ┌───────────▼──────────┐         ┌────────────▼───────────┐
       │  Control Plane (Go)  │         │  Model Router (Rust)   │
       │  agents / runs /     │         │  Multi-LLM, cache,     │
       │  workflows / RBAC    │         │  big/small routing     │
       └───────┬──────────────┘         └────────────────────────┘
               │ enqueue
       ┌───────▼──────────────┐         ┌────────────────────────┐
       │  Workflow Engine     │◀───────▶│  Memory Service        │
       │  (Go) — durable,     │         │  Postgres + pgvector   │
       │  event-sourced       │         │  + Redis + S3          │
       └───────┬──────────────┘         └────────────────────────┘
               │ schedule
       ┌───────▼──────────────────────────────────────────────┐
       │            Runtime Manager (Rust)                    │
       │  K8s client · Firecracker · Kata · Wasmtime · Job    │
       │  Snapshot/restore · syscall + egress filtering       │
       └───────┬──────────────────────────────────────────────┘
               │
   ┌───────────┼──────────────┬──────────────┬────────────────┐
┌──▼──┐   ┌────▼──────┐   ┌───▼─────┐   ┌────▼──────┐   ┌─────▼─────┐
│ K8s │   │Firecracker│   │  Kata   │   │ Wasmtime  │   │DevContainer│
│ Job │   │  microVM  │   │container│   │  (WASI)   │   │  (long)    │
└─────┘   └───────────┘   └─────────┘   └───────────┘   └───────────┘
  trusted    untrusted      hostile         pure-fn        IDE-like
```

See [`docs/architecture`](docs/architecture/) for the deep version.

---

## Repository layout

```
serverless-agents/
├── apps/
│   ├── web/             Next.js 15 dashboard (RSC + streaming)
│   ├── docs-site/       Nextra-style docs
│   └── landing/         YC-style marketing + pitch
├── services/
│   ├── control-plane/   Go — REST + gRPC, Postgres, K8s client
│   ├── workflow-engine/ Go — durable execution, event sourcing
│   ├── runtime-manager/ Rust — Firecracker / Kata / Wasm orchestrator
│   ├── gateway/         Rust — Axum API gateway, streaming proxy
│   ├── model-router/    Rust — multi-LLM, cache, big/small routing
│   ├── memory/          Go — vector + KV + episodic memory
│   ├── notifier/        Go — webhooks, email, Slack, SMS, push
│   ├── billing/         Go — metering, usage events, cost attribution
│   └── scheduler/       Go — cron, delayed jobs, backpressure
├── runtimes/
│   ├── k8s-job/         Trusted lightweight steps
│   ├── firecracker/     Untrusted user code, fast cold start
│   ├── kata/             Hostile workloads, K8s RuntimeClass
│   ├── wasm/            Pure-function steps via WASI-preview2
│   └── devcontainer/    Long-running IDE-like agents
├── packages/
│   ├── sdk-ts/          TypeScript SDK (primary)
│   ├── sdk-python/      Python SDK
│   ├── sdk-go/          Go SDK
│   ├── cli/             `lantern` — Go-based CLI
│   ├── proto/           gRPC protos (single source of truth)
│   ├── shared-types/    Generated types (TS/Python/Go/Rust)
│   └── ui-kit/          React component library
├── infra/
│   ├── k8s/             Manifests
│   ├── helm/            Helm chart
│   ├── terraform/       AWS/GCP modules
│   └── docker/          Dev compose stack
├── docs/
│   ├── architecture/    System design, sequence diagrams
│   ├── adr/             Architecture Decision Records
│   ├── api/             OpenAPI 3.1, AsyncAPI, gRPC reference
│   ├── user-guides/     Quickstarts, recipes, concepts
│   └── research/        Provider landscape research
├── examples/            End-to-end agent samples
├── .claude/             Subagents + skills used while developing Lantern
├── CLAUDE.md            Working agreement for AI assistants in this repo
├── AGENT.md             Agent bundle specification (the file format)
└── README.md            (this file)
```

---

## Status

**This is a green-field architecture spike.** The repository contains:

1. **Deep architecture docs and ADRs** — production-grade design before code
2. **A working spike** of the control plane, runtime manager, TS SDK, CLI, and dashboard — enough to deploy and run a trivial agent end-to-end on a local Kind cluster
3. **Stubs and integration seams** for the runtimes, SDKs, and integrations that aren't built yet

See [`docs/architecture/00-roadmap.md`](docs/architecture/00-roadmap.md) for what's done, what's spiked, and what's stubbed.

---

## Quick links

- **[Architecture overview](docs/architecture/01-overview.md)** — components, data flow, sequence diagrams
- **[Provider landscape research](docs/research/01-providers.md)** — what we learned from the top 10
- **[Agent bundle spec (`AGENT.md`)](AGENT.md)** — the file format
- **[ADR index](docs/adr/)** — every load-bearing decision
- **[API reference](docs/api/)** — OpenAPI, gRPC, AsyncAPI
- **[Pitch deck](apps/landing/pitch.md)** — the YC version

---

## License

TBD. The architecture and docs in this repo are released for your evaluation.
