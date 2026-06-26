# Architecture Overview

> **Read this first.** Every other architecture doc assumes you've read this one.

## Mission

Lantern is a serverless platform for running production AI agents reliably at any scale on any model. It exists because **the hard parts of agents are not the agent loop itself** — they are durable execution, isolation of untrusted code, multi-model routing, context management, observability, and operational correctness across failure. Frameworks ignore those problems; proprietary clouds solve them by locking you in. Lantern solves them in the open.

## Design principles

1. **One bundle, many runtimes.** A single declarative agent bundle (see [`AGENT.md`](../../AGENT.md)) runs identically on K8s Job, Firecracker, Kata, Wasm, devcontainer, or local dev.
2. **Durable by default.** Every step is journaled; every restart resumes; every external side-effect is idempotent.
3. **Streaming end-to-end.** Tokens flow runtime → gateway → SDK → dashboard with no buffering point. Backpressure is honored at every hop.
4. **Capability-addressed models.** SDK code says `model: "reasoning-large"`; the router picks the vendor at runtime based on cost, latency, availability, and policy.
5. **Strong isolation classes.** Trust level is declared in the bundle; the runtime manager picks the right physical sandbox automatically.
6. **Multi-tenant from day one.** Every row, span, log, and namespace is tagged with `tenant_id`. No cross-tenant joins.
7. **Self-hostable as a tier-1 promise.** A single Helm chart deploys the entire stack on any conformant Kubernetes cluster.
8. **Observability is not optional.** OTel traces, structured logs, metrics, and replayable run state for every run, free.

## High-level diagram

```
                                                          ┌──────────────┐
                                                          │    Users     │
                                                          └──────┬───────┘
                                                                 │ HTTPS / WS
                                       ┌─────────────────────────▼───────────────────────────┐
                                       │                  Edge / CDN (TLS)                    │
                                       └─────────────────────────┬───────────────────────────┘
                                                                 │
                                       ┌─────────────────────────▼───────────────────────────┐
                                       │              API Gateway (Rust, Axum)                │
                                       │   AuthN/Z  ·  rate-limit  ·  SSE/WS proxy  ·  mTLS   │
                                       └────┬───────────────────────┬─────────────────┬──────┘
                                            │ gRPC                  │ gRPC stream     │ gRPC
              ┌─────────────────────────────▼─────────────────┐     │       ┌─────────▼───────────┐
              │            Control Plane (Go)                  │     │       │   Model Router      │
              │  agents · runs · workflows · tenants · RBAC   │     │       │   (Rust)            │
              │  Postgres + Redis  ·  K8s API client          │     │       │   multi-LLM, cache  │
              └──────────────┬──────────────────┬─────────────┘     │       └──────┬──────────────┘
                             │                  │                   │              │
                  enqueue    │                  │ events            │ stream       │
                             │                  ▼                   │              ▼
              ┌──────────────▼──────────────────────────────┐       │       ┌──────────────────┐
              │         Workflow Engine (Go)                 │       │       │    Providers     │
              │  durable, event-sourced, replay              │◀──────┴──────▶│   OpenAI · Claude│
              │  signals · queries · child WFs · sagas       │               │  Google · xAI ...│
              └──────────────┬──────────────────┬────────────┘               └──────────────────┘
                             │                  │
                    schedule │                  │ memory ops
                             │                  ▼
              ┌──────────────▼─────────────┐  ┌────────────────────┐
              │  Runtime Manager (Rust)    │  │  Memory Service    │
              │  K8s · Firecracker · Kata  │  │  Postgres+pgvector │
              │  Wasmtime · Devcontainer   │  │  Redis · S3        │
              │  snapshot/restore · seccomp│  │  core/recall/arch  │
              └──────────────┬─────────────┘  └────────────────────┘
                             │
        ┌────────────────────┼─────────────────┬─────────────────┬───────────────────┐
        │                    │                 │                 │                   │
   ┌────▼────┐    ┌──────────▼─────┐   ┌───────▼─────┐   ┌──────▼───────┐   ┌───────▼────────┐
   │ K8s Job │    │ Firecracker VM │   │ Kata Cont.  │   │  Wasmtime    │   │ DevContainer   │
   │ trusted │    │  untrusted     │   │  hostile    │   │   pure-fn    │   │  long-lived    │
   └─────────┘    └────────────────┘   └─────────────┘   └──────────────┘   └────────────────┘

  Cross-cutting:
   ─ Notifier (Go) ─ webhook · email · slack · sms · push
   ─ Billing  (Go) ─ usage events → metering pipeline → invoices
   ─ Scheduler (Go) ─ cron · delayed jobs · backpressure
```

## Components in one paragraph each

### API Gateway (Rust, Axum + Tower)

