# Component Reference

> Every service in the PAL platform, in one place. Read [`01-overview.md`](01-overview.md) first.

This document is the **canonical reference** for what each service does, what it owns, what it depends on, and what its API surface looks like.

**Status legend.** Each service below describes its target contract. Where the code today is narrower, an *As built* note says so. The authoritative RPC surface is `packages/proto/pal/v1/*.proto`; the authoritative REST surface is `services/control-plane/cmd/server/main.go`. Connectors, the visual builder and the credential store are **not** separate services today - they live in the control-plane and the dashboard (see sections 11-13).

## Conventions

- **Owner** — the team responsible (single owner per service).
- **Language** — see [ADR 0001](../adr/0001-language-stack.md).
- **State** — what persistent state the service owns. **No service may write to another service's state directly.**
- **Public surface** — what other services or clients call.
- **Internal surface** — what this service exposes only to other PAL services over mTLS gRPC.
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

- Auth: JWT for user requests; API keys validated by introspection against the control-plane (`POST /internal/auth/introspect-key`, 60s cache, fail-closed; `services/gateway/src/introspect.rs`)
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
| **Depends on** | `workflow-engine`, `runtime-scheduler`, `runtime-manager`, `model-router`, K8s API, S3 (bundle storage) |
| **Public surface** | REST + gRPC: agents/runs/tenants/RBAC CRUD |
| **Internal surface** | gRPC: `RunCreated`, `BundleResolved`, `AgentVersionChanged` events |
| **SLO** | p99 read ≤ 50ms; p99 write ≤ 200ms; 99.9% availability |

System of record for the entire platform. Owns lifecycle of agents, agent versions (immutable bundles in S3 keyed by digest), runs, tenants, users, RBAC, API keys, webhooks, and policies. Validates input against agent schemas before scheduling. Talks to the K8s API to provision per-tenant namespaces and resource quotas. **Never executes user code.**

Key endpoints (a representative subset; the full list is in `CLAUDE.md` and `cmd/server/main.go`):
```
POST   /v1/agents
GET    /v1/agents/{name}
POST   /v1/runs
GET    /v1/runs/{id}
GET    /v1/runs/{id}/events     SSE
POST   /v1/runtime/schedule     headless microVM runs
POST   /v1/runs/{id}/receipt    signed receipt
POST   /v1/runs/forecast        cost forecast
```

The control-plane also hosts the inline run executor and workflow interpreter (shared tier, [ADR 0022](../adr/0022-two-tier-agent-runtime.md)), connectors, memory/people REST, budgets, evals and the marketplace.

---

## 3. `workflow-engine` — Durable Workflow Engine

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres: `journal_events` (partitioned by `run_id`), `step_state`, `run_locks` |
| **Depends on** | `runtime-manager`, `model-router`, `memory`, `notifier` |
| **Public surface** | None (internal only) |
| **Internal surface** | gRPC `WorkflowEngineService`: `ExecuteRun`, `ResumeRun`, `SignalRun`, `CancelRun`, `QueryRun` (service-token gated, run RPCs tenant-scoped) |
| **SLO** | Step recording p99 ≤ 50ms; replay correctness 100% |

Heart of PAL. Event-sourced durable execution. Every step start, step complete, step failure, signal, query, and child workflow event becomes an entry in the `journal_events` table partitioned by `run_id`. On crash or restart, the engine reads the journal, reconstructs in-memory state, and the agent code re-runs deterministically — already-journaled steps return cached results, while new steps execute for real.

Implements:
- `step()` — durable side-effect with idempotency key derived from `(run_id, step_id, attempt)`
- `step.map()` — fan-out parallel; partial failures don't lose successful children
- `step.race()` — first-success wins; losers cancelled
- `step.sleep()` — durable sleep that survives restarts (timer wheel + DB poll)
- Signals — wait for external event; signal handler is durable
- Queries — synchronous reads of in-memory workflow state
- Child workflows — sub-agent invocations as nested journal sequences
- Cancellation — cooperative; structured cleanup via `defer`/`finally` semantics

Runs are claimed by engine workers under a Postgres advisory lock to prevent split-brain.

*As built:* the full `step.map` / `step.race` / `step.sleep` SDK surface is the design target; leaf dispatch implemented today covers `llm_call` (via model-router), `tool_call` (via `RuntimeManager.ExecTool`) and `child_run` (see CLAUDE.md). Run traffic on the primary dev path executes in the control-plane inline executor instead ([ADR 0022](../adr/0022-two-tier-agent-runtime.md)).

See [`05-workflow-engine.md`](05-workflow-engine.md) for the deep dive.

---

## 4. `runtime-manager` — Runtime Data Plane

