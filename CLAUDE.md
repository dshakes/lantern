# CLAUDE.md -- Working in the Lantern repo

This file is loaded automatically by Claude Code (and any AGENTS.md-aware AI assistant) when working in this repository. It is the **single source of truth for repo conventions, architectural invariants, and what NOT to do**.

If you are an AI assistant: read this top-to-bottom before your first edit. Then re-read the relevant section before each task.

---

## Project in one sentence

Lantern is a **production runtime for AI agents** -- multi-LLM routing (4 strategies), managed sessions, 17 real connector APIs, MCP marketplace, A2A agent cards, agent marketplace, evaluations dashboard, visual workflow editor, cron scheduling, managed cloud hosting, Python SDK at management-surface parity with the Go SDK, and guardrails, with a control-plane/data-plane split for customer-cloud or managed-cloud deployments.

For the full vision read `README.md`. For the architecture read `docs/architecture/01-overview.md`.

---

## Languages and where to use what

This is a **polyglot monorepo on purpose**. Pick the right tool for the layer; do not unify for unification's sake.

| Layer                                                                | Language                    | Why                                                           |
| -------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| Control plane, workflow engine, scheduler, memory, notifier, billing | **Go 1.23**                 | K8s-native, single binary, mature gRPC + Postgres ecosystem   |
| Gateway, model router, runtime manager, surface gateway              | **Rust 2024**               | Hot path; Firecracker is Rust; predictable latency and memory |
| Dashboard, landing, docs site                                        | **TypeScript / Next.js 15** | RSC + streaming, our SDK's primary language already           |
| Primary SDK                                                          | **TypeScript**              | Where the agent ecosystem lives                               |
| Secondary SDKs                                                       | **Python 3.11+**, **Go**    | Python for AI/ML users, Go for infra users                    |
| CLI (`lantern`)                                                      | **Go / Cobra**              | Static binary, cross-compile easy, reuses our gRPC client     |
| API contracts                                                        | **protobuf3**               | Single source of truth for cross-service types                |

**Do not introduce a new language without an ADR.** See `docs/adr/0001-language-stack.md`.

### Python SDK parity status (`packages/sdk-python`)

**Management surface** (`LanternClient` in `lantern/client.py`): at parity with `packages/sdk-go/client.go`.
Covered namespaces: `agents`, `runs` (incl. `forecast`), `sessions`, `connectors`, `budgets`, `evals`, `experiments`, `marketplace`, `mcp`, `receipts`, `feedback`, `rehearsals`.

**Runtime context** (`AgentContext` in `lantern/types.py`): partial — interface stubs exist (`llm`, `tools`, `mem`, `connectors`, `mcp`, `a2a`, `context`) but all raise `NotImplementedError`. Full runtime wiring is a separate effort.

**Known endpoint fixes (2026-06)**:
- `connectors.execute` — was `POST /v1/connectors/{id}/actions/{action}` (404). Fixed to `POST /v1/connectors/{id}/execute?action={action}` per Go handler.
- `sessions.close` — was `POST /v1/sessions/{id}/close` (404). Fixed to `DELETE /v1/sessions/{id}`. `close()` kept as a backward-compat alias; `delete()` is canonical. `stop()` added for `POST /v1/sessions/{id}/stop`.

---

## Architectural invariants

These are **load-bearing**. Violating them silently will cause incidents. If you think one needs to change, write an ADR first.

1. **Control plane never touches user code.** Only the runtime manager interacts with Firecracker / Kata / pods. Control plane talks to runtime manager over gRPC.
2. **Workflow engine is the only thing that mutates run state.** Services emit events; the engine is authoritative. No service writes to the `runs` table directly.
3. **All long operations are durable.** Anything that can take >100ms or call an LLM goes through the workflow engine as a `step`. Steps are idempotent and replayable.
4. **Streaming is end-to-end.** Token streams flow runtime -> gateway -> SDK -> dashboard with no buffering points other than backpressure-aware channels. No service may collect a full response and then forward.
5. **Untrusted code runs in a microVM.** User-supplied code, Python `exec`, browser automation, anything that loads packages from the internet -- Firecracker or Kata only. Never a bare pod.
6. **Models are addressed by capability, not name.** SDK code says `model: "auto"` or `model: "reasoning-large"`. The model router maps to a concrete vendor model. Never hardcode `gpt-5` in service code.
7. **Multi-tenant by default.** Every row has `tenant_id`; every gRPC call carries a `tenant_id` in metadata; every K8s namespace is `lantern-t-<tenant_id>`. No cross-tenant joins, ever. The control-plane gRPC port (`:50051`) is a **trust boundary**: only callers presenting the shared service token (`x-lantern-service-token`, validated against `LANTERN_GRPC_SERVICE_TOKEN`) may set a `tenant_id`. Without that interceptor any caller reachable to `:50051` could spoof any tenant. See the wiring env vars below; mTLS is the stronger follow-up, the shared token is the pragmatic GA step.
8. **Idempotency is required for every external side-effect.** Webhook deliveries, model API calls, K8s create -- all carry an idempotency key derived from `(run_id, step_id, attempt)`. LLM provider calls (OpenAI + Anthropic, in `internal/handlers/llm_proxy.go`) now send an `Idempotency-Key` header on every request builder: the inline executor stamps a run-scoped base (`WithLLMIdempotencyBase`, from `idempotencyKey(run_id, "llm:main", attempt)`) onto the ctx, so a rate-limit backoff retry to the same provider — or a crash-replay — dedups at the provider instead of double-billing; failover targets get a per-provider-suffixed key. Ad-hoc `/v1/completions` (no run) falls back to a deterministic hash of `(provider, model, messages)`. Key derivation lives in `internal/handlers/llm_idempotency.go`; it is a one-way hash of identifiers (never carries secret material).
9. **Observability is not optional.** Every service emits OTel traces with `tenant_id`, `run_id`, `step_id`, `agent_version`. A service that can't be traced is broken. In the control-plane, **both entry points emit enriched spans**: HTTP requests are wrapped by `otelhttp.NewHandler` (span name = low-cardinality route template, e.g. `GET /v1/runs/{id}/events`), and gRPC methods get spans from the tracing interceptors. Both funnel through `internal/middleware.EnrichSpan` to stamp `lantern.tenant_id` / `lantern.user_id` / `lantern.run_id` / `lantern.step_id` — use that helper (and those exact keys) for any new span enrichment so HTTP/gRPC/step spans stay filterable by the same attributes. All of it is no-op-safe when telemetry is disabled (no OTLP endpoint / `LANTERN_OTEL_ENABLED` unset).
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

| Service         | Value                                                               |
| --------------- | ------------------------------------------------------------------- |
| PostgreSQL      | `postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable` |
| Redis           | `redis://localhost:6379`                                            |
| MinIO           | `lantern:lanternsecret` at `localhost:9000` (console `:9001`)       |
| Dashboard login | `admin@lantern.dev` / `lantern` (email+password)                    |
| JWT secret      | `lantern-dev-jwt-secret-do-not-use-in-production`                   |
| Dev tenant ID   | `00000000-0000-0000-0000-000000000001` (slug: `dev`)                |
| Dev user ID     | `00000000-0000-0000-0000-000000000002` (role: `owner`)              |

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

| Service              | Port                             | Protocol                                     |
| -------------------- | -------------------------------- | -------------------------------------------- |
| control-plane        | `:8080`                          | HTTP (REST + health + SSE)                   |
| control-plane (gRPC) | `:50051`                         | gRPC                                         |
| dashboard            | `:3001`                          | HTTP (Next.js dev, turbopack)                |
| workflow-engine      | `:50052`                         | gRPC                                         |
| model-router         | `:50053`                         | gRPC                                         |
| runtime-manager      | `:50054`                         | gRPC                                         |
| runtime-scheduler    | `:50055` (gRPC) / `:8085` (REST) | Placement engine for headless agent microVMs |
| gateway              | `:8443`                          | HTTPS (TLS)                                  |
| surface-gateway      | `:8444`                          | HTTP (webhooks; `LISTEN_ADDR` override)      |
| PostgreSQL           | `:5432`                          | postgres                                     |
| Redis                | `:6379`                          | redis                                        |
| MinIO                | `:9000` / `:9001`                | S3 / console                                 |

### Frontend dev

```bash
make dashboard-dev    # Next.js dashboard at localhost:3001
make landing-dev      # Landing page
```

### Dashboard sidebar (4 primary + Workspace section)

The dashboard sidebar (`apps/web/components/sidebar.tsx`) groups nav into a
short primary set (the daily-driver) and a collapsible Workspace section
(everything else). Bookmarks + deep links to old top-level routes keep
working — they live under Workspace now.

**Primary (always visible):**

1. **Inbox** (`/inbox`) — cross-agent activity feed. Recent runs, runs
   needing review, live runs in flight. New in W6.
2. **Agents** (`/agents`)
3. **Analytics** (`/evaluations`)
4. **Settings** (`/settings`)

**Workspace (collapsed by default, auto-opens on hit):**
Runs · Channels (`/surfaces`) · Integrations (`/connectors`) · Deployments ·
Budgets · Experiments · Eval Suites · Marketplace

**Additional dashboard surfaces:**

- `/embed` — webchat install center (W10)
- `/proof` — public receipt verifier (W8) — _no auth required_

Keyboard shortcuts: `1` = Inbox, `2` = Agents, `3` = Analytics, `4` = Settings.

### Dashboard UX primitives

When editing dashboard pages, **reuse these primitives** instead of hand-rolling page chrome. Consistency is the reason the dashboard feels Vercel-quality — do not inline yet another `<div className="border-b px-8 py-5">` header or yet another modal backdrop.

