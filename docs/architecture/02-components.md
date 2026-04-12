# Component Reference

> Every service in the Lantern platform, in one place. Read [`01-overview.md`](01-overview.md) first.

This document is the **canonical reference** for what each service does, what it owns, what it depends on, and what its API surface looks like. If a service is not listed here, it does not exist.

## Conventions

- **Owner** — the team responsible (single owner per service).
- **Language** — see [ADR 0001](../adr/0001-language-stack.md).
- **State** — what persistent state the service owns. **No service may write to another service's state directly.**
- **Public surface** — what other services or clients call.
- **Internal surface** — what this service exposes only to other Lantern services over mTLS gRPC.
- **SLO** — service-level objective for the spike phase. Production SLOs are defined per release.

---

## 1. `gateway` — API Gateway

| | |
|---|---|
| **Language** | Rust (Axum + Tower + Tonic) |
| **State** | Stateless. JWT keys cached in memory with rotation; rate-limit counters in Redis |
| **Depends on** | `control-plane` (gRPC), `model-router` (gRPC stream), `surface-gateway` (gRPC) |
| **Public surface** | HTTPS REST, HTTPS SSE, WebSocket, HTTPS gRPC-Web |
| **Internal surface** | gRPC stream proxy |
| **SLO** | p99 latency overhead ≤ 5ms; 99.95% availability |

Single edge for all traffic. Terminates TLS, validates JWT or API key, applies per-tenant rate limits, attaches `tenant_id` and trace context to every downstream request, and proxies streaming responses without buffering. Implements:

- Auth: JWT (RS256) for user requests, API keys (Ed25519-signed) for SDK requests
- Rate limit: token-bucket per tenant + per API key, backed by Redis
- Streaming proxy: SSE, WebSocket, and gRPC server-streaming pass-through with backpressure
- Error normalization: every downstream error becomes a structured `Problem` (RFC 7807)
- OTel tracing of every request

---

## 2. `control-plane` — Control Plane

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres: `tenants`, `users`, `agents`, `agent_versions`, `runs`, `api_keys`, `policies`, `triggers`, `webhooks` (see [`03-data-model.md`](03-data-model.md)) |
| **Depends on** | `workflow-engine`, `runtime-manager`, K8s API, S3 (bundle storage), KMS |
| **Public surface** | REST + gRPC: agents/runs/tenants/RBAC CRUD |
| **Internal surface** | gRPC: `RunCreated`, `BundleResolved`, `AgentVersionChanged` events |
| **SLO** | p99 read ≤ 50ms; p99 write ≤ 200ms; 99.9% availability |

System of record for the entire platform. Owns lifecycle of agents, agent versions (immutable bundles in S3 keyed by digest), runs, tenants, users, RBAC, API keys, webhooks, and policies. Validates input against agent schemas before scheduling. Talks to the K8s API to provision per-tenant namespaces and resource quotas. **Never executes user code.**

Key endpoints (REST surface; gRPC mirrors):
```
POST   /v1/agents
GET    /v1/agents/{name}
POST   /v1/agents/{name}/versions
GET    /v1/agents/{name}/versions/{version}
POST   /v1/runs
GET    /v1/runs/{id}
GET    /v1/runs/{id}/events     SSE
POST   /v1/runs/{id}/cancel
POST   /v1/runs/{id}/signals/{name}
GET    /v1/tenants/{id}/usage
```

---

## 3. `workflow-engine` — Durable Workflow Engine

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres: `journal_events` (partitioned by `run_id`), `step_state`, `run_locks` |
| **Depends on** | `runtime-manager`, `model-router`, `memory`, `notifier` |
| **Public surface** | None (internal only) |
| **Internal surface** | gRPC: `ExecuteRun`, `ResumeRun`, `SignalRun`, `CancelRun`, `StepStream` |
| **SLO** | Step recording p99 ≤ 50ms; replay correctness 100% |