| | |
|---|---|
| **Language** | Rust |
| **State** | Local: snapshot pool, warm VM pool, sandbox metadata cache. Authoritative state lives in K8s. |
| **Depends on** | K8s API, Firecracker / Kata / containerd, Wasmtime, control-plane (secret relay), S3 (bundles) |
| **Public surface** | None |
| **Internal surface** | gRPC `RuntimeManager`: `Spawn`, `Stop`, `Logs`, `Exec`, `ExecTool`, `Stats`, `Snapshot` |
| **SLO** | Cold start p99 ≤ 200ms (warm pool), ≤ 1.5s (cold); availability 99.95% |

Owns all interaction with physical compute. Translates "schedule this run on this isolation class" into a Kubernetes pod with the appropriate `runtimeClassName` ([ADR 0009](../adr/0009-kubernetes-default-runtime-substrate.md)). Owns warm pools and snapshot/restore for fast cold starts.

> **Substrate update (2026-06-18):** [ADR 0009](../adr/0009-kubernetes-default-runtime-substrate.md) supersedes the class-to-backend table below. Kubernetes is the default substrate; isolation is a `runtimeClassName` on the pod, not five separate backends. Current mapping: `TRUSTED` → `runc`; `STANDARD`/`UNTRUSTED` → `gvisor`; `HOSTILE` → `kata-qemu`/`kata-fc` (dedicated pool); `WASM` → `crun+wasm`; `DEVCONTAINER` → long-lived pod + PVC, `gvisor`. The table below (Firecracker as STANDARD default) is the ADR 0002 design, kept for the latency targets only.

For each isolation class (ADR 0002 design — see ADR 0009 for current mapping):

| Class | Backend | Cold start target | Warm start target |
|---|---|---|---|
| `trusted` | K8s Job | 1.5s | 100ms (pre-pulled image) |
| `standard` | Firecracker via firecracker-containerd | 1.5s | **150ms (snapshot restore)** |
| `untrusted` | Firecracker + seccomp + egress allowlist | 1.5s | 150ms |
| `hostile` | Kata Containers via K8s RuntimeClass | 2s | 300ms |
| `wasm` | Wasmtime in-process | 5ms | 5ms |
| `devcontainer` | Long-lived pod with attached PVC | 3s | n/a (long-lived) |

Streams stdout, stderr and lifecycle events from the harness back to the control-plane.

Enforces:
- seccomp profile per class (deny-by-default for `untrusted` and `hostile`)
- Egress allowlist: NetworkPolicy on the host plus the in-VM harness CONNECT proxy with an iptables REDIRECT (fail-closed in prod; see 04b)
- Read-only rootfs for `untrusted`
- Secrets vended by the harness over `/run/pal/secrets.sock` via the control-plane relay ([ADR 0008](../adr/0008-runtime-secret-relay.md)); never baked into the image
- Resource limits from `agent.yaml.limits` translated to cgroups + Firecracker MMIO

**Sandbox lifecycle (microVM tier, Firecracker).** `Snapshot` + `Stop` implement **pause**; a `Spawn` with `restore_snapshot_id` implements **resume** (same `vm_id`) and **fork** (N new `vm_id`s from one snapshot, up to `PAL_MAX_FORK_COUNT` (default 100, ceiling 1000) via `POST /v1/runtime/vms/{id}/fork`). A restore is a new identity: fresh cert, exec token, and network address, which the in-guest harness adopts (`re-identify`); the registry pins the current incarnation's cert so a snapshot-frozen cert is refused. Snapshots are tenant-owned; restoring another tenant's returns `NOT_FOUND`.

**Spawn contract.** The manager writes `spawn.json` (workload command, env, egress rules, `workload_uid`/`gid`) onto the read-only cert drive; the harness reads it at boot and drops the workload to that uid. The manager, not the caller, chooses the uid.

**Per-call authz.** Every `RuntimeManager` RPC requires `x-pal-service-token` (`PAL_GRPC_SERVICE_TOKEN`, constant-time compare; the manager refuses to start in prod without it). A per-VM cert (`OU=pal-vm`) is refused on all `RuntimeManager` methods and may reach only its own `RuntimeHarness` channel. `ExecTool` is scoped by `tenant_id`. Details: [ADR 0025](../adr/0025-sandbox-spawn-contract-and-manager-authz.md); diagrams: [`runtime-two-tier.svg`](../assets/diagrams/runtime-two-tier.svg), [`sandbox-lifecycle.svg`](../assets/diagrams/sandbox-lifecycle.svg).

See [`04-runtime-isolation.md`](04-runtime-isolation.md) for the deep dive.

---

## 5. `model-router` — Multi-LLM Router