| Component                    | Purpose                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/page-header.tsx` | `<PageHeader title description badge action secondaryAction />` — every page uses this. Exports `CountBadge`, `DemoBadge` helpers.              |
| `components/modal.tsx`       | `<Modal open onClose title description size footer>` with Escape handler and body scroll-lock. Exports `ModalField` for labelled form rows.     |
| `components/button.tsx`      | `<Button variant size icon loading>` (primary/secondary/ghost/danger × sm/md/lg) and `<LinkButton>` for Next.js routing. Both are `forwardRef`. |
| `components/empty-state.tsx` | `<EmptyState icon title description actionLabel onAction actionHref />` for zero-states.                                                        |
| `components/skeleton.tsx`    | `<Skeleton>` and `<HeaderSkeleton>` for loading states — use during the initial fetch of every page.                                            |
| `components/toast.tsx`       | `useToast()` → `.success/.error/.warning/.info`. Mount `<ToastProvider>` once at layout level.                                                  |

Rule: if you're writing Tailwind classes like `rounded-xl border border-zinc-800 bg-surface-1 px-5 py-4` for header/modal/button chrome, stop and use the primitive.

Dashboard pages live in `apps/web/app/(dashboard)/`. Key pages include:

- `/agents` -- agent list + create + detail with sessions, runs, workflow editor, cost-forecast badge on the Run tab
- `/runs` -- run list + detail with event stream
- `/surfaces` -- surface configuration (WhatsApp, Slack, Telegram, webchat)
- `/connectors` -- connector installation and management
- `/deployments` -- deployment tracking and data-plane management
- `/budgets` -- policy-as-code per-agent limits (cost/day, cost/run, tokens/day, runs/day, per-tool rate limits). Hard-fail blocks runs with HTTP 402
- `/experiments` -- A/B traffic splits backed by `agent_experiments` with deterministic FNV-1a hash bucketing; auto-promotion on &gt;2% lift
- `/eval-suites` -- declarative suites, run history, pin-as-baseline. Regressions in CI return HTTP 422
- `/marketplace` -- publish / fork / star public agents, backed by `/v1/marketplace` (no sample data fallbacks)
- `/evaluations` -- analytics: performance metrics, cost attribution, model usage
- `/settings` -- LLM providers, API keys, team management

---

## Data stores and schema

**Postgres** is the primary database (pgvector/pgvector:pg16). **Redis** is for caching, rate limiting, session pub/sub (SSE events), and queues. **S3/MinIO** is for agent bundles, snapshots, and large attachments.

Do not introduce a new database without an ADR. These three cover all current needs.

### Core tables

Migrations live in `services/control-plane/internal/db/migrate.go` (idempotent `CREATE TABLE IF NOT EXISTS`). In production, use a proper migration tool (golang-migrate or Atlas).

| Table                   | Purpose                                                                                                                                                                                          | Key columns                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `tenants`               | Multi-tenant root                                                                                                                                                                                | `id`, `slug`, `tier`, `k8s_namespace`, `settings` (JSONB)                                                                    |
| `users`                 | Auth, linked to tenant                                                                                                                                                                           | `tenant_id`, `email`, `auth_provider`, `password_hash`, `role`                                                               |
| `agents`                | Agent definitions                                                                                                                                                                                | `tenant_id`, `name`, `current_version_id`, `labels` (JSONB)                                                                  |
| `agent_versions`        | Immutable versioned bundles                                                                                                                                                                      | `agent_id`, `version`, `digest`, `bundle_uri`, `manifest` (JSONB)                                                            |
| `runs`                  | Run lifecycle                                                                                                                                                                                    | `tenant_id`, `agent_id`, `status`, `input`/`output` (JSONB), `cost_usd`, `tokens_in`/`out`                                   |
| `journal_events`        | Event-sourced run log                                                                                                                                                                            | `run_id`, `seq`, `kind`, `step_id`, `payload` (PK: `run_id, seq`)                                                            |
| `run_locks`             | Distributed run locking                                                                                                                                                                          | `run_id`, `worker_id`, `expires_at`                                                                                          |
| `sessions`              | Interactive multi-turn agent sessions                                                                                                                                                            | `tenant_id`, `agent_name`, `status`, `messages` (JSONB)                                                                      |
| `schedules`             | Cron-based agent execution                                                                                                                                                                       | `tenant_id`, `agent_name`, `cron_expr`, `enabled`, `next_fire_at`, `config` (JSONB)                                          |
| `connector_installs`    | OAuth / API-key integration state. `config` + `oauth_token_encrypted` are AES-256-GCM-encrypted at rest via `internal/secrets` (set `LANTERN_CREDENTIAL_KEY`; plaintext pass-through when unset) | `tenant_id`, `connector_id`, `oauth_token_encrypted`, `config` (JSONB)                                                       |
| `surface_configs`       | Channel configuration                                                                                                                                                                            | `tenant_id`, `surface_id`, `webhook_url`                                                                                     |
| `api_keys`              | API key management                                                                                                                                                                               | `tenant_id`, `key_hash`, `key_prefix`, `scopes`                                                                              |
| `deployments`           | Deployment tracking                                                                                                                                                                              | `tenant_id`, `agent_name`, `version`, `environment`, `status`                                                                |
| `data_planes`           | Registered data planes                                                                                                                                                                           | `tenant_id`, `cloud`, `region`, `status`, `last_heartbeat`                                                                   |
| `llm_provider_configs`  | LLM API keys per tenant. `api_key_encrypted` is AES-256-GCM-encrypted at rest via `internal/secrets` (`LANTERN_CREDENTIAL_KEY`; plaintext pass-through when unset)                               | `tenant_id`, `provider`, `api_key_encrypted`                                                                                 |
| `agent_budgets`         | Policy-as-code spend + rate limits                                                                                                                                                               | `tenant_id`, `agent_name`, `max_cost_usd_per_day`, `max_cost_usd_per_run`, `tool_limits` (JSONB), `hard_fail`                |
| `agent_usage_daily`     | Daily rollup for budget enforcement                                                                                                                                                              | `tenant_id`, `agent_name`, `usage_date`, `cost_usd`, `runs_count`, `tool_counts` (JSONB)                                     |
| `cost_forecasts`        | Pre-run cost forecast audit trail                                                                                                                                                                | `tenant_id`, `agent_name`, `estimated_tokens_in/out`, `estimated_cost_usd`, `confidence`                                     |
| `marketplace_agents`    | Public marketplace entries                                                                                                                                                                       | `slug`, `source_tenant_id`, `source_agent_id`, `category`, `tags`, `manifest`, `card`, `stars_count`, `forks_count`          |
| `marketplace_stars`     | Star relation                                                                                                                                                                                    | `tenant_id`, `marketplace_id` (PK pair)                                                                                      |
| `mcp_servers`           | Curated MCP server registry                                                                                                                                                                      | `slug`, `name`, `category`, `endpoint`, `tools` (JSONB), `installs_count`                                                    |
| `agent_mcp_attachments` | Agent-MCP attachments                                                                                                                                                                            | `tenant_id`, `agent_name`, `mcp_slug`, `config` (JSONB)                                                                      |
| `eval_suites`           | Declarative eval test cases                                                                                                                                                                      | `tenant_id`, `agent_name`, `name`, `cases` (JSONB)                                                                           |
| `eval_runs`             | One execution of a suite                                                                                                                                                                         | `tenant_id`, `suite_id`, `agent_version`, `commit_sha`, `branch`, `passed`, `score`, `cases_result` (JSONB)                  |
| `eval_baselines`        | Branch pinned baseline                                                                                                                                                                           | `tenant_id`, `agent_name`, `branch`, `eval_run_id`                                                                           |
| `agent_experiments`     | A/B traffic splits with auto-promotion                                                                                                                                                           | `tenant_id`, `agent_name`, `variant_a_version`, `variant_b_version`, `traffic_split_b`, `auto_promote`, `a_score`, `b_score` |
| `run_receipts`          | Ed25519-signed verifiable execution receipts (HMAC-SHA256 legacy/dev fallback)                                                                                                                  | `run_id` (PK), `tenant_id`, `signature`, `payload` (JSONB), `issued_at`                                                      |
| `run_feedback`          | Per-run RLHF reactions                                                                                                                                                                           | `run_id`, `tenant_id`, `score` (1-5), `comment`, `preferred_output`, `source`                                                |

Row-Level Security now covers **all tenant-scoped tables** (migration `0003_rls_all_tenant_tables`), not just `agents`/`runs`. Each gets `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy with BOTH `USING` and `WITH CHECK` = `tenant_id::text = current_setting('app.tenant_id', true)`. The policies are inert until `LANTERN_RLS_ENFORCE=1` (the privileged `lantern` superuser pool bypasses RLS; `lantern_app` is subject to it). Use `Server.WithTenant(ctx, fn)` for tenant-scoped queries — it sets the `app.tenant_id` GUC so RLS admits the read/write. The exempt set (no single `tenant_id` or intentionally cross-tenant): `tenants`, `agent_versions`, `journal_events`, `run_locks`, `marketplace_agents`, `mcp_servers`, `marketplace_invocations`. `TestRLSEnforcement_AllTenantTables` is a permanent catalog gate-test: adding a new tenant table without RLS (or without an explicit exemption) fails it. See ADR 0011.

