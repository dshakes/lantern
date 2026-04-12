# CLAUDE.md -- Working in the Lantern repo

This file is loaded automatically by Claude Code (and any AGENTS.md-aware AI assistant) when working in this repository. It is the **single source of truth for repo conventions, architectural invariants, and what NOT to do**.

If you are an AI assistant: read this top-to-bottom before your first edit. Then re-read the relevant section before each task.

---

## Project in one sentence

Lantern is a **serverless platform for production AI agents** -- durable workflow execution + microVM isolation + multi-LLM routing + streaming-first SDK/CLI/dashboard, on Kubernetes.

For the full vision read `README.md`. For the architecture read `docs/architecture/01-overview.md`.

---

## Current status

This project is in **spike phase**. Core services are functional and tested at integration seams but are not production-hardened. See `docs/architecture/00-roadmap.md` for the full status matrix (what is done, spiked, and stubbed).

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
# Full stack (Postgres, Redis, MinIO, all services, dashboard)
make dev

# Infrastructure only (Postgres, Redis, MinIO) -- run services individually
make dev-infra

# Run the control-plane locally against dev infra
make run-api
```

`make run-api` sets the correct env vars (`DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `LOG_LEVEL`) for connecting to the Dockerized Postgres/Redis/MinIO. Do not run `go run ./cmd/server` bare -- it defaults to your OS user for Postgres auth and will fail.

### Dev credentials

| Service | Value |
|---|---|
| PostgreSQL | `postgres://lantern:lantern@localhost:5432/lantern` |
| Redis | `redis://localhost:6379` |
| MinIO | `lantern:lanternsecret` at `localhost:9000` (console `:9001`) |
| Dashboard login | `admin@lantern.dev` / `lantern` |
| JWT secret | `lantern-dev-jwt-secret-do-not-use-in-production` |

### Frontend dev

```bash
make dashboard-dev    # Next.js dashboard
make landing-dev      # Landing page
```

### Service ports

| Service | gRPC | HTTP |
|---|---|---|
| control-plane | `:50051` | `:8080` (REST + health) |
| workflow-engine | `:50052` | -- |
| model-router | `:50053` | -- |
| runtime-manager | `:50054` | -- |
| gateway | -- | `:8443` (TLS) |
| surface-gateway | -- | `:8000` (webhooks) |

---

## Data stores and schema

**Postgres** is the primary database (pgvector/pgvector:pg16). **Redis** is for caching, rate limiting, sessions, and pub/sub. **S3/MinIO** is for agent bundles, snapshots, and large attachments.

Do not introduce a new database without an ADR. These three cover all current needs.

### Core tables

Migrations live in `services/control-plane/internal/db/migrate.go` (idempotent `CREATE TABLE IF NOT EXISTS`). In production, use a proper migration tool (golang-migrate or Atlas).

| Table | Purpose | Key columns |
|---|---|---|
| `tenants` | Multi-tenant root | `id`, `slug`, `tier`, `k8s_namespace` |
| `users` | Auth, linked to tenant | `tenant_id`, `email`, `auth_provider`, `password_hash`, `role` |
| `agents` | Agent definitions | `tenant_id`, `name`, `current_version_id` |
| `agent_versions` | Immutable versioned bundles | `agent_id`, `version`, `digest`, `bundle_uri`, `manifest` (JSONB) |
| `runs` | Run lifecycle | `tenant_id`, `agent_id`, `status`, `input`/`output` (JSONB), `cost_usd`, `tokens_in`/`out` |
| `journal_events` | Event-sourced run log | `run_id`, `seq`, `kind`, `step_id`, `payload` (PK: `run_id, seq`) |
| `run_locks` | Distributed run locking | `run_id`, `worker_id`, `expires_at` |
| `connector_installs` | OAuth integration state | `tenant_id`, `connector_id`, `oauth_token_encrypted` |
| `surface_configs` | Channel configuration | `tenant_id`, `surface_id`, `webhook_url` |
| `api_keys` | API key management | `tenant_id`, `key_hash`, `key_prefix`, `scopes` |
| `deployments` | Deployment tracking | `tenant_id`, `agent_name`, `version`, `environment`, `status` |
| `data_planes` | Registered data planes | `tenant_id`, `cloud`, `region`, `status`, `last_heartbeat` |

Row-Level Security is enabled on `agents` and `runs` with tenant isolation policies.

A dev tenant (`slug: dev`) and admin user (`admin@lantern.dev` / `lantern`) are seeded on startup.

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
| `make run-api` | Control-plane with dev env vars |
| `make build` | Compile Go + Rust + TypeScript |
| `make proto` | Regenerate from proto definitions |
| `make test` | All test suites |
| `make lint` | All linters |
| `make audit` | Security audit (all languages) |
| `make ci-local` | Lint + test + audit (same as CI) |
| `make clean` | Remove artifacts + docker volumes |

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
- **API question** -> look at the proto in `packages/proto/lantern/v1/`.
- **"Where does X live"** -> grep first, ask second.
- **"Should I do X"** -> if X is risky/destructive, ask. Otherwise just do it well.