The single edge. Terminates TLS, validates JWTs / API keys, applies per-tenant rate limits, and proxies streaming responses (SSE + WebSocket + gRPC bidi). Speaks gRPC inward over mTLS. Stateless and horizontally scaled. Written in Rust for predictable tail latency on the streaming hot path.

### Control Plane (Go)

The system of record for agents, agent versions (bundles), runs, tenants, users, RBAC, API keys, and policies. Postgres-backed. Exposes a public REST + gRPC API and an internal gRPC API consumed by the workflow engine and runtime manager. Uses the K8s API client to create per-tenant namespaces and resource quotas. **Never touches user code or runs anything itself** — it only orchestrates the engine and runtime manager.

### Workflow Engine (Go)

The durable execution heart of Lantern. Event-sourced: every step start, step complete, step failure, and signal becomes an event in a Postgres journal partitioned by run. On crash or restart, the engine replays the journal to reconstruct in-memory state. Implements `step()`, `step.map`, `step.race`, `step.sleep`, signals, queries, child workflows, and the abort/cancel protocol. Scales horizontally via run-id sharding.

### Runtime Manager (Rust)

Owns all interaction with physical compute. Receives "schedule this run on this isolation class" gRPC calls from the workflow engine. Translates to a K8s Job, a Firecracker microVM, a Kata pod, a Wasmtime invocation, or a devcontainer attach. Owns snapshot/restore for fast cold start (<200ms target). Enforces seccomp + egress filtering for untrusted classes. Streams stdout/stderr/events back over gRPC to the engine and gateway.

### Model Router (Rust)

The single point of contact with all LLM providers. Implements a Vercel-AI-Gateway-style unified API: one endpoint, OpenAI Chat Completions and Responses–compatible. Adds:

- **Capability addressing** (`reasoning-large` → vendor model picked at runtime)
- **Cost-aware big/small routing** (tries the cheapest model that historically succeeds at this prompt class; falls back up the ladder on failure or low confidence)
- **Prompt cache** (deduplicates identical prompts within a window)
- **Semantic cache** (embedding-based near-duplicate hit on read-only prompts)
- **Provider failover** (transparent retry against the next provider on 5xx / rate limit)
- **Per-tenant budgets** with hard cuts and warning webhooks
- **Streaming generation IDs** injected on the first token (Vercel pattern) so dashboard reconnects can resume

### Memory Service (Go)

Three-tier memory model borrowed from Letta:

- **Core** — small, always-included scratchpad in the prompt (key-value)
- **Recall** — recent run history searchable by vector + lexical
- **Archival** — long-term knowledge base, vector + structured

Backed by Postgres + pgvector for vector search, Redis for hot KV, and S3 for blob attachments. Multi-scope: tenant, user, agent, run. Encryption at rest with per-tenant keys.

### Notifier (Go)

Listens to engine events. Delivers notifications via webhook, email (SES/Resend), Slack, Discord, and SMS (Twilio — supports A2P 10DLC via a Messaging Service SID). At-least-once with per-channel retry + exponential backoff and idempotency keys. In-app and web push are planned. Cross-provider failover is not yet implemented.

### Billing (Go)

Captures usage events (CPU-seconds, memory-GB-seconds, GPU-seconds, tokens by model, sandbox-hours, storage, egress). Aggregates into a metering pipeline. Per-tenant cost attribution by tag. Hard budget enforcement integrated with the model router.

### Scheduler (Go)

Cron triggers, delayed jobs, retries-with-backoff queue, dead-letter queue. Implements per-tenant fair-share scheduling on top of the engine's run queue.

## End-to-end run lifecycle

```
1. User runs `lantern run my-agent --input '{...}'`
   └─▶ CLI → Gateway → Control Plane: POST /v1/runs

2. Control Plane:
   ├─ validates input against agent.input.schema
   ├─ checks tenant quota and per-user concurrency
   ├─ creates a `runs` row with status=queued and a fresh run_id
   └─ enqueues a workflow on the Workflow Engine

3. Workflow Engine:
   ├─ creates the journal for this run
   ├─ writes RunStarted event
   └─ asks Runtime Manager to schedule the entrypoint step

4. Runtime Manager:
   ├─ consults agent.isolation.class (e.g., "untrusted")
   ├─ selects the matching backend (Firecracker)
   ├─ either restores from a warm snapshot (~28ms) or cold-boots (~150ms)
   ├─ injects the bundle, env, secrets, and a one-shot exec token
   └─ starts the agent process; opens a gRPC stream for stdout/events

5. Agent process executes user code:
   ├─ each step() call hits the engine over gRPC
   │  ├─ if step result already in journal → returned (replay)
   │  └─ otherwise → engine writes StepStarted, executes the side-effect, writes StepCompleted
   ├─ each ctx.llm.* call goes to Model Router → provider → streams tokens back
   └─ each tool call goes to the appropriate runtime (web, fs, python, etc.)

6. Streaming happens concurrently:
   Runtime → Engine → Gateway → SDK / Dashboard
   Tokens, tool calls, step events, log lines all stream live with backpressure.

7. On completion:
   ├─ Engine writes RunCompleted (or RunFailed) and persists final output
   ├─ Notifier sends configured notifications
   ├─ Billing records usage events
   └─ Runtime Manager tears down the sandbox (or returns it to a warm pool)

8. On failure / crash anywhere:
   ├─ Engine replays the journal on the next available worker
   ├─ Side-effects with idempotency keys are safely retried
   └─ Anything past the last successful step is re-attempted with backoff

9. On user cancel:
   ├─ Gateway → Control Plane → Engine → Runtime Manager → SIGTERM the sandbox
   ├─ Engine writes RunCancelled
   └─ Streaming clients receive a final cancel event
```