**Handler cutover to `WithTenant` is staged by group.** The reusable enforcement-on test harness is `internal/handlers/rls_integration_test.go` — `newEnforcedServer(t)` builds a `Server` whose `TenantPool()` connects as the non-superuser `lantern_app` role over its own DSN, so RLS is *genuinely* enforced (not GUC-simulated like `internal/db/rls_test.go`). Every cutover batch reuses this harness to prove (a) same-tenant reads/writes still return rows and (b) cross-tenant is blocked. **Cut over:** sessions (P1.1) · connectors (P1.1b batch 1) · and the **P1.1b remainder, now complete**: identity/people/memory (`identity.go`, `memory_ingest.go`) · voice/runtime (`voice.go`, `runtime.go`, `runtime_report.go`, `runtime_secrets.go`) · evals/experiments/budgets (`evals.go`, `experiments.go`, `budgets.go`, `forecaster.go`) · surfaces/schedules/deployments/api_keys (`surfaces.go`, `schedules.go`, `deployments.go`, `api_keys.go`, `dataplane.go`) · whatsapp/feedback/receipts/takeover (`whatsapp_personal.go`, `feedback.go`, `receipts.go`, `takeover.go`, `rehearse.go`, `marketplace*.go`). Proven by the `RLS`-prefixed tests in `internal/handlers/*_rls_test.go`. **0 non-exempt tenant-scoped `srv.Pool.<method>` sites remain in those files** — each remaining `srv.Pool` call there carries a `// rls-exempt: <reason>` (auth/trust-boundary resolution, public marketplace/receipt-verify reads, RLS-exempt child tables like `journal_events`, background sweeps with no request tenant). Shared helpers that take a raw `*Pool` and self-scope by `tenant_id` (`CheckBudget`/`RecordUsage`/`AdjustUsageCost`, `compareToBaseline`, `PickVariant`/`promoteAgentVersion`, `executeConnectorAction`) stay on `Pool` by design. **The final batch (the last 12 files) is now CUTOVER COMPLETE:** `auth.go`, `gdpr.go`, `recovery.go`, `a2a.go`, `rest.go` (run executor + workflow interpreter), `runs.go`, `run_events.go`, `templates.go`, `mcp_registry.go`, `slack_command.go`, `jarvis.go`, `llm_proxy.go`. **The count of non-exempt tenant-scoped `srv.Pool.<method>` sites across the ENTIRE `internal/handlers` package is now 0** — every remaining `srv.Pool` site carries a `// rls-exempt: <reason>` (pre-auth tenant resolution in `auth.go`/`slack_command.go`; admin/system purge in `gdpr.go`; background recovery sweep; public `is_public`-gated A2A discovery/invoke; the detached inline run executor in `rest.go` whose `runs` writes are keyed by an already-authorized run id and whose safety-net writes use a tenant-less `context.Background()`; `resolveProviderKey`/`providerAvailable` in `llm_proxy.go` self-scoped by an explicit `tenant_id` arg deep in the LLM failover loop; global catalog `mcp_servers`; and RLS-exempt child tables `journal_events`/`run_locks`). Proven by `RLSRuns_*` (runs CRUD) + `RLSMCPAttachments_*` plus the full suite green and `go test -race ./internal/handlers/ -run RLS` clean. **`LANTERN_RLS_ENFORCE=1` is now safe to flip per-env** (set `LANTERN_APP_DB_PASSWORD` and run `ALTER ROLE lantern_app PASSWORD '<strong>'` first). Run a batch's tests with `DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable` (the harness sets the `lantern_app` password itself via `ALTER ROLE`).

A dev tenant (`slug: dev`) and admin user (`admin@lantern.dev` / `lantern`) are seeded on startup.

---

## REST API endpoints

The control-plane exposes REST on `:8080`. All authenticated endpoints require a `Bearer` JWT token.

### Auth

| Method | Path                     | Description          |
| ------ | ------------------------ | -------------------- |
| `POST` | `/auth/register`         | Register new user    |
| `POST` | `/auth/login`            | Email+password login |
| `GET`  | `/auth/me`               | Current user info    |
| `GET`  | `/auth/oauth/google/...` | Google OAuth flow    |

### Agents

| Method   | Path                       | Description                             |
| -------- | -------------------------- | --------------------------------------- |
| `POST`   | `/v1/agents`               | Create agent                            |
| `GET`    | `/v1/agents`               | List agents                             |
| `GET`    | `/v1/agents/{name}`        | Get agent by name                       |
| `DELETE` | `/v1/agents/{name}`        | Delete agent                            |
| `POST`   | `/v1/agents/generate-spec` | AI-generate agent spec from description |
| `POST`   | `/v1/agents/generate-code` | AI-generate agent code                  |

### Runs

| Method | Path                   | Description              |
| ------ | ---------------------- | ------------------------ |
| `POST` | `/v1/runs`             | Create and execute a run |
| `GET`  | `/v1/runs`             | List runs                |
| `GET`  | `/v1/runs/{id}`        | Get run details          |
| `GET`  | `/v1/runs/{id}/events` | Stream run events (SSE)  |

### Sessions (interactive)

| Method   | Path                         | Description                          |
| -------- | ---------------------------- | ------------------------------------ |
| `POST`   | `/v1/sessions`               | Create a new session                 |
| `GET`    | `/v1/sessions`               | List sessions                        |
| `GET`    | `/v1/sessions/{id}`          | Get session details                  |
| `POST`   | `/v1/sessions/{id}/messages` | Send message (triggers LLM response) |
| `GET`    | `/v1/sessions/{id}/events`   | Stream session events (SSE)          |
| `POST`   | `/v1/sessions/{id}/stop`     | Stop a running session               |
| `DELETE` | `/v1/sessions/{id}`          | Delete session                       |

### Connectors

| Method   | Path                                              | Description                          |
| -------- | ------------------------------------------------- | ------------------------------------ |
| `POST`   | `/v1/connectors/install`                          | Install a connector                  |
| `GET`    | `/v1/connectors`                                  | List installed connectors            |
| `GET`    | `/v1/connectors/{connectorId}/execute?action=...` | Execute connector action             |
| `POST`   | `/v1/connectors/{connectorId}/execute`            | Execute connector action (with body) |
| `POST`   | `/v1/connectors/{id}/test`                        | Test connector connection            |
| `DELETE` | `/v1/connectors/{id}`                             | Uninstall connector                  |

### Schedules

| Method   | Path                 | Description            |
| -------- | -------------------- | ---------------------- |
| `POST`   | `/v1/schedules`      | Create/upsert schedule |
| `GET`    | `/v1/schedules`      | List schedules         |
| `PUT`    | `/v1/schedules/{id}` | Update schedule        |
| `DELETE` | `/v1/schedules/{id}` | Delete schedule        |

### Completions (LLM proxy)

| Method | Path              | Description                                     |
| ------ | ----------------- | ----------------------------------------------- |
| `POST` | `/v1/completions` | LLM completion (routes to configured providers) |

#### Model-router cutover (default OFF — ADR 0014)

The control-plane can route PLAIN provider completions through the
model-router service instead of calling OpenAI/Anthropic directly, gated by
`LANTERN_USE_MODEL_ROUTER` (default OFF) and wired at the
`callLLMWithFailover` seam in `internal/handlers/llm_proxy.go`.

- **Default OFF.** Unset / `0` → existing direct path, exactly as before. This
  is the LIVE path the WhatsApp/iMessage bridges use, so the change is opt-in.
- **Automatic fallback.** When ON, ANY router error (dial / timeout / non-OK /
  empty body) falls THROUGH to the direct provider chain — the router error is
  never surfaced to the caller. `RecordUsage`/`CheckBudget` run on the returned
  tuple regardless of path.
- **Scope.** Only plain completions are offloaded. claude-code and the tool-use
  loop stay on the direct path for now.