Heart of Lantern. Event-sourced durable execution. Every step start, step complete, step failure, signal, query, and child workflow event becomes an entry in the `journal_events` table partitioned by `run_id`. On crash or restart, the engine reads the journal, reconstructs in-memory state, and the agent code re-runs deterministically — already-journaled steps return cached results, while new steps execute for real.

Implements:
- `step()` — durable side-effect with idempotency key derived from `(run_id, step_id, attempt)`
- `step.map()` — fan-out parallel; partial failures don't lose successful children
- `step.race()` — first-success wins; losers cancelled
- `step.sleep()` — durable sleep that survives restarts (timer wheel + DB poll)
- Signals — wait for external event; signal handler is durable
- Queries — synchronous reads of in-memory workflow state
- Child workflows — sub-agent invocations as nested journal sequences
- Cancellation — cooperative; structured cleanup via `defer`/`finally` semantics

Runs are sharded across engine workers by `run_id` hash. Each run has a Postgres advisory lock to prevent split-brain.

See [`05-workflow-engine.md`](05-workflow-engine.md) for the deep dive.

---

## 4. `runtime-manager` — Runtime Data Plane

| | |
|---|---|
| **Language** | Rust |
| **State** | Local: snapshot pool, warm VM pool, sandbox metadata cache. Authoritative state lives in K8s. |
| **Depends on** | K8s API, containerd / firecracker-containerd, Wasmtime, KMS, S3 (bundles) |
| **Public surface** | None |
| **Internal surface** | gRPC: `Schedule`, `Cancel`, `Stream`, `WarmPool`, `Snapshot` |
| **SLO** | Cold start p99 ≤ 200ms (warm pool), ≤ 1.5s (cold); availability 99.95% |

Owns all interaction with physical compute. Translates "schedule this run on this isolation class" into a concrete backend (K8s Job, Firecracker microVM, Kata pod, Wasmtime invocation, devcontainer). Owns warm pools and snapshot/restore for fast cold starts.

For each isolation class:

| Class | Backend | Cold start target | Warm start target |
|---|---|---|---|
| `trusted` | K8s Job | 1.5s | 100ms (pre-pulled image) |
| `standard` | Firecracker via firecracker-containerd | 1.5s | **150ms (snapshot restore)** |
| `untrusted` | Firecracker + seccomp + egress allowlist | 1.5s | 150ms |
| `hostile` | Kata Containers via K8s RuntimeClass | 2s | 300ms |
| `wasm` | Wasmtime in-process | 5ms | 5ms |
| `devcontainer` | Long-lived pod with attached PVC | 3s | n/a (long-lived) |

Streams stdout, stderr, lifecycle events, and step gRPC traffic between the agent process and the workflow engine.

Enforces:
- seccomp profile per class (deny-by-default for `untrusted` and `hostile`)
- Egress allowlist enforced via eBPF + NetworkPolicy
- Read-only rootfs for `untrusted`
- KMS-resolved secrets injected at exec time, never written to disk
- Resource limits from `agent.yaml.limits` translated to cgroups + Firecracker MMIO

See [`04-runtime-isolation.md`](04-runtime-isolation.md) for the deep dive.

---

## 5. `model-router` — Multi-LLM Router

| | |
|---|---|
| **Language** | Rust |
| **State** | Redis (prompt cache, semantic cache index, capability→model mapping cache, per-tenant budgets) |
| **Depends on** | All upstream LLM providers (OpenAI, Anthropic, Google, xAI, Mistral, Cohere, Together, local Ollama, …) |
| **Public surface** | OpenAI Chat Completions–compatible HTTPS, plus Lantern-native streaming gRPC |
| **Internal surface** | gRPC: `Complete`, `CompleteStream`, `Embed`, `Rerank`, `Tokenize` |
| **SLO** | p50 streaming TTFT overhead ≤ 30ms; failover transparent on 5xx/429 |

The single point of contact with all LLM providers. Implements a Vercel-AI-Gateway-style unified API: one endpoint, OpenAI-compatible, plus first-class capability addressing.

