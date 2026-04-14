# CLAUDE.md -- Working in the Lantern repo

This file is loaded automatically by Claude Code (and any AGENTS.md-aware AI assistant) when working in this repository. It is the **single source of truth for repo conventions, architectural invariants, and what NOT to do**.

If you are an AI assistant: read this top-to-bottom before your first edit. Then re-read the relevant section before each task.

---

## Project in one sentence

Lantern is a **production runtime for AI agents** -- multi-LLM routing (4 strategies), managed sessions, 17 real connector APIs, MCP marketplace, A2A agent cards, agent marketplace, evaluations dashboard, visual workflow editor, cron scheduling, managed cloud hosting, Python SDK at full parity, and guardrails, with a control-plane/data-plane split for customer-cloud or managed-cloud deployments.

For the full vision read `README.md`. For the architecture read `docs/architecture/01-overview.md`.

---

## Languages and where to use what

This is a **polyglot monorepo on purpose**. Pick the right tool for the layer; do not unify for unification's sake.

| Layer | Language | Why |
|---|---|---|
| Control plane, workflow engine, scheduler, memory, notifier, billing | **Go 1.23** | K8s-native, single binary, mature gRPC + Postgres ecosystem |
| Gateway, model router, runtime manager, surface gateway | **Rust 2024** | Hot path; Firecracker is Rust; predictable latency and memory |
| Dashboard, landing, docs site | **TypeScript / Next.js 15** | RSC + streaming, our SDK's primary language already |
| Primary SDK | **TypeScript** | Where the agent ecosystem lives |
| Secondary SDKs | **Python 3.11+**, **Go** | Python for AI/ML users, Go for infra users |
| CLI (`lantern`) | **Go / Cobra** | Static binary, cross-compile easy, reuses our gRPC client |
| API contracts | **protobuf3** | Single source of truth for cross-service types |

**Do not introduce a new language without an ADR.** See `docs/adr/0001-language-stack.md`.

---

## Architectural invariants

These are **load-bearing**. Violating them silently will cause incidents. If you think one needs to change, write an ADR first.

1. **Control plane never touches user code.** Only the runtime manager interacts with Firecracker / Kata / pods. Control plane talks to runtime manager over gRPC.
2. **Workflow engine is the only thing that mutates run state.** Services emit events; the engine is authoritative. No service writes to the `runs` table directly.
3. **All long operations are durable.** Anything that can take >100ms or call an LLM goes through the workflow engine as a `step`. Steps are idempotent and replayable.
4. **Streaming is end-to-end.** Token streams flow runtime -> gateway -> SDK -> dashboard with no buffering points other than backpressure-aware channels. No service may collect a full response and then forward.
5. **Untrusted code runs in a microVM.** User-supplied code, Python `exec`, browser automation, anything that loads packages from the internet -- Firecracker or Kata only. Never a bare pod.
6. **Models are addressed by capability, not name.** SDK code says `model: "auto"` or `model: "reasoning-large"`. The model router maps to a concrete vendor model. Never hardcode `gpt-5` in service code.
7. **Multi-tenant by default.** Every row has `tenant_id`; every gRPC call carries a `tenant_id` in metadata; every K8s namespace is `lantern-t-<tenant_id>`. No cross-tenant joins, ever.
8. **Idempotency is required for every external side-effect.** Webhook deliveries, model API calls, K8s create -- all carry an idempotency key derived from `(run_id, step_id, attempt)`.
9. **Observability is not optional.** Every service emits OTel traces with `tenant_id`, `run_id`, `step_id`, `agent_version`. A service that can't be traced is broken.
10. **Secrets never appear in logs, traces, or run state.** Use the `lantern.secret/...` ref form; the runtime resolves at execution time.

---

## Local development

### Starting the dev stack

```bash
# Infrastructure only (Postgres, Redis, MinIO) -- typical workflow
make dev-infra

# Run the control-plane API locally (terminal 1)
make run-api

# Run the Next.js dashboard in dev mode (terminal 2)
make dashboard-dev

# Full stack (all services + infrastructure via docker-compose)
make dev
```