| | |
|---|---|
| **Language** | Rust |
| **State** | Redis (prompt cache, 24h TTL) |
| **Depends on** | Upstream LLM providers (OpenAI and Anthropic wired today; others per `providers/`) |
| **Public surface** | OpenAI Chat Completions–compatible HTTPS, plus PAL-native streaming gRPC |
| **Internal surface** | gRPC `ModelService`: `Complete`, `CompleteStream`, `Embed`, `Tokenize` |
| **SLO** | p50 streaming TTFT overhead ≤ 30ms; failover transparent on 5xx/429 |

The single point of contact with all LLM providers. Implements a Vercel-AI-Gateway-style unified API: one endpoint, OpenAI-compatible, plus first-class capability addressing.

Capabilities (not models):
- `reasoning-large` — best reasoning, high latency, high cost (e.g. GPT-5 reasoning, Claude Opus 4.6, Gemini Ultra)
- `reasoning-small` — fast reasoning, mid cost (e.g. Claude Sonnet, Gemini Flash, GPT-5 mini)
- `chat-large`, `chat-small` — non-reasoning chat
- `vision-large`, `vision-small`
- `embed-large`, `embed-small`
- `rerank` — cross-encoder rerankers (planned; no `Rerank` RPC yet)
- `code-large`, `code-small`
- `auto` — router picks based on prompt class + history

**Routing (as built):** the router ranks candidate models by strategy (`cheap`, `fast`, `best`, plus capability scoring) and fails over transparently to the next provider on error, marking the response `escalated`.

*Design target, not yet in the router source:* a prompt-class classifier with history-based big/small selection and confidence-triggered escalation.

**Caching:**
- **Prompt cache (built):** normalized request to response in Redis, 24h TTL.
- **Semantic cache (design target, not yet built):** embedding kNN for near-duplicates on read-only prompts.

**Generation IDs** are injected on the first token (Vercel pattern) so dashboard reconnects can resume mid-stream.