- **Per-tenant key.** The control-plane resolves the tenant's AES-GCM key per
  call and ships it in `CompleteRequest.provider_credentials` (proto field 42).
  This is a SECRET — never logged/traced (invariant #10). New trust boundary:
  for cross-trust-zone deployments this gRPC hop must run over mTLS.

Env vars (control-plane):

| Var                        | Default              | Purpose                                            |
| -------------------------- | -------------------- | -------------------------------------------------- |
| `LANTERN_USE_MODEL_ROUTER` | _(off)_              | `1`/`true`/`on` enables the cutover. Default OFF.  |
| `LANTERN_MODEL_ROUTER_ADDR`| `model-router:50053` | gRPC address the control-plane dials.              |

**Rollout (staged):** enable on a NON-bridge tenant first → watch traces
(`gen_ai.*` + router spans) and error rate → only then enable on the bridge
tenant. The fallback guarantee keeps the bridges safe at every step.

### Settings

| Method | Path                                         | Description               |
| ------ | -------------------------------------------- | ------------------------- |
| `POST` | `/v1/settings/llm-providers`                 | Save LLM provider API key |
| `GET`  | `/v1/settings/llm-providers`                 | List configured providers |
| `POST` | `/v1/settings/llm-providers/{provider}/test` | Test provider connection  |

### Deployments

| Method   | Path                       | Description                    |
| -------- | -------------------------- | ------------------------------ |
| `POST`   | `/v1/deployments`          | Create deployment              |
| `GET`    | `/v1/deployments`          | List deployments               |
| `GET`    | `/v1/deployments/{id}`     | Get deployment                 |
| `POST`   | `/v1/agents/{name}/deploy` | One-click managed cloud deploy |
| `POST`   | `/v1/data-planes`          | Register data plane            |
| `GET`    | `/v1/data-planes`          | List data planes               |
| `DELETE` | `/v1/data-planes/{id}`     | Remove data plane              |

### A2A (Agent-to-Agent)

**Visibility (tenant isolation).** Agents are private by default
(`agents.is_public` defaults to `false`). The card, the well-known directory,
and A2A invoke only expose an agent to a **non-owner** when it is
`is_public = true`. An authenticated caller always sees/cards/invokes its
**own** agents (scoped to its auth-context `tenant_id`) regardless of
visibility — never a tenant supplied in the body or path. A card or invoke for
an agent that is neither public nor owned by the caller returns **404** (not
403, to avoid leaking another tenant's private agent's existence); the
directory lists only `is_public` agents.

| Method | Path                      | Description                                                       |
| ------ | ------------------------- | ----------------------------------------------------------------- |
| `GET`  | `/v1/agents/{name}/card`  | Get agent's A2A card (own agent, or `is_public`; else 404)        |
| `GET`  | `/.well-known/agent.json` | Well-known A2A discovery endpoint — lists only `is_public` agents |

### Cost forecast + budgets (wedge #1)

| Method   | Path                       | Description                                                                                       |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/runs/forecast`        | Forecast tokens/cost/confidence for a prospective run. Returns `wouldExceedBudget` + block reason |
| `PUT`    | `/v1/agents/{name}/budget` | Upsert per-agent budget (cost/day, cost/run, tokens/day, runs/day, per-tool limits, hard-fail)    |
| `GET`    | `/v1/agents/{name}/budget` | Get agent budget                                                                                  |
| `DELETE` | `/v1/agents/{name}/budget` | Remove budget                                                                                     |
| `GET`    | `/v1/budgets`              | List all tenant budgets                                                                           |

### Eval suites + CI gating (wedge #2)

| Method   | Path                                    | Description                                                                    |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `POST`   | `/v1/eval-suites`                       | Upsert suite (by `tenant_id, agent_name, name`)                                |
| `GET`    | `/v1/eval-suites`                       | List suites (optional `?agentName=`)                                           |
| `GET`    | `/v1/eval-suites/{id}`                  | Get suite                                                                      |
| `DELETE` | `/v1/eval-suites/{id}`                  | Delete suite                                                                   |
| `POST`   | `/v1/eval-runs`                         | Record a run's case results. Returns HTTP 422 if regressed vs. branch baseline |
| `GET`    | `/v1/eval-runs`                         | List runs (`?suiteId=`, `?agentName=`, `?branch=`)                             |
| `POST`   | `/v1/eval-baselines`                    | Pin a run as the baseline for `(agent, branch)`                                |
| `GET`    | `/v1/eval-baselines?agentName=&branch=` | Get baseline                                                                   |

### A/B experiments

| Method | Path                            | Description                                                                     |
| ------ | ------------------------------- | ------------------------------------------------------------------------------- |
| `POST` | `/v1/experiments`               | Create experiment with deterministic FNV-1a traffic split                       |
| `GET`  | `/v1/experiments`               | List                                                                            |
| `GET`  | `/v1/experiments/{id}`          | Get                                                                             |
| `POST` | `/v1/experiments/{id}/record`   | Record a variant outcome (score 0..1). Auto-promotes on >2% lift + min-runs/arm |
| `POST` | `/v1/experiments/{id}/conclude` | Manually conclude + optionally promote winner                                   |

### Marketplace

| Method   | Path                          | Description                                     |
| -------- | ----------------------------- | ----------------------------------------------- |
| `GET`    | `/v1/marketplace`             | List public agents (`?category=`, `?q=`)        |
| `POST`   | `/v1/marketplace/publish`     | Publish a tenant-local agent to the marketplace |
| `GET`    | `/v1/marketplace/{slug}`      | Get marketplace entry                           |
| `DELETE` | `/v1/marketplace/{slug}`      | Unpublish                                       |
| `POST`   | `/v1/marketplace/{slug}/fork` | Fork into caller's tenant                       |
| `POST`   | `/v1/marketplace/{slug}/star` | Star                                            |
| `DELETE` | `/v1/marketplace/{slug}/star` | Unstar                                          |

### MCP server registry

| Method   | Path                                   | Description                                    |
| -------- | -------------------------------------- | ---------------------------------------------- |
| `GET`    | `/v1/mcp/servers`                      | List curated MCP servers (`?category=`, `?q=`) |
| `GET`    | `/v1/mcp/servers/{slug}`               | Get one                                        |
| `POST`   | `/v1/agents/{name}/mcp-servers`        | Attach an MCP server to an agent               |
| `GET`    | `/v1/agents/{name}/mcp-servers`        | List attachments                               |
| `DELETE` | `/v1/agents/{name}/mcp-servers/{slug}` | Detach                                         |

### Verifiable receipts

Tamper-evident Ed25519-signed proof of execution (HMAC-SHA256 legacy/dev fallback when `LANTERN_RECEIPT_ED25519_SEED` is unset). Every receipt includes the SHA-256 of the run's `journal_events` stream so any post-hoc tampering invalidates the signature. Self-hosted deployments expose the signing algorithm and key fingerprint via `/.well-known/lantern-receipts` for external verifiers.

| Method | Path                            | Description                                          |
| ------ | ------------------------------- | ---------------------------------------------------- |
| `POST` | `/v1/runs/{id}/receipt`         | Issue + persist a signed receipt for a completed run |
| `POST` | `/v1/runs/receipts/verify`      | Verify a receipt signature (no auth required)        |
| `GET`  | `/.well-known/lantern-receipts` | Signing algorithm + key fingerprint                  |

### Run feedback (RLHF loop)

Per-run human reactions feed the eval suite as positive examples and the
rehearsal queue as failures to replay. Score is 1..5; 4-5 is "thumbs up", 1-2
is "thumbs down".

| Method | Path                         | Description                                                |
| ------ | ---------------------------- | ---------------------------------------------------------- |
| `POST` | `/v1/runs/{id}/feedback`     | Submit score (1-5), optional comment + preferred output    |
| `GET`  | `/v1/runs/{id}/feedback`     | List per-run feedback history                              |
| `GET`  | `/v1/agents/{name}/feedback` | Aggregate summary (avg score, thumbs up/down, 7-day trend) |

### Rehearsals

Replay past production failures (status=failed OR feedback score <= 2) as
synthetic test cases against a candidate agent version BEFORE traffic flips.
Reuses the eval-in-CI baseline machinery to gate merges.

| Method | Path                | Description                                                                            |
| ------ | ------------------- | -------------------------------------------------------------------------------------- |
| `POST` | `/v1/runs/rehearse` | Pull synthetic test cases from past failed/low-score runs (`window`, `limit`, filters) |

### Webchat embed (W10)

Static JS widget served at `/widget.js` from the same origin. Embed with
one `<script>` tag; talks to the same `/v1/sessions` endpoints the
dashboard uses, so no parallel widget API to maintain.

### Workflow runtime (W11b)

When `agents.workflow` JSONB contains a graph saved by the visual editor,
the inline run executor dispatches to the workflow interpreter at
`services/control-plane/internal/workflow/interpreter.go`. Supported node
types: `trigger`, `ai-step`, `tool`, `connector`, `condition`, `approval`,
`end`. Loop / subagent are no-op pass-throughs (future wave). Every node
emits `step_started` + `step_completed`/`step_failed` to `journal_events`
so the run-detail waterfall renders the graph automatically.

**Crash-resume from the journal (invariant #3).** The inline executor runs in
a goroutine, so a process restart between `step_started` and `step_completed`
must not lose the run or restart it from scratch (double-executing
side-effecting steps). It doesn't. Two mechanisms cooperate, both reading the
existing `journal_events` event log — no new store:

- **Reclaim.** The recovery sweep (`internal/handlers/recovery.go`,
  `RunRecoveryLoop`, default every 30s, `LANTERN_RECOVERY_INTERVAL`) finds
  runs in `running`/`queued` whose `run_locks` row is absent or expired,
  wins a fresh lock via `acquireRecoveryLock` (UPSERT that only steals an
  expired lock — the distributed guard), and re-drives them through
  `redriveRun` → `runWorkflowIfPresent` / `executeRunInlineSync`.
- **Resume, not restart.** On re-drive the workflow interpreter walks the
  graph from the trigger again, but for every side-effecting node type
  (`ai-step`, `tool`, `connector`, `subagent`, `approval`) it first calls
  `Deps.CompletedStep` — wired in `rest.go` to `RESTHandler.journalCompletedStep`,
  which returns the cached output when a `step_completed` row already exists
  for `(run_id, step_id)`. Completed nodes are skipped (dep never re-invoked);
  the walk resumes at the first incomplete node. The plain-LLM path has the
  analogous `checkCachedLLMStep` cache (`durable_replay.go`). External
  deliveries additionally dedup via `claimSideEffect`'s
  `(run:step:attempt)` idempotency key (invariant #8), so no double
  side-effect even if a re-drive re-reaches a delivery. Tests:
  `internal/handlers/workflow_resume_test.go` (DB-backed, multi-step graph
  skip) + the `crash_replay_*`/`recovery_*` suites.

The gRPC `RunService.StreamRunEvents` (`internal/handlers/runs.go`) replays
those `journal_events` — it is no longer a heartbeat-only stub. On stream
open it sends every row for the run in `(run_id, seq)` order mapped to the
proto `StreamEvent` oneof (`step_started`/`step_completed`/`step_failed` →
their dedicated messages; every other kind → a structured `Log` so nothing
is dropped), then tails for `seq > last` until the run is terminal or the
client cancels, with a `Heartbeat` keepalive between events. It mirrors the
REST SSE path `GetRunEvents` (`internal/handlers/run_events.go`) exactly:
same query, ordering, tenant-ownership gate, poll interval, and
`isRunTerminal` stop condition.

#### Durable workflow engine step dispatch (`services/workflow-engine`)

The dormant durable engine's leaf executors
(`internal/engine/step_executor.go`) now do real dispatch instead of
returning placeholder strings:

- **`llm_call` steps** dispatch through the **model router**
  (`ModelService.Complete`), never to a provider directly (invariant #6).
  The step builds a capability-addressed `CompleteRequest` (capability +
  optimize selectors, messages/prompt, max_tokens, temperature) carrying
  `tenant_id` and the idempotency key `run_id:step_id:attempt` (invariant
  #8), and maps `model_used`/`tokens_in`/`tokens_out`/`cost_usd` from the
  response into the step result. Dial address is
  `LANTERN_MODEL_ROUTER_ADDR` (default `model-router:50053`). When unset,
  llm_call steps fail with the typed `ErrModelRouterUnavailable` rather than
  a fabricated completion.
- **`tool_call` steps** dispatch to the **runtime-manager** via
  `RuntimeManager.ExecTool` (microVM tool execution, invariant #5; see ADR
  0015). The step builds an `ExecToolRequest` carrying `tool_name`, structured
  `args` (`google.protobuf.Struct`), `run_id`/`step_id`/optional `vm_id`, the
  step's remaining timeout, and the idempotency key `run_id:step_id:attempt`
  (invariant #8). The response's typed `ToolStatus` is mapped: `OK` → step
  output `{tool_name, result}`; `ERROR` → step failure with the manager's
  detail; `UNAVAILABLE` → step failure wrapping `ErrRuntimeManagerUnavailable`.
  Dial address is `LANTERN_RUNTIME_MANAGER_ADDR` (default
  `runtime-manager:50054`); when unset, the client stays nil and tool_call
  steps fail with the typed `ErrRuntimeManagerUnavailable` rather than faking
  output. The runtime-manager side is honest-but-incomplete: there is no
  in-guest tool-runner yet (the harness serves a raw `Exec` shell channel, not
  a typed tool registry), so `exec_tool` validates the request and returns
  `TOOL_STATUS_UNAVAILABLE` — never a fabricated success — until the in-VM
  runner lands.

### Human takeover (W11a)

Workflow `approval` nodes block on a `takeover_requests` row. Operators
flip the row from `pending` → `granted` (optionally posting SDP for live
WebRTC takeover) → `released` to resume the workflow. Real microVM video
streaming is the last mile; the contract + persistence + workflow wait
are fully wired today.

| Method | Path                                  | Description                           |
| ------ | ------------------------------------- | ------------------------------------- |
| `POST` | `/v1/runs/{id}/takeover/request`      | Create a pending takeover row         |
| `GET`  | `/v1/runs/{id}/takeover`              | List takeover requests for a run      |
| `POST` | `/v1/runs/{id}/takeover/{id}/grant`   | Operator approves; optional SDP offer |
| `POST` | `/v1/runs/{id}/takeover/{id}/answer`  | Browser-side SDP answer               |
| `POST` | `/v1/runs/{id}/takeover/{id}/release` | Workflow resumes                      |

### Marketplace commerce (W11c)

Cross-tenant agent invocations with HMAC-signed settlement. Buyer tenant
invokes a published marketplace agent; the run executes on the seller's
tenant (their LLM keys, their budgets); the buyer receives the output
plus a signed receipt verifiable via the same `/proof` endpoint as run
receipts.

| Method | Path                                             | Description                                                        |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------ |
| `POST` | `/v1/marketplace/{slug}/invoke`                  | Buyer invokes a seller agent. Returns output + HMAC-signed receipt |
| `GET`  | `/v1/marketplace/invocations?role=buyer\|seller` | List buyer- or seller-side history                                 |

### Voice channel (W11d)

Phone numbers (purchased or BYO via SIP) route inbound calls to a
Lantern agent. Provider-pluggable via the `VoiceProvider` interface in
`services/control-plane/internal/handlers/voice.go`. Built-in providers:
**Twilio** (TwiML webhooks) and **LiveKit** (realtime). The control-plane
mints LiveKit access tokens and verifies both providers' webhook
signatures; the realtime audio loop runs in a separately-deployed LiveKit
Agents worker (the media last-mile). `voice_numbers.provider_config` is
encrypted at rest (see `internal/secrets`).

Voice spend counts against the same `agent_budgets` as runs: a Twilio
inbound call over a hard-fail budget is declined with `<Reject>` (no
carrier cost); a LiveKit join token is refused with HTTP 402 (no token →
no media). A flat estimate accrues into `agent_usage_daily` on connect via
`RecordUsage`, then the provider's status callback
(`/v1/voice/calls/status/{provider}`) reconciles it to the actual
duration-based cost via `AdjustUsageCost` when the call ends (a short or
declined call refunds the reservation).

| Method   | Path                                | Description                                                                                                                                                                   |
| -------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/voice/numbers`                 | Link a phone number to an agent (provider + config)                                                                                                                           |
| `GET`    | `/v1/voice/numbers`                 | List linked numbers                                                                                                                                                           |
| `DELETE` | `/v1/voice/numbers/{id}`            | Unlink                                                                                                                                                                        |
| `GET`    | `/v1/voice/calls`                   | Recent calls with duration + cost                                                                                                                                             |
| `POST`   | `/v1/voice/token`                   | Mint a short-lived LiveKit join token for a room (agent worker / browser client)                                                                                              |
| `POST`   | `/v1/voice/webhook/{provider}`      | Provider POSTs here on inbound call (TwiML for Twilio; verified JWT for LiveKit)                                                                                              |
| `POST`   | `/v1/voice/calls/status/{provider}` | Provider status callback on call end — reconciles actual duration + cost into `voice_calls` and the agent's budget rollup (point Twilio's "call status changes" webhook here) |