Capabilities (not models):
- `reasoning-large` — best reasoning, high latency, high cost (e.g. GPT-5 reasoning, Claude Opus 4.6, Gemini Ultra)
- `reasoning-small` — fast reasoning, mid cost (e.g. Claude Sonnet, Gemini Flash, GPT-5 mini)
- `chat-large`, `chat-small` — non-reasoning chat
- `vision-large`, `vision-small`
- `embed-large`, `embed-small`
- `rerank` — cross-encoder rerankers
- `code-large`, `code-small`
- `auto` — router picks based on prompt class + history

**Cost-aware big/small routing:**
1. If the agent says `auto`, the router classifies the prompt with a tiny in-process classifier (a fine-tuned ALBERT, ~50ms).
2. It picks the cheapest model historically successful at this class for this tenant.
3. If the response confidence (from the model's logprobs or self-assessment) is below threshold, it escalates to the next-larger model and discards the cheaper attempt.
4. Failure on the chosen provider triggers transparent failover to the next-best provider.

**Caching:**
- **Prompt cache:** SHA-256 of normalized request → response. 24h TTL by default. Per-tenant.
- **Semantic cache:** embedding of the prompt → kNN search in pgvector for near-duplicates within `cosine ≥ 0.985`. Read-only prompts only (no tools).

**Generation IDs** are injected on the first token (Vercel pattern) so dashboard reconnects can resume mid-stream.

See [`06-model-router.md`](06-model-router.md).

---

## 6. `memory` — Memory Service

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres + pgvector, Redis, S3 |
| **Depends on** | KMS for per-tenant encryption keys |
| **Public surface** | None |
| **Internal surface** | gRPC: `Write`, `Read`, `Search`, `Compact`, `Delete` |
| **SLO** | p99 search ≤ 100ms for tier-1; p99 write ≤ 50ms |

Three-tier memory borrowed from Letta:
- **Core** — small key-value, always included in the prompt (~2 KB max). Edited by the agent.
- **Recall** — recent run history; vector + lexical search.
- **Archival** — long-term knowledge base; vector + structured.

Multi-scope: tenant, user, agent, run. Per-tenant encryption keys; pgvector indexed with HNSW; S3 for blobs. Memory writes are journaled by the workflow engine so they replay correctly.

---

## 7. `notifier` — Notifications

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres: `notifications`, `delivery_attempts`, `subscriptions` |
| **Depends on** | Resend/SES (email), Twilio (SMS, voice), Slack, Discord, web push, surface-gateway |
| **Public surface** | None |
| **Internal surface** | gRPC: `Notify`, `ListSubscriptions` |
| **SLO** | First delivery attempt within 1s of event; at-least-once with idempotency |

Listens to engine events. Delivers notifications via webhook, email, Slack, Discord, SMS, voice call, in-app, mobile push, and email reply-bot. At-least-once with idempotency keys. Per-tenant rate limits and provider failover. Templates are versioned and Liquid-based.

---

## 8. `billing` — Metering & Cost Attribution

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres: `usage_events`, `aggregations`, `invoices`, `budgets` |
| **Depends on** | All services that emit usage events |
| **Public surface** | REST: usage/invoices read; budget set |
| **Internal surface** | gRPC: `EmitUsage`, `CheckBudget` |
| **SLO** | Aggregation lag ≤ 60s; budget enforcement ≤ 5s |

Captures usage events: CPU-seconds, memory-GB-seconds, GPU-seconds, tokens by model, sandbox-hours, storage, egress, connector-call counts. Aggregates into a metering pipeline. Per-tenant cost attribution by tag. **Hard budget enforcement is wired into the model router** — when a tenant hits 100% of budget, model calls return a `BudgetExceeded` structured error and the run goes to `paused-on-budget` state until topped up.

---

## 9. `scheduler` — Triggers & Cron

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres: `schedules`, `trigger_state`, `dead_letter` |
| **Depends on** | `control-plane` (to create runs) |
| **Public surface** | None |
| **Internal surface** | gRPC: `RegisterSchedule`, `Trigger` |
| **SLO** | Trigger fire within 5s of scheduled time; 99.9% availability |

Cron triggers, delayed jobs, retries-with-backoff queue, dead-letter queue, per-tenant fair-share scheduling. Implements:

- Cron schedules (`0 9 * * MON`)
- Event-driven triggers (subscribes to internal Kafka/NATS topic)
- Webhook triggers (registered via `control-plane`)
- Delayed runs (`runIn: 5m`)
- Polling triggers (used by connectors that don't support webhooks — e.g. IMAP)

---

## 10. `surface-gateway` — Control Surfaces

| | |
|---|---|
| **Language** | Rust |
| **State** | Postgres: `surface_sessions`, `chat_threads`, `device_registrations`. Redis for presence. |
| **Depends on** | `control-plane`, `workflow-engine`, `notifier` |
| **Public surface** | HTTPS, WebSocket, mobile push gateways (APNs, FCM), Twilio (voice/SMS), email IMAP/SMTP, Slack/Discord/Telegram/WhatsApp APIs |
| **Internal surface** | gRPC: `Inbox`, `SendToAgent`, `RegisterDevice` |
| **SLO** | Bidirectional message latency p99 ≤ 250ms |

The unified entry point for all **non-SDK** ways of driving an agent: mobile apps, chat platforms (Slack, Discord, Telegram, WhatsApp, iMessage), voice (Twilio Voice + Whisper), email, and web push. Implements:

- A **unified inbox** model: every chat thread, email thread, and mobile session is normalized into a `surface_session` with a unique ID
- **Two-way messaging** with running agents: an agent can `await ctx.ask(user, "Question?")` and the user replies from any surface
- **Approval gates over chat**: an agent's `ctx.approval.request(...)` becomes an interactive Slack/iMessage card
- **Live screen-share** for `computer-use` agents: the runtime manager streams desktop frames to the surface-gateway, which forwards to the mobile app
- **Voice interface**: Twilio audio → Whisper → agent input; agent output → ElevenLabs → Twilio audio
- **Email-as-an-interface**: a tenant gets a unique `<tenant>.lantern.email`; replying triggers a run

See [`12-control-surfaces.md`](12-control-surfaces.md).

---

## 11. `connector-hub` — Integration Framework

| | |
|---|---|
| **Language** | Go (framework) + per-connector packages |
| **State** | Postgres: `connector_installs`, `oauth_tokens` (encrypted at rest with per-user KMS), `webhook_subscriptions`, `polling_state` |
| **Depends on** | All third-party APIs, KMS, scheduler |
| **Public surface** | OAuth callback endpoints, webhook ingestion endpoints |
| **Internal surface** | gRPC: `Install`, `Invoke`, `IngestWebhook`, `Poll` |
| **SLO** | Action latency overhead ≤ 100ms over upstream API |

The Zapier-of-Lantern. A framework + library of pre-built integrations with major SaaS apps. Each connector is a typed package that implements:

```go
type Connector interface {
    Manifest() ConnectorManifest      // metadata, OAuth scopes, actions, triggers
    Install(ctx, OAuthCode) (TokenSet, error)
    Refresh(ctx, TokenSet) (TokenSet, error)
    Invoke(ctx, ActionRef, Input) (Output, error)
    IngestWebhook(ctx, raw) ([]TriggerEvent, error)
    Poll(ctx, lastCursor) ([]TriggerEvent, NextCursor, error)
}
```

The framework handles: OAuth flows, token refresh, retry/backoff, rate-limit awareness, webhook signature verification, and polling fallbacks for vendors without webhooks.

The bundled connector library (target: 30 at launch):

| Category | Connectors |
|---|---|
| Communication | Slack, Discord, Telegram, WhatsApp Business, Twilio, Microsoft Teams |
| Email & Calendar | Gmail, Google Calendar, Outlook, Exchange, IMAP/SMTP |
| Docs & Storage | Google Drive, Google Sheets, Google Docs, Notion, Dropbox, OneDrive, Box, Confluence |
| Dev tools | GitHub, GitLab, Bitbucket, Linear, Jira, Sentry, Vercel, Netlify |
| CRM & Sales | HubSpot, Salesforce, Pipedrive, Intercom, Zendesk |
| Productivity | Airtable, Trello, Asana, Monday, ClickUp |
| Commerce | Stripe, Shopify, PayPal |
| Marketing | Mailchimp, Resend, SendGrid |
| Social | Twitter/X, LinkedIn, Reddit, Bluesky |

See [`13-connectors-and-integrations.md`](13-connectors-and-integrations.md).

---

## 12. `builder` — Visual Workflow Builder (frontend)

| | |
|---|---|
| **Language** | TypeScript / React / React Flow |
| **State** | Frontend only; persists to `control-plane` as agent versions |
| **Depends on** | `control-plane`, `connector-hub` (action catalog), `model-router` (capability catalog) |
| **Public surface** | Web app at `/builder` |
| **Internal surface** | n/a |
| **SLO** | Canvas interactions p99 ≤ 50ms |

A drag-and-drop canvas for building workflows visually, aimed at non-technical users. Built on React Flow. Node types:

- **Trigger** — schedule, webhook, manual, connector trigger (e.g. "new email in Gmail")
- **Action** — call a connector action (e.g. "post to Slack")
- **AI step** — call the model router with a prompt template
- **Agent step** — invoke a sub-agent
- **Condition** — branch on a typed expression
- **Loop** — `for each` over a list
- **Parallel** — fan-out
- **Approval** — pause for human approval
- **End** — return a value

The canvas **compiles to the same agent bundle format** that the SDK produces. A non-technical user can build visually; an engineer can take over in code without losing anything. The reverse is also true: an SDK-built agent is rendered on the canvas as long as it stays within the buildable subset.

See [`14-visual-builder.md`](14-visual-builder.md).

---

## 13. `vault` — Personal Credential Vault

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres: encrypted secret blobs; KMS HSM-backed master keys per tenant; per-user data keys wrapped by tenant master |
| **Depends on** | KMS (AWS KMS, GCP KMS, or HashiCorp Vault Transit), `control-plane` |
| **Public surface** | None |
| **Internal surface** | gRPC: `Put`, `Get`, `Delete`, `Rotate`, `WrapForRuntime` |
| **SLO** | p99 read ≤ 30ms; rotation success 100% |

Stores OAuth tokens, API keys, and any personal credentials a user attaches to a workflow. **Per-user envelope encryption** with a tenant-scoped master key. Secrets are never decrypted in memory anywhere except the runtime-manager at exec time, where they're injected via `tmpfs` and zeroed on container exit. Secrets are referenced in agent bundles by ref form `lantern.secret/<id>` and never appear in journals, logs, traces, or run state.

See [`10-security.md`](10-security.md).

---

## Cross-cutting concerns

### Observability — `o11y/`
OTel collector deployment, Tempo for traces, Loki for logs, Mimir for metrics, Grafana for dashboards. Every service is instrumented; every gRPC call propagates trace context.

### Migrations — `migrations/`
Sqlc + golang-migrate for Go services. Sqlx + migrations for Rust services. One migration history per database (Postgres) shared across services that touch it.

### Codegen — `gen/`
Protoc plugins generate gRPC clients/servers, OpenAPI from protos via gnostic, TS clients via ts-proto. Single source of truth in `packages/proto/`.

---

## Service dependency graph

```
                   gateway
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
control-plane    model-router    surface-gateway
   │   │  │
   │   │  └────────────► workflow-engine ──────► runtime-manager
   │   │                       │   │                  │
   │   │                       │   ▼                  ▼
   │   │                       │  memory          k8s / firecracker / kata / wasm / devcontainer
   │   │                       │
   │   ▼                       ▼
   │  scheduler            notifier
   │   │                       │
   │   └─────► connector-hub ──┘
   │
   └─► billing  ◄─────── all services emit usage events
           │
           ▼
         vault
```