## Why each language

| Language       | Where                                                                     | Justification                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Go**         | control-plane, workflow-engine, memory, notifier, billing, scheduler, CLI | K8s native (most operators are Go), excellent gRPC + sqlc, single-binary deploys, strong stdlib for the kind of CRUD-and-coordinate work these services do |
| **Rust**       | runtime-manager, gateway, model-router, snapshotter                       | Hot path. Firecracker is Rust. Predictable tail latency, no GC pauses on streaming proxies, native SIMD for embedding hashing in the cache layer           |
| **TypeScript** | sdk-ts (primary), web dashboard, landing, docs site                       | The agent ecosystem already lives here. RSC + streaming in Next.js 15 maps perfectly onto our streaming protocol                                           |
| **Python**     | sdk-python                                                                | Where AI/ML users live                                                                                                                                     |
| **protobuf3**  | packages/proto                                                            | Single source of truth for cross-service types; codegens to all four languages                                                                             |

See [`docs/adr/0001-language-stack.md`](../adr/0001-language-stack.md) for the full reasoning.

## Failure model

We promise:

- **At-least-once** execution of every step. Steps must be idempotent (we provide an idempotency key derived from `(run_id, step_id, attempt)`).
- **Exactly-once** completion observation. The journal is the source of truth.
- **Bounded staleness** of the dashboard: live runs are streamed; history is eventually consistent within ~1s.
- **Crash safety**: any service can be killed at any moment. Replays will reconstruct state correctly.
- **Multi-region durability** in the managed offering (post-spike); single-region in self-hosted (use your own DR).

## Security model (one paragraph; full doc in `10-security.md`)

mTLS between every internal service. JWT for user requests. API keys for SDK requests, scoped per agent. Secrets resolved at runtime by the runtime manager from a per-tenant KMS-backed store; secrets never appear in journals, logs, traces, or run outputs. Untrusted code runs in Firecracker microVMs with seccomp deny-by-default and an egress allowlist. Signed agent bundles via cosign, verified before scheduling. Per-tenant K8s namespaces with NetworkPolicies. Tenant-isolated database rows; tenant-isolated S3 prefixes; per-tenant encryption keys for memory and bundles.

## What's intentionally NOT in this architecture

- **A custom database.** Postgres + Redis + S3 + pgvector. Period.
- **A custom message queue.** Postgres LISTEN/NOTIFY + a polling fallback for the spike; Redis Streams for production scale.
- **A custom container runtime.** We use containerd and firecracker-containerd.
- **A custom service mesh.** mTLS is handled by the gateway and our gRPC stack directly. We do not require Istio/Linkerd.
- **Multi-cloud abstraction layers.** Terraform modules for AWS and GCP, but we don't pretend to be cloud-agnostic in a leaky way.
- **A "framework" for users to extend us.** Users write agents. The platform's surface is the SDK, the bundle, and the gRPC API. No plugin system.

## Where to go next

- [`02-components.md`](02-components.md) — every service in detail
- [`03-data-model.md`](03-data-model.md) — Postgres schemas, Redis keys, S3 layout
- [`04-runtime-isolation.md`](04-runtime-isolation.md) — how runtimes work, snapshot/restore mechanics
- [`05-workflow-engine.md`](05-workflow-engine.md) — event sourcing, replay, determinism
- [`06-model-router.md`](06-model-router.md) — capability addressing, big/small routing, caching
- [`07-context-management.md`](07-context-management.md) — token budgeter, summarization, cache reuse
- [`08-streaming.md`](08-streaming.md) — protocols, backpressure, reconnect resume
- [`10-security.md`](10-security.md) — threat model, mTLS, secrets, isolation
- [`11-testing.md`](11-testing.md) — unit, integration, e2e, security, chaos