### Bridge heartbeat (WhatsApp surface)

Bridge POSTs its current pairing state to the control-plane every 30s so
the dashboard can render status without depending on direct bridge
reachability (matters in multi-host prod). Optional — when the bridge
env vars are unset, dashboard falls back to direct bridge probe.

| Method | Path                              | Description                                                  |
| ------ | --------------------------------- | ------------------------------------------------------------ |
| `POST` | `/v1/surfaces/whatsapp/heartbeat` | Shared-token auth. Upserts pairing state per tenant          |
| `GET`  | `/v1/surfaces/whatsapp/status`    | JWT auth. Returns last-known pairing state with `stale` flag |

### Personal device signals (iPhone Shortcuts → tunnel)

The owner's iPhone Shortcuts POST app-context signals (e.g. "Calendar
opened") to the control-plane on `:8080` THROUGH the existing cloudflared
tunnel (which fronts the API, not the dashboard on `:3001`). The bridge reads
`~/.lantern/device-signals.jsonl` (one compact JSON object per line:
`{app, kind, detail, ts}`) and summarizes it into owner context. A parallel
dashboard route at `apps/web/app/api/signals/route.ts` writes the same
contract on `:3001`; this endpoint is the tunnel-reachable twin.

Single-owner PERSONAL endpoint — **NOT** JWT/tenant-scoped. Gated by the
`LANTERN_SIGNAL_TOKEN` shared secret via a constant-time compare; **fails
closed** (401) when the env var is unset or the `x-lantern-signal-token`
header is missing/mismatched. The token is never logged. The JSONL file is
mode 0600 and bounded (trimmed to the last 4000 lines past 5000).

| Method | Path           | Description                                                                                                                                |
| ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/v1/signals`  | Shared-token auth. Body `{app (required, ≤100), kind (default "app_open"), detail (≤500), ts (ms, default now)}`. Appends one JSONL line     |
| `GET`  | `/v1/signals`  | Shared-token auth. `?limit=N` (default 50, cap 500). Returns the last N parsed signals as a JSON array (debugging / future view)            |

| Env var                 | Purpose                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `LANTERN_SIGNAL_TOKEN`  | Shared secret for `/v1/signals` (sent as `x-lantern-signal-token`). Unset → endpoint is 401 fail-closed |

### Life-event engine (bridge "Automations" feed)

The bridges classify inbound into typed life-events
(`bill`/`delivery`/`appointment`/`fraud_alert`/`otp`/`travel`/`receipt`/`promo`)
and either suggest one-tap actions or auto-act. These endpoints persist the
events + their outcomes so the dashboard "Automations" view can render a feed
and per-category trust toggles. Backed by `life_events` + `life_event_prefs`
(both tenant-scoped, RLS-enforced). All JWT-authed, tenant-scoped via
`WithTenant`. Re-emits dedup on `(tenant_id, idempotency_key)`.

| Method | Path                              | Description                                                                                                                  |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/life-events`                 | Record a classified event `{kind, channel, status?, urgency?, summary, fields?, idempotencyKey?, actionTaken?, sourcePreview?}`. UPSERTs on idempotency key (re-emit updates status/action). Returns `{id}` |
| `GET`  | `/v1/life-events`                 | Newest-first feed (`?status=`, `?kind=`, `?limit=` default 50 cap 200)                                                       |
| `POST` | `/v1/life-events/{id}/undo`       | Mark `status='undone'` (records intent; bridge reverts the calendar/note). 404 cross-tenant                                 |
| `POST` | `/v1/life-events/{id}/dismiss`    | Mark `status='dismissed'`. 404 cross-tenant                                                                                  |
| `GET`  | `/v1/life-events/prefs`           | Per-kind trust modes (`auto`/`ask`/`off`); synthesizes default `ask` for kinds with no row                                  |
| `PUT`  | `/v1/life-events/prefs`           | Upsert a per-kind toggle `{kind, mode}` on `(tenant_id, kind)`                                                              |

### MicroVM headless runtime (W12)

Productionized headless agent execution: control-plane schedules a spec,
`runtime-scheduler` picks a node (warm-pool / region / fair-share / cost /
health), `runtime-manager` spawns the workload in the right isolation
(Firecracker / Kata / K8s Job / Wasmtime / devcontainer), and the
in-VM `harness` (Rust, baked into the image) enforces egress allowlist,
vends short-TTL JWT secrets, and streams heartbeats + logs back. Full
contract is in `packages/proto/lantern/v1/runtime.proto`; arch overview is
`docs/architecture/04b-microvm-productionization.md`; rationale per
component is in ADRs 0002–0008. Quota is per tenant; cap exceeded returns
HTTP 402.

**Harness security model (`services/harness/src`, P2-B7).** The in-VM harness
is PID 1 and the last in-VM trust boundary around secrets + egress. Three
controls, all fail-safe:

