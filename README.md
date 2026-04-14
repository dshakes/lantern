# Lantern

**Production runtime for AI agents** -- open source, multi-model, deploy anywhere.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-lantern.dev-8B5CF6?style=flat-square)](https://docs.lantern.dev)
[![Discord](https://img.shields.io/discord/placeholder?label=discord&style=flat-square&color=5865F2)](https://discord.gg/lantern)

Lantern is an open-source platform for building, running, and managing production AI agents. It combines durable workflow execution, multi-LLM routing across providers, real API connectors, and a visual dashboard -- all deployable to your own cloud or as a managed service.

---

## Key features

- **Managed sessions** -- Interactive, durable, multi-turn agent sessions with SSE streaming. Users send messages, agents respond in real time, and sessions persist across restarts.
- **Smart model routing** -- Capability-based addressing (`auto`, `reasoning-large`, `code-large`) with intelligent scoring across Claude Opus/Sonnet/Haiku, GPT-4o/4o-mini, and Gemini. Router scores models on quality (40%), speed (30%), cost (30%). Strategies: `balanced`, `cheap`, `quality`, `fast` via `LANTERN_ROUTE_STRATEGY`.
- **17 real connector APIs** -- Gmail, Google Calendar, Google Drive, Google Sheets, Slack, Discord, Telegram, Twilio, GitHub, Linear, Jira, Sentry, Vercel, Notion, HubSpot, Salesforce, Stripe. OAuth and API-key auth, live API calls.
- **Visual workflow editor** -- Drag-and-drop React Flow editor for building agent workflows with triggers, LLM steps, tool calls, conditionals, and output nodes.
- **AI-assisted agent creation** -- Describe what you want in plain English; the platform generates agent name, description, system prompt, and instructions automatically.
- **Instructions + System prompt separation** -- Instructions define the agent's goals, scope, and constraints. System prompt defines personality, tone, and output format. Both are independently editable and AI-generatable.
- **Guardrails** -- Built-in PII blocking, content filtering, and topic blocking. Configurable per-agent at creation time.
- **Cron scheduling with email delivery** -- Schedule agents on cron expressions with optional email delivery of results. The scheduler fires due jobs automatically.
- **MCP server support** -- Connect to Model Context Protocol servers for tool and resource access.
- **Multi-agent handoff** -- Agent-to-agent delegation via `ctx.subagent()` and A2A protocol support.
- **Conversation memory** -- Three-tier memory (core KV, recall vector search, archival long-term) backed by pgvector.
- **File attachments + code interpreter** -- Python code execution in sandboxed environments, file system access within agent runs.
- **Privacy levels** -- Standard (encrypted at rest), Private (end-to-end encrypted), and Audit-logged (full compliance trail). Selectable per-agent.
- **Deploy into customer cloud** -- Control plane / data plane split architecture. Data plane runs in the customer VPC; only metadata crosses the tunnel boundary.

---

## Quick start

```bash
# 1. Start infrastructure (Postgres, Redis, MinIO)
make dev-infra

# 2. Run the API server (in a separate terminal)
make run-api

# 3. Run the dashboard (in a separate terminal)
make dashboard-dev
```

The dashboard is at `http://localhost:3000`. Log in with `admin@lantern.dev` / `lantern`.

From there you can create agents, start interactive sessions, connect APIs, schedule runs, and use the visual workflow editor.

---

## Architecture

```
                         +--------------------+
     SDK / CLI / --------|  API Gateway       |
     Dashboard           |  (Go, :8080)       |
                         +---------+----------+
                                   |
               +-------------------+-------------------+
               v                   v                   v
     +------------------+  +--------------+   +----------------+
     |  Control Plane   |  | LLM Proxy    |   |   Scheduler    |
     |  agents, runs,   |  | multi-model  |   |   cron jobs    |
     |  sessions, auth  |  | routing      |   |   email notify |
     +--------+---------+  +--------------+   +----------------+
              |
              |  Postgres (pgvector), Redis, S3/MinIO
              |
     +--------+---------+----------+-----------+
     |  Connectors      | Sessions | Surfaces  |
     |  17 real APIs    | SSE/RT   | webhooks  |
     +------------------+----------+-----------+

                    | gRPC tunnel (outbound-only)
 ==========================================
     DATA PLANE (customer VPC)

          +---------+----------+
          | Workflow Engine     |   Runtime Manager
          | durable execution  |   Firecracker / K8s
          +--------------------+-------------------+
```

The control plane manages agents, sessions, connectors, scheduling, and LLM routing. The data plane (optional, for hybrid deployments) runs agent code in customer infrastructure with Firecracker microVM isolation.

---

## Project structure

```
lantern/
  services/
    control-plane/        Go    -- API, auth, agents, runs, sessions, connectors, schedules
    workflow-engine/       Go    -- durable execution, event sourcing
    gateway/              Rust  -- API edge, rate limiting, streaming proxy
    model-router/         Rust  -- multi-LLM routing, caching, cost optimization
    runtime-manager/      Rust  -- Firecracker, Kata, K8s Job orchestration
    surface-gateway/      Rust  -- omnichannel webhooks
    scheduler/            Go    -- cron, delayed jobs
    memory/               Go    -- core/recall/archival, pgvector
    notifier/             Go    -- webhooks, email, Slack, SMS
    billing/              Go    -- usage metering, cost attribution
  packages/
    sdk-ts/               TS    -- primary SDK: agent(), step(), tools
    sdk-python/           Py    -- secondary SDK
    cli/                  Go    -- `lantern` CLI (Cobra)
    proto/                proto -- gRPC definitions
    ui-kit/               TS    -- shared React component library
  apps/
    web/                  TS    -- Next.js 15 dashboard (RSC + streaming)
    landing/              TS    -- marketing site
  infra/
    docker/                     -- docker-compose dev stack
    helm/                       -- Helm charts (all-in-one, control-plane, data-plane)
    terraform/                  -- AWS/GCP IaC modules
  examples/                     -- reference agent implementations
  docs/
    architecture/               -- design documents
    adr/                        -- Architecture Decision Records
```

---

## Local development

### Prerequisites

- Docker and Docker Compose
- Go 1.23+
- Node.js 22+ and npm

### Dev credentials

| Service | Credentials |
|---|---|
| PostgreSQL | `lantern:lantern@localhost:5432/lantern` |
| Redis | `localhost:6379` |
| MinIO | `lantern:lanternsecret` at `localhost:9000` (console `:9001`) |
| Dashboard | `admin@lantern.dev` / `lantern` |

### Make targets

| Target | What it does |
|---|---|
| `make dev` | Full docker-compose stack |
| `make dev-infra` | Postgres + Redis + MinIO only |
| `make run-api` | Control-plane API on `:8080` |
| `make dashboard-dev` | Next.js dashboard on `:3000` |
| `make build` | Compile Go + Rust + TypeScript |
| `make proto` | Regenerate from proto definitions |
| `make test` | All test suites |
| `make lint` | All linters |
| `make ci-local` | Lint + test + audit (same as CI) |

---

## Contributing

1. Read [`CLAUDE.md`](CLAUDE.md) for repo conventions and architectural invariants.
2. Read the relevant [ADR](docs/adr/) if your change affects a load-bearing decision.
3. Run `make ci-local` before pushing.

---

## License

Apache 2.0. See [LICENSE](LICENSE).