`make run-api` sets the correct env vars (`DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `LOG_LEVEL`) for connecting to the Dockerized Postgres/Redis/MinIO. Do not run `go run ./cmd/server` bare -- it defaults to your OS user for Postgres auth and will fail.

### Dev credentials

| Service | Value |
|---|---|
| PostgreSQL | `postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable` |
| Redis | `redis://localhost:6379` |
| MinIO | `lantern:lanternsecret` at `localhost:9000` (console `:9001`) |
| Dashboard login | `admin@lantern.dev` / `lantern` (email+password) |
| JWT secret | `lantern-dev-jwt-secret-do-not-use-in-production` |
| Dev tenant ID | `00000000-0000-0000-0000-000000000001` (slug: `dev`) |
| Dev user ID | `00000000-0000-0000-0000-000000000002` (role: `owner`) |

### Google OAuth (optional)

To enable "Sign in with Google" locally:

1. Create a Google Cloud OAuth 2.0 Client ID at [console.cloud.google.com](https://console.cloud.google.com/apis/credentials).
2. Set authorized redirect URI to `http://localhost:8080/auth/oauth/google/callback`.
3. Export the credentials before running the API:
   ```bash
   export GOOGLE_CLIENT_ID="your-client-id"
   export GOOGLE_CLIENT_SECRET="your-client-secret"
   make run-api
   ```

Without these env vars, Google OAuth is disabled and the sign-in button will show an error. Email+password login always works.

### Service ports

| Service | Port | Protocol |
|---|---|---|
| control-plane | `:8080` | HTTP (REST + health + SSE) |
| control-plane (gRPC) | `:50051` | gRPC |
| dashboard | `:3000` | HTTP (Next.js dev) |
| workflow-engine | `:50052` | gRPC |
| model-router | `:50053` | gRPC |
| runtime-manager | `:50054` | gRPC |
| gateway | `:8443` | HTTPS (TLS) |
| surface-gateway | `:8000` | HTTP (webhooks) |
| PostgreSQL | `:5432` | postgres |
| Redis | `:6379` | redis |
| MinIO | `:9000` / `:9001` | S3 / console |

### Frontend dev

```bash
make dashboard-dev    # Next.js dashboard at localhost:3000
make landing-dev      # Landing page
```

### Dashboard sidebar (8 items)

The dashboard sidebar (`apps/web/components/sidebar.tsx`) has these navigation items:

1. Agents
2. Runs
3. Surfaces
4. Connectors
5. Deployments
6. Marketplace
7. Evaluations
8. Settings

Dashboard pages live in `apps/web/app/(dashboard)/`. Key pages include:

- `/agents` -- agent list + create + detail with sessions, runs, workflow editor
- `/runs` -- run list + detail with event stream
- `/surfaces` -- surface configuration (WhatsApp, Slack, Telegram, webchat)
- `/connectors` -- connector installation and management
- `/deployments` -- deployment tracking and data-plane management
- `/marketplace` -- discover and fork public agents, browse MCP servers
- `/evaluations` -- agent performance metrics, cost attribution, model usage
- `/settings` -- LLM providers, API keys, team management

---

## Data stores and schema

**Postgres** is the primary database (pgvector/pgvector:pg16). **Redis** is for caching, rate limiting, session pub/sub (SSE events), and queues. **S3/MinIO** is for agent bundles, snapshots, and large attachments.

Do not introduce a new database without an ADR. These three cover all current needs.

### Core tables

Migrations live in `services/control-plane/internal/db/migrate.go` (idempotent `CREATE TABLE IF NOT EXISTS`). In production, use a proper migration tool (golang-migrate or Atlas).

| Table | Purpose | Key columns |
|---|---|---|
| `tenants` | Multi-tenant root | `id`, `slug`, `tier`, `k8s_namespace`, `settings` (JSONB) |
| `users` | Auth, linked to tenant | `tenant_id`, `email`, `auth_provider`, `password_hash`, `role` |
| `agents` | Agent definitions | `tenant_id`, `name`, `current_version_id`, `labels` (JSONB) |
| `agent_versions` | Immutable versioned bundles | `agent_id`, `version`, `digest`, `bundle_uri`, `manifest` (JSONB) |
| `runs` | Run lifecycle | `tenant_id`, `agent_id`, `status`, `input`/`output` (JSONB), `cost_usd`, `tokens_in`/`out` |
| `journal_events` | Event-sourced run log | `run_id`, `seq`, `kind`, `step_id`, `payload` (PK: `run_id, seq`) |
| `run_locks` | Distributed run locking | `run_id`, `worker_id`, `expires_at` |
| `sessions` | Interactive multi-turn agent sessions | `tenant_id`, `agent_name`, `status`, `messages` (JSONB) |
| `schedules` | Cron-based agent execution | `tenant_id`, `agent_name`, `cron_expr`, `enabled`, `next_fire_at`, `config` (JSONB) |
| `connector_installs` | OAuth / API-key integration state | `tenant_id`, `connector_id`, `oauth_token_encrypted`, `config` (JSONB) |
| `surface_configs` | Channel configuration | `tenant_id`, `surface_id`, `webhook_url` |
| `api_keys` | API key management | `tenant_id`, `key_hash`, `key_prefix`, `scopes` |
| `deployments` | Deployment tracking | `tenant_id`, `agent_name`, `version`, `environment`, `status` |
| `data_planes` | Registered data planes | `tenant_id`, `cloud`, `region`, `status`, `last_heartbeat` |
| `llm_provider_configs` | LLM API keys per tenant | `tenant_id`, `provider`, `api_key_encrypted` |

Row-Level Security is enabled on `agents` and `runs` with tenant isolation policies.

A dev tenant (`slug: dev`) and admin user (`admin@lantern.dev` / `lantern`) are seeded on startup.

---

## REST API endpoints

The control-plane exposes REST on `:8080`. All authenticated endpoints require a `Bearer` JWT token.

### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/register` | Register new user |
| `POST` | `/auth/login` | Email+password login |
| `GET` | `/auth/me` | Current user info |
| `GET` | `/auth/oauth/google/...` | Google OAuth flow |

### Agents
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/agents` | Create agent |
| `GET` | `/v1/agents` | List agents |
| `GET` | `/v1/agents/{name}` | Get agent by name |
| `DELETE` | `/v1/agents/{name}` | Delete agent |
| `POST` | `/v1/agents/generate-spec` | AI-generate agent spec from description |
| `POST` | `/v1/agents/generate-code` | AI-generate agent code |

### Runs
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/runs` | Create and execute a run |
| `GET` | `/v1/runs` | List runs |
| `GET` | `/v1/runs/{id}` | Get run details |
| `GET` | `/v1/runs/{id}/events` | Stream run events (SSE) |

### Sessions (interactive)
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/sessions` | Create a new session |
| `GET` | `/v1/sessions` | List sessions |
| `GET` | `/v1/sessions/{id}` | Get session details |
| `POST` | `/v1/sessions/{id}/messages` | Send message (triggers LLM response) |
| `GET` | `/v1/sessions/{id}/events` | Stream session events (SSE) |
| `POST` | `/v1/sessions/{id}/stop` | Stop a running session |
| `DELETE` | `/v1/sessions/{id}` | Delete session |

### Connectors
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/connectors/install` | Install a connector |
| `GET` | `/v1/connectors` | List installed connectors |
| `GET` | `/v1/connectors/{connectorId}/execute?action=...` | Execute connector action |
| `POST` | `/v1/connectors/{connectorId}/execute` | Execute connector action (with body) |
| `POST` | `/v1/connectors/{id}/test` | Test connector connection |
| `DELETE` | `/v1/connectors/{id}` | Uninstall connector |

### Schedules
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/schedules` | Create/upsert schedule |
| `GET` | `/v1/schedules` | List schedules |
| `PUT` | `/v1/schedules/{id}` | Update schedule |
| `DELETE` | `/v1/schedules/{id}` | Delete schedule |

### Completions (LLM proxy)
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/completions` | LLM completion (routes to configured providers) |

### Settings
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/settings/llm-providers` | Save LLM provider API key |
| `GET` | `/v1/settings/llm-providers` | List configured providers |
| `POST` | `/v1/settings/llm-providers/{provider}/test` | Test provider connection |

### Deployments
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/deployments` | Create deployment |
| `GET` | `/v1/deployments` | List deployments |
| `GET` | `/v1/deployments/{id}` | Get deployment |
| `POST` | `/v1/agents/{name}/deploy` | One-click managed cloud deploy |
| `POST` | `/v1/data-planes` | Register data plane |
| `GET` | `/v1/data-planes` | List data planes |
| `DELETE` | `/v1/data-planes/{id}` | Remove data plane |

### A2A (Agent-to-Agent)
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/agents/{name}/card` | Get agent's A2A card |
| `GET` | `/.well-known/agent.json` | Well-known A2A discovery endpoint |

---

## What to do, and what NOT to do

### DO
- Read the relevant ADR before changing a load-bearing decision.
- Add a test for every bug fix (regression test) and every new code path.
- Prefer **editing existing files** over creating new ones. The repo already has its shape.
- Use `make proto` to regenerate types after changing a `.proto`. Never hand-edit generated files.
- Add an ADR (`docs/adr/NNNN-title.md`) for any decision that affects more than one service.
- For UI changes, manually load the page in a browser before saying "done". Type checking and tests verify code, not UX.
- Run `make ci-local` before committing -- it runs the same matrix as CI.

### DO NOT
- Do not add a new dependency without checking it against `cargo-audit` / `npm audit` / `govulncheck`.
- Do not add error handling for situations that cannot happen ("just in case"). Trust internal invariants; validate at boundaries.
- Do not write defensive shims for "future flexibility". YAGNI.
- Do not hand-roll a retry loop. Use `pkg/retry` (Go), `lantern-retry` (Rust), `@lantern/retry` (TS).
- Do not call an LLM directly. Always go through the model router; otherwise you bypass caching, routing, and metering.
- Do not introduce a new database. Postgres + Redis + S3 + pgvector cover everything we currently need.
- Do not skip tests with `t.Skip()`, `it.skip(...)`, or `#[ignore]` to "fix later". Either delete the test or fix it.
- Do not commit `.env`, secrets, or any file matching `.gitignore` patterns even if forced.

---

## Proto workflow

Protos live in `packages/proto/lantern/v1/`. Four files: `agents.proto`, `runs.proto`, `models.proto`, `engine.proto`.

```bash
make proto    # generates Go (gen/go/) and TypeScript (gen/ts/) from protos
```

Never hand-edit files under `gen/`. If a proto change breaks a service, fix the service -- do not revert the proto to match stale generated code.

---

## How to add a new feature (the standard flow)

1. **Find the relevant architecture doc** in `docs/architecture/`. If your feature changes the architecture, write or update it there first.
2. **Write or update the proto** in `packages/proto/` if the feature crosses a service boundary. Run `make proto`.
3. **Implement** the service-side change. Follow existing patterns in that service.
4. **Wire the SDK** -- add the typed surface in `packages/sdk-ts/` and let codegen propagate.
5. **Wire the CLI** if it's user-facing.
6. **Wire the dashboard** if it's user-facing.
7. **Tests at every layer**: unit (the new code), integration (the service), e2e (the SDK calling the deployed service).
8. **Update docs**: user guide if it's user-facing, architecture doc if it's load-bearing.

---

## Key make targets

| Target | Purpose |
|---|---|
| `make dev` | Full docker-compose stack |
| `make dev-infra` | Postgres + Redis + MinIO only |
| `make run-api` | Control-plane with dev env vars on `:8080` |
| `make dashboard-dev` | Next.js dashboard on `:3000` |
| `make landing-dev` | Landing page dev server |
| `make build` | Compile Go + Rust + TypeScript |
| `make proto` | Regenerate from proto definitions |
| `make test` | All test suites |
| `make lint` | All linters |
| `make audit` | Security audit (all languages) |
| `make ci-local` | Lint + test + audit (same as CI) |
| `make clean` | Remove artifacts + docker volumes |
| `make seed` | Seed sample data into running services |
| `make docker-build` | Build all container images |

---

## Subagents available in `.claude/agents/`

Use the right subagent for the right job:

- `architecture-reviewer` -- checks design changes against the ADRs and invariants above
- `proto-author` -- writes well-formed `.proto` files with consistent naming
- `test-writer` -- writes Go / Rust / TS tests in the project's style
- `docs-writer` -- keeps the docs site in sync with code changes
- `security-auditor` -- runs SAST/DAST/audit tooling and triages findings

See `.claude/agents/README.md` for invocation patterns.

---

## When in doubt

- **Architecture question** -> read `docs/architecture/`, then ask the user.
- **Decision question** -> read `docs/adr/`, then ask the user.
- **API question** -> look at the proto in `packages/proto/lantern/v1/` or the REST routes in `services/control-plane/cmd/server/main.go`.
- **"Where does X live"** -> grep first, ask second.
- **"Should I do X"** -> if X is risky/destructive, ask. Otherwise just do it well.