- **Secrets socket peer auth.** `/run/lantern/secrets.sock` authenticates every
  connecting peer with `SO_PEERCRED` (kernel-attested uid/pid, unspoofable). It
  only vends to the workload uid the manager injects as `LANTERN_WORKLOAD_UID`
  (plus the harness's own uid). Unset → dev path: a loud one-time WARN, allow.
  **In production the manager MUST inject `LANTERN_WORKLOAD_UID`** so the socket
  is fail-closed against any other in-VM process. Unauthorized attempts emit a
  `secret_access_denied` audit event.
- **Egress enforcement is two-layer, and the harness fails closed without the
  enforcing layer.** The CONNECT allowlist proxy (`127.0.0.1:3128`) is only
  advisory unless traffic is forced through it. The harness (a) injects
  `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` into the workload env when
  egress rules are declared, and (b) runs a boot preflight that checks for the
  **iptables REDIRECT-to-3128 rule**. **True enforcement requires the VM
  host/image to install that REDIRECT rule** (see the header comment in
  `services/harness/src/egress.rs`); env injection alone is bypassable by a
  client that ignores proxy vars. When rules are declared but REDIRECT is
  absent: `LANTERN_EGRESS_FAIL_CLOSED=1` → harness refuses to start the
  workload; otherwise a prominent SECURITY WARN + `egress_preflight` audit.
- **Security audits are never silently dropped.** The harness wires the real
  `RuntimeHarness.Report` client-streaming RPC with reconnect. Security-critical
  audits (`secret_vend`, egress `deny`, `secret_access_denied`,
  `egress_preflight`) are logged locally at WARN *before* any forward attempt
  and preserved across a transient manager outage (never dropped on a full
  buffer); routine observability frames stay best-effort.

Harness env vars: `LANTERN_WORKLOAD_UID` (workload uid for peer auth),
`LANTERN_EGRESS_RULES` (JSON `[{pattern,http_methods,rate_bps}]`, declared
egress at spawn), `LANTERN_EGRESS_FAIL_CLOSED=1` (refuse to boot without
iptables REDIRECT when egress declared), `LANTERN_NO_PROXY` (override the
injected `NO_PROXY`; defaults keep loopback + `169.254.169.254` direct).

| Method   | Path                             | Description                                                                                             |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/runtime/schedule`           | Submit an AgentSpec (image, isolation, limits, egress, secrets). Returns `vm_id`. 402 if quota exceeded |
| `GET`    | `/v1/runtime/vms`                | List VMs (`?state=running&limit=50`)                                                                    |
| `GET`    | `/v1/runtime/vms/{id}`           | VM detail + recent audit events                                                                         |
| `DELETE` | `/v1/runtime/vms/{id}?grace=30s` | Drain + terminate                                                                                       |
| `GET`    | `/v1/runtime/vms/{id}/logs`      | SSE log stream from the harness                                                                         |
| `POST`   | `/v1/runtime/vms/{id}/exec`      | One-shot exec into a running VM (operator debugging)                                                    |
| `GET`    | `/v1/runtime/cluster`            | Owner-only. Node load + warm-pool capacity                                                              |
| `GET`    | `/v1/runtime/audit`              | Recent runtime audit events for the tenant                                                              |
| `GET`    | `/v1/runtime/quota`              | Current quota + today's usage                                                                           |
| `PUT`    | `/v1/runtime/quota`              | Owner-only. Update max concurrent VMs / cost-per-day                                                    |

CLI surface (`lantern run`, `lantern vm …`) and dashboard pages
(`/runtime`, `/runtime/{vm}`) consume these endpoints. End-to-end demo
agents in `examples/headless-agents/{01-hello,02-web-scraper,03-stateful-research,04-ml-inference}/`.

**Wiring env vars (set on control-plane + scheduler):**

- `LANTERN_SCHEDULER_GRPC_ADDR=localhost:50055` — control-plane dials
  the scheduler. Unset → falls back to `stubSchedulerClient` (synthesizes
  vm-ids, returns `node-stub`/`az-stub`; useful for dashboard-only work).
  **REQUIRED in production** (`LANTERN_ENV=prod/production/staging`): the
  control-plane refuses to start when this is unset in prod because the stub
  fabricates fake VM IDs and spawns nothing — silent data loss, not graceful
  degradation. Guard: `handlers.CheckSchedulerAddr` called from `runStartupGuards`.
- `LANTERN_DEFAULT_MANAGER_ADDR=localhost:50054` — scheduler dials this
  node when the placement chooses `node-local` / `node-stub` / empty.
  Also used by the control-plane's Logs SSE proxy to reach the manager
  directly. Unset → scheduler keeps the `LogOnlyDialer` stub.
  **REQUIRED in production** (`LANTERN_ENV=prod/production/staging`): the
  scheduler refuses to start when this is unset (or when `LANTERN_DIALER=stub`)
  in prod because the stub logs a fake success and spawns nothing. Guard:
  `dialer.CheckManagerDialer` called from `cmd/scheduler/main.go`.
- `LANTERN_RUNTIME_MANAGER_ADDR=runtime-manager:50054` — the
  **workflow-engine** dials this to dispatch `tool_call` steps via
  `RuntimeManager.ExecTool` (ADR 0015). Unset → the engine's runtime client
  stays nil and tool_call steps fail with the typed
  `ErrRuntimeManagerUnavailable` rather than fabricating tool output.
- `LANTERN_NODE_ADDR_<NODE>=host:port` — explicit per-node override
  when the scheduler picks a named node and its IP isn't discoverable
  via DNS.
- `LANTERN_DIALER=stub` — force the stub dialer even when
  `LANTERN_DEFAULT_MANAGER_ADDR` is set (debug aid). **Fatal in prod** — see
  `LANTERN_DEFAULT_MANAGER_ADDR` above.
- `LANTERN_RUNTIME_SECRET_TOKEN` — pre-shared token the runtime-manager sends
  as `X-Lantern-Runtime-Token` to `POST /v1/runtime/secrets/resolve`. Set on
  both the control-plane (to accept) and the manager (to send). When unset on
  the control-plane the endpoint returns 403 (fail-closed). See ADR 0008.
- `LANTERN_CONTROL_PLANE_URL` — base URL the runtime-manager uses to call the
  relay endpoint (e.g. `http://control-plane:8080`). Must be set together with
  `LANTERN_RUNTIME_SECRET_TOKEN` to activate `RelaySecretResolver`; otherwise
  dev `EnvSecretResolver` is used.
- `LANTERN_GRPC_SERVICE_TOKEN` — shared service token authenticating callers to
  the control-plane gRPC port (`:50051`). Set on **both** the control-plane (to
  accept) and the gateway (to send as `x-lantern-service-token`). A
  `UnaryServiceAuthInterceptor`/`StreamServiceAuthInterceptor` runs **before**
  the tenant-extraction interceptor and constant-time-compares the token, so only
  authenticated callers may set `tenant_id`. **Fail-closed:** when
  `LANTERN_ENV` is prod/production/staging and this is unset the control-plane
  **refuses to start**. When unset in dev it warns and allows unauthenticated
  calls (so `make dev` works). Health-check + `DataPlaneService` methods are
  exempt (the latter has its own bootstrap-token + JWT auth). mTLS is the stronger
  follow-up; the shared token is the GA step.

Real protoc Go codegen at `gen/go/lantern/v1/` is hand-maintained stubs.
These are **tracked in git** (NOT gitignored) — they are a build-critical Go
module that services depend on via `replace ../../gen/go` and that the Docker
builds `COPY`, so a clean clone must have them. Only the regenerable
`gen/ts/` output is gitignored. `make proto` can regenerate them, but the
hand edits below are the source of truth. Wire is
protobuf-tag-compatible regardless of local Go type names — Go's
hand-stub renames (e.g. `RuntimeLogLine` to avoid colliding with the
`LogLine` from `runs.proto`) don't affect interop with the Rust
tonic-generated server.

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
- The `sdlc-lint` PR workflow (`.github/workflows/sdlc-lint.yml`) gates on golangci-lint, `cargo clippy -D warnings`, and eslint/tsc for all TS packages. This is a required check alongside `sdlc-qa`.

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

## Personal-docs + agentic Mac actions (macOS bridges)

The iMessage + WhatsApp bridges include a personal-docs assistant that answers
questions about local files on the user's Mac (passport, license, receipts,
etc.) AND can take native actions on macOS — Calendar / Notes / Mail — when
the owner confirms a suggested follow-up. Lives in
`packages/bridge-core/src/{personal-docs,mac-actions,humanize}.ts` and wires
into both bridges' session handlers.

### Security model

- **Owner-only.** Both bridges enforce `isOwnerChatRow` / `isOwnerChat`
  before any doc query, agentic action, or command fires. Two topologies
  supported: (a) self-chat (single Apple ID / WhatsApp number — owner
  messages themselves), or (b) dedicated bot account (owner DMs a separate
  bot Apple ID / WA number). DMs from non-owner contacts never reach the
  doc/action pipeline.
- **Path-restricted.** Personal-docs search/read only inside
  `LANTERN_PERSONAL_DOCS_ROOTS` (defaults: `~/Documents`, `~/Desktop`,
  iCloud Drive). All reads go through `isAllowedPath` which blocks
  traversal.
- **OCR cache 0600.** `~/.lantern/ocr-cache/<sha1>.txt` files are written
  with mode 0600 (owner-only) because OCR'd text often contains passport
  numbers, license #s, and other PII.
- **Killswitch.** Owner can engage a master switch via `kill switch on`
  in self-chat — bridge ignores ALL inbound until released.

### Agentic action layer

- `mac-actions.ts` wraps AppleScript for `Calendar.app`, `Notes.app`, and
  `Mail.app`. Dates are constructed component-by-component (locale-safe;
  `date "YYYY-MM-DD"` literals are NOT locale-safe and produce garbage
  outside en_US — verified, fixed).
- `humanize.ts` post-processes LLM replies: rewrites numeric dates to
  friendly form (`Sept 14, 2031`), guarantees an agentic follow-up
  offer when the answer contains an expiry/deadline/ID/file, and
  returns a structured `PendingOffer` the bridge caches.
- **Deterministic offer execution.** When the owner replies "yes" /
  "sure" / "do it" within OFFER_TTL_MS (10 min) of a follow-up, the
  bridge fires the AppleScript itself — no LLM round trip. Solves a
  real LLM-hallucination bug where the model would claim the reminder
  was set without ever emitting a `[CALENDAR:...]` marker.

### Owner profile (`~/.lantern/owner-profile.md`)

The bridge reads this markdown file (hot-reloaded every 30s or on mtime
change) and injects sections as ground truth into every reply prompt. File
location overridable via `LANTERN_OWNER_PROFILE`.

**`## Facts` section** — structured biographical ground truth. Parsed into
typed fields; the bot must NEVER deny or contradict these when a contact
references them. Supported keys:

```markdown
## Facts
- married: yes
- spouse: Maya
- kids: Aarav, Anaya
- wedding anniversary: 2017-06-03
```

Date values must be `YYYY-MM-DD`. The bot renders them as "June 3, 2017" in
the prompt. `factsBlock()` produces a single injected line like
`"Owner facts (TRUE — never deny or contradict these): married to Maya; …"`.

**`## Relationships` section** — per-contact relationship labels plus optional
addressing rules. Extended grammar (pipe-delimited):

```markdown
## Relationships
- Shiva: brother
- Sujith: college friend | address as: Sujith | never: bava, anna
- +15125551234: manager
```

The `address as: X` clause sets what to call this contact. `never: a, b`
forbids those kinship/nickname terms — using one is an instant bot-tell.
Parenthetical aliases also work: `Maya(Mae): wife` indexes both names.