**Auth.** The gRPC port is a trust boundary: callers must present `x-pal-service-token` (`PAL_GRPC_SERVICE_TOKEN`, invariant #7).

See [`06-model-router.md`](06-model-router.md).

---

## 6. `memory` — Memory Service

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres + pgvector, Redis, S3 |
| **Depends on** | KMS for per-tenant encryption keys |
| **Public surface** | None directly; the platform serves memory over REST from the control-plane (`/v1/memory/*`, `/v1/people/*`) |
| **Internal surface** | HTTP/health only today. There is no memory proto on purpose ([ADR 0013](../adr/0013-billing-scheduler-grpc-memory-rest.md)); `Write`/`Read`/`Search` are the logical operations |
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

Listens to engine events. Delivers via webhook, email, Slack, Discord and SMS (Twilio); in-app and push are planned. At-least-once with idempotency keys. Cross-provider failover is not yet implemented.

---

## 8. `billing` — Metering & Cost Attribution

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres: `usage_events`, `aggregations`, `invoices`, `budgets` |
| **Depends on** | All services that emit usage events |
| **Public surface** | REST: usage/invoices read; budget set |
| **Internal surface** | gRPC `BillingService`: `EmitUsage`, `CheckBudget`, `GetUsage`, `SetBudget` |
| **SLO** | Aggregation lag ≤ 60s; budget enforcement ≤ 5s |

Captures usage events: CPU-seconds, memory-GB-seconds, GPU-seconds, tokens by model, sandbox-hours, storage, egress, connector-call counts. Aggregates into a metering pipeline. Per-tenant cost attribution by tag. **Hard budget enforcement is wired into the model router** — when a tenant hits 100% of budget, model calls return a `BudgetExceeded` structured error and the run goes to `paused-on-budget` state until topped up. In the control plane, budgets are per agent plus an optional **tenant-wide daily cap** (`PUT /v1/budgets/tenant`, enforced on agentless `/v1/completions` too); workflow `ai-step` and built-in `web_search` spend is metered via `CheckBudget`/`RecordUsage`.

---

## 9. `scheduler` — Triggers & Cron

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres: `schedules`, `trigger_state`, `dead_letter` |
| **Depends on** | `control-plane` (to create runs) |
| **Public surface** | None |
| **Internal surface** | gRPC `SchedulerService`: `RegisterSchedule`, `ListSchedules`, `DeleteSchedule`, `Trigger` |
| **SLO** | Trigger fire within 5s of scheduled time; 99.9% availability |

Cron triggers, delayed jobs, retries-with-backoff queue, dead-letter queue, per-tenant fair-share scheduling. Implements:

- Cron schedules (`0 9 * * MON`)
- Timezone-aware matching (`timezone` on the schedule, `PAL_DEFAULT_TIMEZONE`)
- Webhook triggers (registered via `control-plane`)
- Delayed runs (`runIn: 5m`)

Event-bus and polling triggers are planned; no Kafka/NATS dependency exists today.

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
- **Email-as-an-interface**: a tenant gets a unique `<tenant>.pal.email`; replying triggers a run

See [`12-control-surfaces.md`](12-control-surfaces.md).

---

## 11. `connector-hub` — Integration Framework (not a separate service)

> *As built:* connectors (17 real connector APIs) execute inside the control-plane (`POST /v1/connectors/{id}/execute`); there is no `services/connector-hub`. The table below is the design contract.

| | |
|---|---|
| **Language** | Go (framework) + per-connector packages |
| **State** | Postgres: `connector_installs`, `oauth_tokens` (encrypted at rest with per-user KMS), `webhook_subscriptions`, `polling_state` |
| **Depends on** | All third-party APIs, KMS, scheduler |
| **Public surface** | OAuth callback endpoints, webhook ingestion endpoints |
| **Internal surface** | gRPC: `Install`, `Invoke`, `IngestWebhook`, `Poll` |
| **SLO** | Action latency overhead ≤ 100ms over upstream API |

The Zapier-of-PAL. A framework + library of pre-built integrations with major SaaS apps. Each connector is a typed package that implements:

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

## 12. `builder` — Visual Workflow Builder (frontend; part of `apps/web`)

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

## 13. `vault` — Personal Credential Vault (design; not a separate service)

> *As built:* credentials are AES-256-GCM-encrypted at rest in the control-plane (`internal/secrets`, `PAL_CREDENTIAL_KEY`) and vended to workloads through the secret relay ([ADR 0008](../adr/0008-runtime-secret-relay.md)). There is no `services/vault`.

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres: encrypted secret blobs; KMS HSM-backed master keys per tenant; per-user data keys wrapped by tenant master |
| **Depends on** | KMS (AWS KMS, GCP KMS, or HashiCorp Vault Transit), `control-plane` |
| **Public surface** | None |
| **Internal surface** | gRPC: `Put`, `Get`, `Delete`, `Rotate`, `WrapForRuntime` |
| **SLO** | p99 read ≤ 30ms; rotation success 100% |

Stores OAuth tokens, API keys, and any personal credentials a user attaches to a workflow. **Per-user envelope encryption** with a tenant-scoped master key. Secrets are referenced in agent bundles by ref form `pal.secret/...` (URI form `pal.secret://<tenant>/key/<name>` in `agent.yaml`) and never appear in journals, logs, traces, or run state.

See [`10-security.md`](10-security.md).

---

## 14. `runtime-scheduler` — MicroVM Placement

| | |
|---|---|
| **Language** | Go |
| **State** | Postgres: `runtime_vms`, audit/quota tables |
| **Depends on** | `runtime-manager` |
| **Public surface** | REST `:8085` (health/ops) |
| **Internal surface** | gRPC `RuntimeScheduler` on `:50055`: `Schedule`, `Events`, `List`, `Terminate`, `Snapshot`, `Cluster`, `Pause`, `Resume`, `Fork` (service-token gated) |

Places headless agent microVMs: warm pool, region, fair-share, cost and health factors. The control-plane (`/v1/runtime/schedule`) enforces tenant quota (HTTP 402) before calling it. See [`04b-microvm-productionization.md`](04b-microvm-productionization.md).

---

## 15. `harness` — In-VM PID 1

Rust binary baked into the VM image. Enforces the egress allowlist, vends secrets over a peer-authenticated unix socket, drops the workload to a non-root uid, and streams heartbeats, logs and audit events to the manager over `RuntimeHarness` (`Heartbeat`, `VendSecret`, `Report`, `Exec`).

---

## Other services

`data-plane-agent` (customer-cloud data-plane registration/heartbeat, `dataplane.proto`), `surface-gateway` (section 10), and the macOS `imessage-bridge` / `whatsapp-bridge` personal-assistant services (see `CLAUDE.md`) complete the tree under `services/`.

---

## Cross-cutting concerns

### Observability — `o11y/`
OTel collector deployment, Tempo for traces, Loki for logs, Mimir for metrics, Grafana for dashboards. Every service is instrumented; every gRPC call propagates trace context.

### Migrations — `migrations/`
Control-plane migrations are idempotent SQL under `services/control-plane/internal/db/` (`migrate.go` plus numbered files in `migrations/`); a proper migration tool is the production target.

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

  microVM path (headless runs): control-plane ─► runtime-scheduler (:50055)
  ─► runtime-manager (:50054) ─► Firecracker VM (harness PID 1). Each hop
  presents x-pal-service-token (control-plane ─► scheduler, scheduler ─►
  manager, control-plane ─► model-router). The engine's ExecTool client to the
  manager still needs the token attached before prod enables it (ADR 0025 §2).
```