**`## Style lessons (managed)` section** — auto-written by the 👎 learning
flywheel (see below). Do not hand-edit the `<!-- id:... -->` comment tags;
the bot uses them to dedup on updates. Safe to delete a bullet to retire a lesson.

**Auto-teaching.** When the owner self-chats a message with teaching
signals ("Raju moved to MD", "remember: anniversary is June 3 2017",
"don't call Sujith bava"), `owner-profile-auto-update.ts` runs an LLM
extraction and appends to the relevant section — typed facts to `## Facts`,
per-contact rules to `## Relationships`, generic notes to `## Auto-learned
facts (managed)`. The bridge acks with "📝 noted — …".

### Cross-channel unified memory

iMessage and WhatsApp share a single person graph and timeline keyed by the
control-plane identity layer (`/v1/people`). Facts, episodes, and topics
learned on one channel are available on the other for the same canonical
person.

- **Person graph.** `POST /v1/people/resolve` maps any (channel, handle) to a
  canonical person row. Handles from different channels that belong to the
  same person are grouped after a `POST /v1/people/merge`.
- **14-day episodic memory.** Every substantive exchange is indexed as a
  `(date, topic, outcome)` episode in `~/.lantern/episodes.jsonl` (mode
  0600). The 5 most-recent episodes per contact are injected into the reply
  prompt. Cross-contact mentions (owner self-chats "Sujith landed") are
  tagged so Sujith's next inbound surfaces that episode via `forMentions`.
- **7-day topic index.** `~/.lantern/topic-index.jsonl` (mode 0600) stores
  topic-tagged messages. `SocialGraph.related()` retrieves messages from
  OTHER contacts that mentioned the same topics, injected as a
  "## Related context from OTHER threads" block. The prompt instructs the
  LLM never to volunteer cross-thread details unless asked.

### Overnight message replay (quiet hours)

Messages arriving inside quiet hours are queued to
`~/.lantern/<bridge>/quiet-queue.jsonl` (mode 0600) and replayed when the
window reopens, with natural morning pacing. The queue is drained in
chronological order; `LANTERN_QUIET_QUEUE_MAX` caps its size (default 200).
Quiet hours default: 01:00–06:00 owner-local time, overridable via
`LANTERN_QUIET_START` / `LANTERN_QUIET_END` (24h integers).

### Authentic-voice + bot-tell guards

`detectBotTells()` in `natural.ts` is the last pass before every send. It
suppresses the draft (bridge stays silent) when the LLM:

- Uses customer-service stock phrases ("Certainly!", "Of course!", em-dashes)
- Narrates its own parsing failure ("I can't see the attachment")
- Leaks its reasoning ("a real person wouldn't respond to that")
- Denies the owner's biographical facts ("I'm not even married")
- Uses textbook Telangana-Telugu long verb forms (`vacchina tarvata`,
  `-tanu`/`-edanu` endings, `ra`/`ro`/`ayya` end-particles) — the owner
  uses short forms (`vasta`, `cheptha`, `matladtham`).

The suppressed draft triggers a regeneration attempt, not silence.

### Typing / pacing realism

`pacing.ts` computes the pre-send hold from REAL observed `(inbound_ts,
reply_ts)` pairs in the chat store — median owner reply latency for THAT
contact. Adjusted by time-of-day (10:00–16:00 quicker, 21:00–01:00 slower),
jittered ±20%, clamped 600ms–25s. WhatsApp sends a `composing` presence
indicator before each burst message; the typing duration is proportional to
message length.

### 👎 learning flywheel

When the owner taps 👎 on a bot reply:
1. The `(inbound, bad_reply, good_reply)` triple is appended to
   `~/.lantern/dislikes.jsonl` (mode 0600).
2. On a schedule (or threshold hit), `runDislikeConsolidation()` mines the
   full log for patterns that recur across ≥3 rejections (exclamation marks,
   long replies, filler openers, hedging, over-formal phrasing).
3. Graduated lessons are written as `## Style lessons (managed)` bullets in
   `owner-profile.md` and injected into EVERY future reply prompt — the bot
   improves globally, not just for the one contact.
4. Optional LLM clustering pass for fuzzy patterns: enabled by
   `LANTERN_DISLIKE_LLM_CLUSTER=1` (requires a wired `llmCall`; off by default).

Per-contact dislike memory (the raw JSONL entries) is also surfaced back into
that contact's specific prompt so the LLM knows what shapes were already
rejected for them.

### Anticipation engine (proactive nudges)

`computeProactiveNudges()` (`anticipation.ts`) is a pure function that ranks
signals gathered by the bridge and fires owner-facing nudges to self-chat.
Four nudge kinds, by priority:

| Kind | Trigger | Example |
|---|---|---|
| `pre-meeting` | Calendar event starting within 15 min | "1:1 with Raju starts in 10 min — pulling up the thread" |
| `relationship-date` | Anniversary/birthday within 1 day lookahead | "heads up: your anniversary is tomorrow — want me to draft something?" |
| `overdue-reply` | Contact unanswered for >2 days | "you haven't gotten back to Madhu in 3 days — want me to take a crack at it?" |
| `commitment` | Open promise tracked >4h | "still on your plate: send Raju the deck — want me to handle it?" |

Nudges carry stable `dedupeKey`s persisted to `~/.lantern/<bridge>/fired-nudges.json`
so the same nudge never fires twice in a day. Respect quiet hours.
Disable with `LANTERN_PROACTIVE_NUDGES=0`.

### Scheduling negotiation

When `schedulingEnabled` is true and the owner's free slots are passed in,
the persona can propose, hold, and confirm concrete meeting times. On the
contact's agreement it emits a `[CALENDAR:title|start-iso|end-iso?|notes?]`
marker (stripped before send; bridge books it). Work-hours protection still
applies; the marker is never emitted for unconfirmed proposals.

### Draft-and-confirm

LOW-confidence replies (money amounts, future-date commitments, medical
topics, cold contacts, prior 👎 history) are held and DM'd to the owner's
self-chat as "draft to X: …, reply 'send' to approve" before sending.
Disable with `LANTERN_DRAFT_CONFIRM=0` (falls back to the prior 5s hold
then auto-send). VIPs always go through the dashboard draft queue regardless.

### Claim verifier

`verifyClaims()` (`verifiable-claims.ts`) is a pre-send pass that rewrites
completed-action claims ("I sent him an email") to intent form ("I'll send
him an email") unless the matching action was actually invoked. Covers send,
add to calendar, notify-third-party, forward, email, book. The
notify-third-party rewrite ("I let him know" → "I'll make sure he sees this")
runs unconditionally because the bridge has no channel to truthfully complete
it mid-thread.

### Mac app-usage signal ("learn what the owner uses")

OWNER-ONLY ambient signal that distills the owner's local macOS app-usage into
ONE short "what you've been doing today" line, fed into the OWNER's self-chat
assistant context for proactive awareness + better-grounded replies (Mac only;
iPhone usage is deferred). Lives in `packages/bridge-core/src/mac-usage.ts`
(pure parse + summarize, unit-tested with mock rows) and
`services/imessage-bridge/src/mac-usage-reader.ts` (the knowledgeC.db reader).

Privacy posture (HARD rules):

- **OFF by default.** Requires `LANTERN_MAC_USAGE=on`. When off, nothing reads
  knowledgeC.db and nothing is stored.
- **Owner-only.** The summary is injected ONLY into the owner's self-chat
  assistant prompt (`handleOwnerDocQuery`) — NEVER into a contact reply. A
  contact must never learn what apps the owner uses.
- **Summaries, not raw logs.** Only the distilled per-app rollup + one sentence
  is kept; the rolling cache is `~/.lantern/mac-usage.json` (mode 0600). No raw
  per-event log is persisted.
- **Fails closed.** The reader copies `~/Library/Application Support/Knowledge/
  knowledgeC.db` to a tempfile and opens it read-only; any failure (no Full
  Disk Access, missing DB, schema drift, lock) → empty signal + one debug log,
  never a throw/crash. Source rows: `ZOBJECT` where `ZSTREAMNAME` is
  `/app/usage` or `/app/inFocus`; `ZVALUESTRING` = bundle id; `ZSTARTDATE`/
  `ZENDDATE` are Mac-absolute-time seconds (Unix = mac + 978307200).

### Required env (bridge process)

| Var                                   | Purpose                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LANTERN_OWNER_NAME`                  | First name used for ranker boost ("Shekhar" → boost files whose path contains "shekhar" when the query says "my")                                                                                |
| `LANTERN_OWNER_EMAIL`                 | Mirror destination for bot status updates                                                                                                                                                        |
| `LANTERN_OWNER_TIMEZONE`              | IANA timezone (e.g. `America/Los_Angeles`). Used by quiet hours, daily digest scheduling, and calendar lookups. Defaults to process timezone when unset.                                         |
| `LANTERN_IMESSAGE_OWNER_HANDLE`       | (Optional) Owner's primary iMessage handle (phone or email). When set, bridge accepts DMs from this handle as owner-channel (dedicated-bot mode). When unset, falls back to self-chat detection. |
| `LANTERN_WA_OWNER_JID`                | (Optional) Owner's primary WhatsApp JID — `15125551234` or `15125551234@s.whatsapp.net`. Same role as the iMessage env.                                                                          |
| `LANTERN_PERSONAL_DOCS_ROOTS`         | Colon-separated allowed roots (default `~/Documents:~/Desktop:~/Library/Mobile Documents/com~apple~CloudDocs`)                                                                                   |
| `LANTERN_PERSONAL_DOCS_OCR_MAX_PAGES` | Max PDF pages to render+OCR per file (default 3)                                                                                                                                                 |
| `LANTERN_MAC_USAGE`                   | (Optional) `on` to enable the OWNER-ONLY Mac app-usage signal (reads knowledgeC.db, distills one "what you've been doing today" line into the owner's self-chat context). Default OFF. Summaries only; fails closed. |
| `LANTERN_MAC_USAGE_SEC`               | (Optional) Mac app-usage refresh interval in seconds (min 60, default 1800 = 30 min).                                                                                                            |
| `LANTERN_DEFAULT_CALENDAR`            | Calendar name to use when LLM doesn't specify (default tries `Home` / `Calendar` / `Personal` / `Work`)                                                                                         |
| `LANTERN_QUIET_START`                 | Start of quiet-hours window, 24h integer (default `1` = 1 AM). No auto-reply; messages queued for morning replay.                                                                                |
| `LANTERN_QUIET_END`                   | End of quiet-hours window, 24h integer (default `6` = 6 AM).                                                                                                                                    |
| `LANTERN_QUIET_QUEUE_MAX`             | Max messages buffered in the overnight queue per bridge (default 200).                                                                                                                           |
| `LANTERN_PROACTIVE_NUDGES`            | Set to `0` to disable anticipation nudges entirely (default on).                                                                                                                                 |
| `LANTERN_DRAFT_CONFIRM`               | Set to `0` or `off` to disable draft-and-confirm for LOW-confidence replies (reverts to 5s hold → auto-send). Default on.                                                                        |
| `LANTERN_DISLIKE_LLM_CLUSTER`         | Set to `1` to enable the optional LLM fuzzy-clustering pass in the 👎 flywheel consolidation. Default off (deterministic-only pass always runs).                                                 |
| `LANTERN_VOICE_CALLER_ID`             | (Optional) E.164 caller-ID shown to the RECIPIENT of outbound calls — set to the owner's own number so contacts recognize + answer. MUST be a Twilio number or a **Verified Caller ID** on the account. Unset → falls back to the Twilio DID. SMS heads-up + conference owner-leg always use the Twilio DID. |
| `LANTERN_VOICE_SMS_HEADSUP`           | `on` (default) / `off`. When on, a one-line heads-up SMS ("…'s assistant — …'s calling you in a few seconds about X") is texted to the recipient from the Twilio DID right before a conference dial, so an unknown caller-ID isn't ignored. Best-effort; never blocks the call. |
| `LANTERN_TWILIO_NUMBER` / `LANTERN_TWILIO_SMS_FROM` | (Optional) E.164 Twilio number used as the SMS **from** when an iMessage send fails to a non-iMessage (SMS/RCS-only) number — the bridge re-delivers the reply as SMS so the contact still hears back. Unset → no SMS fallback. |
| `LANTERN_VOICE_CLONE`                 | (Optional) **deepfake-class; OFF by default.** Set `1`/`true`/`on` to speak outbound calls in the owner's OWN cloned voice via ElevenLabs `<Play>` instead of generic Polly `<Say>`. Requires `LANTERN_ELEVENLABS_API_KEY` + `LANTERN_ELEVENLABS_VOICE_ID` + `LANTERN_VOICE_CACHE_PUBLIC_URL`. Any missing → clean Polly fallback. The 2-party-consent announcement still fires regardless. |
| `LANTERN_ELEVENLABS_API_KEY`          | (Optional) ElevenLabs API key for voice-clone TTS (legacy alias `LANTERN_ELEVENLABS_KEY` accepted). Only used when `LANTERN_VOICE_CLONE` is on. Never logged. |
| `LANTERN_ELEVENLABS_VOICE_ID`         | (Optional) ElevenLabs voice id to synthesize in (the owner's cloned voice). Only used when `LANTERN_VOICE_CLONE` is on. |

### RCS messaging (to & fro)

The iMessage bridge handles RCS in both directions:

- **Inbound (fro).** Newer macOS + RCS/SMS leave `chat.db.message.text` NULL and store the body in `attributedBody` (an `NSAttributedString` typedstream blob). `services/imessage-bridge/src/attributed-body.ts` decodes it (dependency-free, best-effort, never throws) so RCS/newer messages aren't seen as empty — wired into `chat-db.ts` polling **and** the context/history-search reads. Automatic; no config.
- **Outbound (to).** Replies prefer iMessage. When the iMessage send fails (the contact is SMS/RCS-only), the bridge re-delivers via the control-plane Twilio connector's `send_sms` action. That action sends through a **Twilio Messaging Service** when one is configured (`messagingServiceSid` on the Twilio connector config, or the `messagingServiceSid` param) — a Messaging Service with an **RCS sender** attached delivers **RCS (rich) and auto-falls back to SMS** for handsets that can't do RCS. With no Messaging Service it sends plain SMS from `LANTERN_TWILIO_NUMBER`. So the one path covers RCS + SMS.
  - To enable RCS: in Twilio, create a Messaging Service, attach your RCS sender, and set its SID as `messagingServiceSid` on the Twilio connector (dashboard → Integrations → Twilio), **and** set `LANTERN_TWILIO_NUMBER` for the plain-SMS fallback.

### Always-on

WhatsApp + API + dashboard run under user LaunchAgents
(`~/Library/LaunchAgents/dev.lantern.*.plist`). The iMessage bridge needs
Full Disk Access (chat.db) + Automation permission (Messages.app), which
is per-binary in macOS TCC — easiest path is to run it via Terminal
(which already has those grants) or grant FDA explicitly to
`/Users/shakes/.nvm/.../node` for true always-on. See
`docs/personal/BOT-SETUP.md`.

### Transient-error retry (control-plane / LLM 429 / 503)

`AgentClient` (`packages/bridge-core/src/agent.ts`) wraps every
`authedFetch` for session create and message post with bounded exponential
backoff via `packages/bridge-core/src/retry.ts`. HTTP 429 / 503 and
network errors (ECONNREFUSED, socket hang-up, etc.) are retried up to
`LANTERN_BRIDGE_RETRY_ATTEMPTS` times (default 3) with full-jitter
backoff between `0` and `LANTERN_BRIDGE_RETRY_MAX_MS` (default 4000 ms,
base step `LANTERN_BRIDGE_RETRY_BASE_MS` = 500 ms). 401 / 403 / 404 /
409 are never retried — the existing dead-session 404/409 recovery path
is preserved inside the outer loop. Note: `@lantern/retry` does not yet
exist as a shared package; `retry.ts` is a local shim to be replaced
when that canonical package ships.

### Self-heal (WhatsApp Signal protocol)

The bridge hooks Baileys' logger and counts decrypt failures
(`failed to decrypt message` / `Bad MAC` / `MessageCounterError`). When
20+ errors hit inside 60s, it forces a socket-level reconnect to
renegotiate the Signal session — no QR re-pair needed for transient
drift. Hard "Bad MAC" corruption (from process-killed-mid-write) still
needs a one-time re-pair; `POST /session/:tenant/reset` wipes creds and
`/start` issues a fresh QR.

### Endpoints added

| Method | Path                                       | Purpose                                                                                    |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `POST` | `/v1/vision/ocr`                           | OCR a base64 image via tenant's OpenAI vision key. Used by personal-docs for scanned PDFs. |
| `POST` | `/v1/people/resolve`                       | Resolve a (channel, handle) to a canonical person row; creates if absent.                  |
| `GET`  | `/v1/people`                               | List people, most-recently-updated first.                                                  |
| `POST` | `/v1/people/merge`                         | Merge duplicate person rows (transactional, idempotent).                                   |
| `GET`  | `/v1/people/duplicates`                    | List candidate duplicate pairs by name similarity.                                         |
| `POST` | `/v1/people/relationship`                  | Stamp a relationship label onto a resolved person.                                         |
| `POST` | `/v1/memory/events`                        | Ingest a timeline event for a person (resolved from channel+handle).                       |
| `GET`  | `/v1/memory/context`                       | Unified cross-channel context for a person. `?windowDays=N` slices to the last N days.    |
| `GET`  | `/session/:tenantId/has-creds` (WA bridge) | Dashboard probe — when true, show "Reconnect" instead of "Pair with QR"                    |
| `POST` | `/session/:tenantId/reset` (WA bridge)     | Wipe creds (destructive — forces fresh QR pair)                                            |

---

## Proto workflow

Protos live in `packages/proto/lantern/v1/`. Core files: `agents.proto`, `runs.proto`, `models.proto`, `engine.proto`, plus per-service contracts such as `dataplane.proto`, `runtime.proto`, `billing.proto` (`lantern.v1.BillingService` — usage metering + budgets), and `scheduler.proto` (`lantern.v1.SchedulerService` — cron + one-shot triggers).

Note: the `memory` service has **no** proto on purpose — memory is served over REST by the control-plane (`/v1/memory/*`, `/v1/people/*`); a gRPC MemoryService would duplicate that surface. See [ADR 0013](docs/adr/0013-billing-scheduler-grpc-memory-rest.md).

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

## Preferred local-dev command

```bash
lantern dev   # boots Postgres+Redis+MinIO+API+dashboard+WhatsApp bridge
```

The four-Makefile-target dance below still works for power users, but
`lantern dev` is the daily-driver.

## Make targets (still supported)

| Target                     | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `make dev`                 | Full docker-compose stack (containerized API + dashboard) |
| `make dev-infra`           | Postgres + Redis + MinIO only                             |
| `make run-api`             | Control-plane with dev env vars on `:8080` (host go run)  |
| `make dashboard-dev`       | Next.js dashboard on `:3001`                              |
| `make run-whatsapp-bridge` | WhatsApp bridge on `:3100`                                |
| `make landing-dev`         | Landing page dev server                                   |
| `make build`               | Compile Go + Rust + TypeScript                            |
| `make proto`               | Regenerate from proto definitions                         |
| `make test`                | All test suites (Go × 4 services, Rust × 3, TS × 2, Python × 1) |
| `make test-go`             | Go tests — control-plane, workflow-engine, scheduler, **runtime-scheduler** |
| `make test-ts`             | TS tests — sdk-ts (vitest) + **bridge-core** (node:test via tsx) |
| `make lint`                | All linters (golangci-lint, clippy, eslint/tsc)           |
| `make audit`               | Security audit (all languages)                            |
| `make ci-local`            | Lint + test + audit (same as CI)                          |
| `make clean`               | Remove artifacts + docker volumes                         |
| `make seed`                | Seed sample data into running services                    |
| `make docker-build`        | Build all container images                                |

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
