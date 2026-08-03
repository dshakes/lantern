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

**Framework integrations** (`lantern/integrations/`): optional extras, each importing its framework lazily so the base SDK stays dependency-free. `deepagents_sandbox.LanternSandbox` implements LangChain deepagents' `SandboxBackendProtocol` over the microVM runtime (`POST /v1/runtime/schedule` + `/vms/{id}/exec`), so a deepagents agent's shell/filesystem runs under Lantern's egress allowlist, secret vending, and tenant quota rather than on the host (invariant #5). Install with `pip install "lantern-sdk[deepagents]"`; conformance tests skip when the extra is absent. Sync `runtime_client.py` on purpose — the backend protocol is sync and bridging the async `LanternClient` mid-event-loop is fragile.

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
7. **Multi-tenant by default.** Every row has `tenant_id`; every gRPC call carries a `tenant_id` in metadata; every K8s namespace is `lantern-t-<tenant_id>`. No cross-tenant joins, ever. The control-plane (`:50051`), **workflow-engine (`:50052`), and runtime-scheduler (`:50055`)** gRPC ports are all **trust boundaries**: only callers presenting the shared service token (`x-lantern-service-token`, validated against `LANTERN_GRPC_SERVICE_TOKEN`) may set a `tenant_id`. Without that interceptor any caller reachable to those ports could spoof any tenant. Additionally, every run-mutating engine RPC (`CancelRun`/`ResumeRun`/`SignalRun`) scopes its DB access by the interceptor-verified `tenant_id` and returns `NotFound` on mismatch (no existence leak) — the token gate alone is not enough; the queries must filter too. See the wiring env vars below; mTLS is the stronger follow-up, the shared token is the pragmatic GA step.
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

**Theming (light + dark, YC-flat).** The dashboard is theme-aware. **Dark is the
default**; a `☀/☾` toggle in the top bar flips `data-theme` on `<html>` (persisted
to `localStorage['lantern-theme']`; a no-flash inline script in `app/layout.tsx`
sets it pre-paint). The flip is **central**: `app/globals.css` remaps the neutral
scale under `:root[data-theme="light"]` (Tailwind v4 emits every `--color-zinc-*` /
`--color-surface-*` as a CSS var), so ~2,900 utilities re-skin with no per-component
edits. Two rules that keep this working:
- **Use tokens for foreground/chrome, never literal `text-white` / `bg-white/[x]` /
  `border-white/[x]` on a neutral surface** — literals don't flip and go invisible in
  light. `text-white` is correct ONLY on a colored bg (buttons, badges). For neutral
  foreground use `text-zinc-50` (dark in light, near-white in dark).
- The mission-control classes `.mc-glass` / `.mc-aurora` are now **flat** (glass blur
  + ambient aurora removed globally in `globals.css`) for the clean "YC product" look
  — don't re-add `backdrop-blur` glass or aurora glows; use the flat `.mc-glass` card.

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

**Timezone.** Cron matching is timezone-aware. `POST`/`PUT` accept an optional
`timezone` (IANA, e.g. `America/New_York`; invalid → 400), stored on
`schedules.timezone`. `NextCronTime` is computed in that zone via
`scheduler.ResolveLocation(tz)` (priority: schedule tz → `LANTERN_DEFAULT_TIMEZONE`
env → **UTC**). Without a per-schedule tz AND without the env, everything stays
UTC — identical to prior behavior (so `0 9 * * *` only fires at 9am *local* once
a zone is configured; before this it fired at 09:00 UTC). The same
`ResolveLocation("")` drives the budget/usage **day boundary** (`usageDate()` in
`internal/handlers/tz.go`, used by all `agent_usage_daily.usage_date` sites) so a
`max_cost_usd_per_day` rolls at the deployment's local midnight, not UTC. Env:
`LANTERN_DEFAULT_TIMEZONE` (deployment-wide IANA; unset → UTC, a no-op).

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

### Internal (service-token auth — not JWT)

| Method | Path                           | Description                                                                                                                                                                     |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/internal/auth/introspect-key` | Validate a raw API key for the gateway. Body `{"key":"..."}`, header `x-lantern-service-token` (= `LANTERN_GRPC_SERVICE_TOKEN`). 200 `{tenantId, scopes}` or 401; 403 fail-closed in prod when the token env is unset. |

The gateway's `X-API-Key` hot path calls this endpoint (60s in-memory cache
keyed by SHA-256 of the key; fail-closed on any error). Gateway env:
`LANTERN_CONTROL_PLANE_URL` (introspection base URL) +
`LANTERN_GRPC_SERVICE_TOKEN` (same shared token as the gRPC trust boundary).
Unset → API-key auth stays fail-closed-disabled; JWT auth is unaffected.

#### Per-endpoint scope authorization (`LANTERN_AUTHZ_ENFORCE`, default OFF)

API keys carry `scopes` (stored in `api_keys`); mutating endpoints are annotated
with a required scope via `AuthHandler.WithScope(scope, handler)` in
`cmd/server/main.go`. Scope taxonomy (`internal/handlers/auth.go`): coarse
`read`/`write`/`admin` (backward-compatible with existing keys) plus fine-grained
`agents:{read,write}`, `runs:{read,write,execute}`, `connectors:write`,
`budgets:write`, `settings:write`. `admin` implies all; `write` implies `read`
(`scopeImplies`). `WithScope` authenticates via the SAME `validateRequest` the
handlers already used (caching claims in ctx so `contextWithTenant` reuses them —
no double token validation / DB hit), so it is **not** a new auth surface.

**Staged like RLS — FLAG-GATED, DEFAULT OFF.** When `LANTERN_AUTHZ_ENFORCE` is
unset/0 (default), a missing scope is LOGGED at debug and the request PROCEEDS —
zero behavior change, safe to merge/run against the live bridges + dashboard.
When `1`, a key missing the required scope gets `403`. JWT owner/admin sessions
keep full access. Annotated today: the agents/runs/sessions/connectors/
deployments/schedules/budgets/settings/templates mutating endpoints; reads are a
follow-up. Extends invariant #7 (the RLS/token trust boundary) toward the
fine-grained authZ the SOC 2 ADR (0018) flags as a gap.

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

#### Eval observability (read-only, over existing `eval_runs`)

No new tables — reads `eval_runs.cases_result` history. `internal/handlers/eval_observability.go`; pure `clusterFailures`/`computeTrend`/`clampLimit` are unit-tested.

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET`  | `/v1/eval-observability/failures?agentName=&branch=&limit=` | Failing cases grouped across recent runs, worst-first: `{clusters:[{case, failures, seen, failRate, sampleError, expected, actual, firstSeen, lastSeen}], runsScanned}` (limit = runs scanned, default 50 cap 200) |
| `GET`  | `/v1/eval-observability/trends?agentName=&branch=&limit=`   | Score/pass-rate/cost time series oldest-first for charting: `{points:[{runId, createdAt, score, passRate, passed, costUsd, agentVersion, commitSha}], latestVsMean, regressing}` (regressing = latest score below the mean of priors) |

The dashboard `/evaluations` page renders these (quality-trend sparkline + top-failing-cases). Tenant-scoped via `WithTenant`.

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
`end`. `loop` (executeLoop) and `subagent` (depth-guarded synchronous child
runs via `Deps.RunSubAgent`, wired in `rest.go`) are both implemented. Every node
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

#### Confidence-gated execution (`LANTERN_CONFIDENCE_GATE`)

Before a side-effecting node executes, the interpreter can evaluate a confidence
score and route low-confidence steps to the human-approval mechanism instead of
auto-executing. Feature is **default OFF**; enable per-deployment.

**Gated node types:**
- `tool` and `connector` — always gated when the feature is on.
- `ai-step` — only gated when `node.Data["requiresConfidence"] = true` (for
  action-driving steps whose LLM output is itself an instruction to act).

**When score >= threshold:** node executes normally.
**When score < threshold:** `WaitForApproval` is called (same path as the
`approval` node / W11a takeover). The side effect does NOT execute until a human
grants. If `WaitForApproval` is nil (no handler wired), the step auto-approves
so unattended workflows still complete.

**Journal events:** every gated step emits `confidence_evaluated` with
`{score, threshold, decision ("execute"|"divert"), node_type, estimator}`.
Diverted-then-approved steps additionally emit the normal `step_completed` after
the human grants. Diverted-then-denied steps emit `step_failed`.

**Estimators (`ConfidenceEstimator` in `internal/workflow/confidence.go`).** Two
are wired; select with `LANTERN_CONFIDENCE_ESTIMATOR`. Both satisfy the interface
`Estimate(ctx, node, vars, sample Sampler) float64` + `Name() string`; the gate
passes the tenant-scoped `Deps.CallLLM` as the `sample` (nil-safe — estimators
degrade gracefully when no LLM is wired). See ADR 0021.

- **`verbalization_heuristic`** (default) — scans prior step text for LLM
  self-reported confidence ("Confidence: 85%", "70% confident"). Falls back to
  `DefaultConfidence=0.9` when none found. A HEURISTIC, and note the failure
  mode it encodes: **silence → 0.9 → auto-execute** (a model that hallucinates an
  action also cheerfully writes "confidence: 95%" about it, and no self-report at
  all clears the 0.75 bar). Kept as the default for backward-compatibility and as
  every estimator's safe fallback.
- **`self_consistency`** (`SelfConsistencyEstimator`) — scores confidence from the
  model's INDEPENDENT agreement, not its self-report: it re-poses the pending
  action to the model `N` times (`LANTERN_CONFIDENCE_SAMPLES`, default 5, clamped
  [1,9]) as a fresh skeptical YES/NO judgment and returns the fraction voting
  "execute". Consensus → high; a split vote → low → divert. A prior verbalized
  self-doubt signal, if lower than the consensus, wins (`min`) — the model's own
  caution can only lower confidence, never raise it. Fixes the silence→0.9
  default (silence is actively probed). Falls back to the verbalization heuristic
  when `sample` is nil, the action can't be described, or every sample fails — so
  it is **always safe to enable**. Grounded self-consistency; the outcome
  calibration below turns it into statistical calibration.

**Outcome calibration (`CalibratedEstimator`, opt-in `LANTERN_CONFIDENCE_CALIBRATE`).**
Wraps whichever base estimator is selected and lowers its score by this
`(agent, node_type)`'s realized **regret rate** — the fraction of auto-executed
steps of that type later thumbs-downed (`run_feedback.score <= 2`) or ended in a
`failed` run. `adjusted = base × (1 − regret)`, clamped `[0,1]`; calibration can
only LOWER a score, never raise it. This **closes the write-only outcome loop**
for gating (ADR 0021, Phase 1): action types that have burned the owner get
gated harder over time. The regret query is tenant-scoped (`db.WithTenantConn`,
RLS-safe), 5-min cached, min-3-sample guarded, and **fail-safe** (any error / no
data → regret 0 → base unchanged). Wiring: `internal/handlers/confidence_calibration.go`;
wrapper `workflow.CalibratedEstimator` (`Name()` → `calibrated(self_consistency)`).

The `confidence_evaluated` journal event tags which estimator ran via
`Estimator.Name()`.

**Env vars (control-plane):**

| Var | Default | Purpose |
|-----|---------|---------|
| `LANTERN_CONFIDENCE_GATE` | _(off)_ | `1`/`true`/`on` enables gating. Default OFF. |
| `LANTERN_CONFIDENCE_GATE_THRESHOLD` | `0.75` | Minimum score [0,1] for auto-execution. |
| `LANTERN_CONFIDENCE_ESTIMATOR` | `verbalization` | `self-consistency` to poll for independent agreement; else the heuristic. |
| `LANTERN_CONFIDENCE_SAMPLES` | `5` | Independent judgments for self-consistency (clamped [1,9]). Each is one LLM call — N trades cost/latency for signal. |
| `LANTERN_CONFIDENCE_CALIBRATE` | _(off)_ | `1`/`true`/`on` wraps the estimator in `CalibratedEstimator` (regret-lowered score). Default OFF; fail-safe. |

Rollout: enable the gate on non-production agents first → inspect
`confidence_evaluated` events (score, decision, `estimator`) in the run waterfall
→ turn on `self-consistency` and tune `SAMPLES`/threshold → then production.

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
- **`child_run` steps** invoke another agent and wait for it, in the engine
  itself (`internal/engine/child_run.go`) — NOT via a control-plane client. The
  engine is the only thing that mutates run state (invariant #2) and is already
  the component that drives a run, so it creates the child row and drives it;
  asking the control plane to create a run the engine owns would invert that
  invariant. The step returns `{child_run_id, status, output}` and a failed
  child fails the parent step. Three things worth knowing:
  - **Depth** is computed from the `parent_run_id` chain (recursive CTE, bounded
    scan), capped at `maxChildRunDepth = 5` to match the control-plane
    interpreter's `maxSubagentDepth`. Deliberately NOT a context value: this
    engine crashes and replays, and a context value resets to 0 on the way back
    up — turning the cycle guard off exactly when a runaway workflow is retrying
    hardest. The DB chain survives restarts.
  - **Replay-safety** is by adoption, not by the step cache: `RunState`
    reconstructs `StepResults` on replay but `GetStepResult` is never consulted,
    so a replayed run re-executes its steps. A child records its
    `parent_run_id` + `parent_step_id` in `trigger_meta`, and a re-executed
    step adopts that child instead of dispatching a second agent run. (Making
    the executor consult its replay cache is worth doing on its own; this step
    is safe either way.)
  - **Cancellation** propagates: the child is driven on the parent's ctx.
  - **No split-brain.** The child is created `status='running'`, NOT `'queued'`.
    The scheduler polls `status IN ('queued','resumable')`, so a queued child
    would be claimed by a scheduler worker at the same moment the parent drives
    it inline — two goroutines on one run, duplicating LLM/tool side effects.
    Creating it already-running makes the poller unable to see it by
    construction. Creation + adoption run in one transaction that locks the
    parent row, so two executions of the same step cannot both insert.
  - **A paused child fails the step, but says so precisely.** If a child stops
    on `approval` or `wait_signal` the step fails with the typed
    `ErrChildRunPaused` instead of a generic failure — the parent does NOT wait
    for the approval. Resuming a parent around a paused child needs the parent to
    become resumable too — a design in its own right, so the limitation is named
    instead of guessed at. Nested approvals do not work yet; they fail loudly.
  `ErrChildRunUnavailable` still exists and fires when no child runner is wired
  (nil, as with a nil model/runtime client) — the step fails rather than
  fabricating a result. (Regression-guarded: it once journaled a fake
  `child_started`/`child_completed` pair and returned a placeholder output.)

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

The owner's iPhone Shortcuts POST rich device-context signals to the
control-plane on `:8080` THROUGH the existing cloudflared tunnel (which fronts
the API, not the dashboard on `:3001`). The bridge reads
`~/.lantern/device-signals.jsonl` (one compact JSON object per line —
`{app?, kind, detail?, metric?, value?, ts}`) and summarizes them into owner
context. A parallel dashboard route at `apps/web/app/api/signals/route.ts`
writes the same contract on `:3001`; this endpoint is the tunnel-reachable twin.

Single-owner PERSONAL endpoint — **NOT** JWT/tenant-scoped. Gated by the
`LANTERN_SIGNAL_TOKEN` shared secret via a constant-time compare; **fails
closed** (401) when the env var is unset or the `x-lantern-signal-token`
header is missing/mismatched. The token is never logged. The JSONL file is
mode 0600 and bounded (trimmed to the last 4000 lines past 5000).

**Supported kinds (bridge reads all):**

| kind | Required fields | Optional fields | Example |
|------|----------------|----------------|---------|
| `app_open` | `app` | `detail` | `{kind:"app_open", app:"YouTube", ts}` |
| `location` | one of app/detail/value | — | `{kind:"location", detail:"Home", ts}` |
| `focus` | one of app/detail/value | — | `{kind:"focus", detail:"Work", ts}` |
| `device` | one of app/detail/value | — | `{kind:"device", detail:"CarPlay", ts}` |
| `health` | one of app/detail/value | `metric` (steps\|sleep\|workout), `value` | `{kind:"health", metric:"steps", value:6200, ts}` |
| `now_playing` | one of app/detail/value | — | `{kind:"now_playing", detail:"Song - Artist", ts}` |
| `wake`/`sleep`/`screenshot` | one of app/detail/value | — | `{kind:"wake", detail:"morning", ts}` |

Validation: `kind` is always required (≤40 chars). For `kind=app_open`, `app` is required (≤100 chars). For all other kinds, at least one of `app`/`detail`/`value` must be present (fully-empty payload → 400). `detail` clamped to 500 chars; `metric` to 40 chars. `ts` defaults to now (ms) when absent or zero.

| Method | Path           | Description                                                                                                                                                 |
| ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/signals`  | Shared-token auth. Body `{kind (required), app?, detail?, metric?, value?, ts?}`. Appends one JSONL line with omitempty fields                              |
| `GET`  | `/v1/signals`  | Shared-token auth. `?limit=N` (default 50, cap 500). Returns the last N parsed signals including metric/value fields as a JSON array                       |

| Env var                 | Purpose                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `LANTERN_SIGNAL_TOKEN`  | Shared secret for `/v1/signals` (sent as `x-lantern-signal-token`). Unset → endpoint is 401 fail-closed |

### Immigration / USCIS deadline sentinel (Phase 3)

An agent that REASONS over the family's immigration PDFs + arriving USCIS/attorney
mail to surface DERIVED deadlines nobody typed in (EAD/AP expiry, I-485 windows,
biometrics/RFE clocks), reconciling the PDF against the latest email — LLM
reasoning over two sources, not a keyword scan. Control-plane only
(`internal/handlers/immigration_sentinel.go`); surfaced additively in the Jarvis
brief. Persisted in `immigration_deadlines` (tenant-scoped, RLS-enforced,
`ON CONFLICT (tenant_id, who, doc_type, deadline)` dedup; in the RLS catalog gate).

**Flag-gated, default OFF** (`LANTERN_IMMIGRATION_SENTINEL`): unset → scan is inert,
endpoints return `{enabled:false}`, no brief section — zero behavior change.
**Anti-hallucination:** a deadline is dropped unless the LLM grounds it in a
NON-BLANK `source_ref` AND `confidence >= 0.6` (matches the prompt's own floor);
the LLM call is capability-addressed (model router, never a hardcoded vendor,
invariant #6); doc/mail PII never logged (invariant #10). Fail-safe throughout
(doc/mail/LLM/DB error → no deadlines, never a crash or fabricated result).

| Method | Path                          | Description                                        |
| ------ | ----------------------------- | -------------------------------------------------- |
| `GET`  | `/v1/immigration/deadlines`   | List derived deadlines (tenant-scoped). `{enabled:false}` when off |
| `POST` | `/v1/immigration/scan`        | Trigger a scan (gather docs+mail → reason → upsert). Returns `{found:N}` |

| Env var                        | Purpose                                                              |
| ------------------------------ | ------------------------------------------------------------------- |
| `LANTERN_IMMIGRATION_SENTINEL` | `1`/`true`/`on` enables the sentinel. Default OFF (fully inert).    |

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
  absent: **prod (`LANTERN_ENV=prod/production/staging`) is ALWAYS
  fail-closed** — the harness refuses to start the workload, and an explicit
  `LANTERN_EGRESS_FAIL_CLOSED=0` is ignored with a WARN (prod never
  fail-open). In dev, `LANTERN_EGRESS_FAIL_CLOSED=1` opts in to the same
  refusal; otherwise a prominent SECURITY WARN + `egress_preflight` audit.
  Decision logic: `resolve_fail_closed` in `egress.rs`.
- **Security audits are never silently dropped.** The harness wires the real
  `RuntimeHarness.Report` client-streaming RPC with reconnect. Security-critical
  audits (`secret_vend`, egress `deny`, `secret_access_denied`,
  `egress_preflight`) are logged locally at WARN *before* any forward attempt
  and preserved across a transient manager outage (never dropped on a full
  buffer); routine observability frames stay best-effort.

Harness env vars: `LANTERN_WORKLOAD_UID` (workload uid for peer auth),
`LANTERN_EGRESS_RULES` (JSON `[{pattern,http_methods,rate_bps}]`, declared
egress at spawn), `LANTERN_EGRESS_FAIL_CLOSED=1` (refuse to boot without
iptables REDIRECT when egress declared — implied and non-overridable in
prod), `LANTERN_NO_PROXY` (override the injected `NO_PROXY`; defaults keep
loopback + `169.254.169.254` direct).

| Method   | Path                             | Description                                                                                             |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/runtime/schedule`           | Submit an AgentSpec (image, isolation, limits, egress, secrets). Returns `vm_id`. 402 if quota exceeded |
| `GET`    | `/v1/runtime/vms`                | List VMs (`?state=running&limit=50`)                                                                    |
| `GET`    | `/v1/runtime/vms/{id}`           | VM detail + recent audit events                                                                         |
| `DELETE` | `/v1/runtime/vms/{id}?grace=30s` | Drain + terminate                                                                                       |
| `GET`    | `/v1/runtime/vms/{id}/logs`      | SSE log stream from the harness                                                                         |
| `POST`   | `/v1/runtime/vms/{id}/exec`      | One-shot exec into a running VM (operator debugging). **execve-style**: `command` is the executable, `argv` its args — no implicit shell (shell lines go as `/bin/sh` + `["-c", …]`, matching `lantern vm exec <id> -- <cmd> [args]` and the in-VM harness). Dispatches control-plane → runtime-manager DIRECTLY over the `RuntimeManager.Exec` bidi stream (the scheduler places workloads; the manager owns the exec channel), capped at 1 MiB/stream in control-plane memory since output comes from an untrusted workload. Live regression test: `internal/handlers/runtime_exec_e2e_test.go` (opt-in `LANTERN_RUNTIME_E2E=1`) |
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
  follow-up; the shared token is the GA step. **The same interceptor now guards
  the workflow-engine gRPC port (`:50052`) and the runtime-scheduler gRPC port
  (`:50055`)** — both previously trusted a metadata `tenant_id` with no credential
  check (cross-tenant run-control / microVM-compute takeover). Both run the
  service-auth interceptor before tenant extraction, fail-closed in prod, and the
  control-plane caller (`internal/handlers/runtime.go`) attaches the token as
  `PerRPCCredentials`. Set `LANTERN_GRPC_SERVICE_TOKEN` to the **same value** on
  control-plane, gateway, workflow-engine, and runtime-scheduler.

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

**Intelligence layer ("personal OS").** A set of pure, owner-only, best-effort
modules give the assistant stable identity (owner corrections > AddressBook,
`identity.ts` + `entity-binding.ts`), truthful presence (never fabricate a
place; stale overrides yield to fresh iPhone signals, `presence.ts`),
thread-peek (answer from the real chat.db / wa-history thread, `thread-peek.ts`),
location privacy per contact (`disclosure.ts`), and cross-app self-context
synthesis (`working-memory.ts`). State is `0600` JSONL under `~/.lantern/`;
nothing touches the control plane. The highest-PII stores (`episodes.jsonl`,
`topic-index.jsonl`, `dislike-patterns.jsonl`) are additionally **AES-256-GCM
encrypted at rest** via `bridge-core/src/secure-store.ts` (`enc1:` line
envelope; key auto-created 0600 at `<stateDir>/state.key`; legacy plaintext
lines still read and age out — no migration). **Full reference + owner self-chat commands:
[`docs/personal/INTELLIGENCE-LAYER.md`](docs/personal/INTELLIGENCE-LAYER.md).**

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
- spouse: Sam
- kids: Kai, Nia
- wedding anniversary: 2017-06-03
```

Date values must be `YYYY-MM-DD`. The bot renders them as "June 3, 2017" in
the prompt. `factsBlock()` produces a single injected line like
`"Owner facts (TRUE — never deny or contradict these): married to Sam; …"`.

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
Parenthetical aliases also work: `Sam(Mae): wife` indexes both names.

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
4. LLM clustering pass for fuzzy/novel patterns the regexes miss: **on by
   default** (both bridges wire the `llmCall`); opt out with
   `LANTERN_DISLIKE_LLM_CLUSTER=0`. Fail-safe (any LLM/parse error →
   deterministic lessons only) and an LLM cluster can only ADD or RAISE a lesson
   through the same minSupport/graduation guards, never clobber a higher-support
   deterministic one. Uses a throwaway `owner::dislike-cluster::<ts>` session key
   per run (no history accumulation, never a contact's session).

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

### Attention Engine (Brief v2 — LLM-ranked "what needs you")

The owner Brief (`?` / `today` / `whats up`) is the cross-thread attention
surface. `packages/bridge-core/src/attention.ts` (pure: prompt / tolerant
parse / candidate ids) + wiring in both bridges' `handleCenterCommand`:

- **Waiting-on-you threads.** `gatherWaitingForBrief()` reuses the
  anticipation overdue-reply detector and surfaces contacts left unanswered
  as numbered `thread` items (⏳, VIP-first, preview from inbound history) —
  previously these were gated out of real-time nudges AND absent from the
  Brief, so they vanished entirely.
- **LLM ranking across kinds.** `rankAttention()` sends drafts + commitments
  + waiting threads to the LLM (session key `attention::rank`, never a
  contact's live session) which returns strict JSON `{order, why}`; the model
  can only REORDER and ANNOTATE existing items (a VIP waiting 3 days can
  outrank a routine draft). ANY failure → deterministic order stands. `why`
  renders as a ` · reason` suffix on the numbered line.
- **Thread actions.** Bare `<n>` or `<n> draft` / `draft <n>` generates a
  reply draft in the owner's voice (respondTo on the CONTACT's session — the
  draft is that thread's business) and stages it in `pendingDraftEdits`
  (`attn:<handle>` key) so the standard drafts rail (send/edit) applies;
  `<n> review` peeks the last inbound; `<n> skip` suppresses the thread for
  the session (`attentionSkipped`).
- **Reactions as an API (one-tap layer).** A reaction/tapback on a
  remembered center-view message acts on its TOP item — 👍/❤️ confirm
  (draft→send, commitment→done, thread→draft), 👎/❌ skip, ⏰ snooze,
  ❓ review. `ReactableLog` + `mapBriefReactionToAction` +
  `tapbackToEmoji` live in `reaction-commands.ts`; Brief semantics WIN over
  the legacy emoji map for remembered messages. iMessage captures sent-Brief
  GUIDs via the `pendingBriefEcho` → poll-harvest pairing (mirrors
  queueReplyMeta); WA uses the sendMessage key directly. `auto_action` undo
  is never tap-triggered (destructive → needs a typed word).
- **Living Brief (WA only).** Resolving an item within 14 min of a Brief
  send edits the original WhatsApp message in place, striking through the
  done line (`strikeBriefLines`). Best-effort; iMessage has no edit API.
- **Dashboard depth view.** Both bridges expose
  `GET /session/:tenantId/attention` (last Brief flattened:
  `{generatedAt, channel, items[{n,ref,id,icon,label,why?,defaultAction}],
  counts}`); the `/inbox` page's **Personal tab** merges both channels
  (read-only + copy-command affordances — chat is the acting surface).

### Skill forge (safe self-improvement loop)

The owner teaches the assistant new recurring capabilities from self-chat.
`packages/bridge-core/src/skill-forge.ts` (pure: request grammar, spec
prompt/parse, schedule matching, formatting) + wiring in both bridges.

- **Grammar.** `new skill: <what and when>` / `teach yourself to …` →
  `matchSkillRequest`. `skills` lists; `drop skill <n>` removes.
- **Draft → approve.** The LLM drafts a `SkillSpec`
  `{name, description, schedule{hour,minute,daysOfWeek}, prompt}` (session key
  `skillforge::spec`, strict JSON, tolerant parse; honest `{error}` when the
  request can't be a scheduled prompt). The owner sees a proposal and must
  reply `approve skill` (10-min TTL) before anything activates — nothing
  self-installs.
- **A skill is a PROMPT, not code.** Each firing runs the spec's `prompt`
  through `respondTo("skill::<name>")` with web_search on and delivers the
  result to self-chat. No shell, no filesystem, no new capability surface —
  that is the line OpenClaw crossed and this deliberately does not.
- **Fires on the proactive tick** (`maybeRunSkills`), so killswitch, mute,
  and quiet hours gate it like every other loop. `dueSkills` matches
  owner-local `daysOfWeek`+`hour:minute` within a 50-min window (> the
  ~45-min tick so none are missed) and `lastFiredDay` is stamped BEFORE
  execution (a crash drops one delivery rather than double-firing).
- State: `bridge_state/<tenant>/skills.json` (0600). Bot-self prefixes
  `🛠` / `✅ skill live` registered in `bot-self.ts`.

### Time-travel recap ("what did I miss")

`packages/bridge-core/src/time-travel.ts` (pure: `looksLikeRecapRequest`,
`parseRecapWindow`, `buildRecapPrompt`, `finalizeRecap`) + `maybeHandleRecap`
in both bridges. Owner self-chat `what did I miss` / `what happened while I was
out` / `catch me up` (optional window `last 3 hours` / `today` / `overnight`;
default 6h). The bridge gathers what landed since the cutoff — waiting-on-you
contacts (`gatherAwaitingReply`) + the assistant's own recent actions
(`recentActions`, `presence` kind filtered) — and the LLM (`recap::synth`
session key) writes a SHORT narrative that leads with what matters. A
deterministic weight-ranked fallback (`finalizeRecap`) is truthful when the LLM
call fails. The request grammar caps at 80 chars so a real message isn't
mistaken for a recap ask; the narrative output matches no command grammar so it
can't loop.

### Event scout (proactive family-event discovery)

`packages/bridge-core/src/event-scout.ts` (pure: prompt/parse/format/command
grammar) + wiring in the iMessage session. Weekly (rides the anticipation
tick, so killswitch + quiet hours apply), the bridge runs a web_search-grounded
LLM scan (sessions under the registered `event-scout` agent — visible on the
dashboard Agents page; override with `LANTERN_EVENT_SCOUT_AGENT`; keys
`${owner}::eventscout<i>`) for the next 60 days of events
near the owner — kids/family, fireworks, Indian community (Telugu shows,
melas, temple events), circus, expos, light shows, fairs, county/state/DC —
and DMs a numbered list to self-chat. Discovery is LLM reasoning over live
search, never a hardcoded scrape list; the prompt forbids invented events.

Owner self-chat commands (both routing paths; strict anchored grammar):
`scan events` (manual scan) · `book 1,3` / `book all` (adds picks to
Calendar.app via MacActions with 1-day + 2-hour alarm reminders) ·
`events more` / `events` (page through the rest, 6 at a time) ·
`events categories` / `events add <cat>` / `events drop <cat>` (the category
list is owner-editable state, no code change to tune coverage) ·
`events location <place>`.

**Delivery UX (curation + grouping + paging).** When a scan finds >6 fresh
events, a second no-tools LLM call (`buildCurationPrompt`/`parseCuration`)
ranks them for the family and the owner gets only the top 4-6 picks with a
one-line why each; `applyCuration` moves picks to the front of `pending` so
numbering is global and `book 1` = top pick. The remainder is
category-grouped (`sortByCategory` on the scan LLM's own category labels —
Indian community together, fireworks together; `▸ <category>` headers, no
keyword heuristics) and paged 6-at-a-time via the `shown` cursor. Curation
failure falls back to the plain grouped list.

State: `bridge_state/<tenant>/event-scout.json` (0600) — categories, location,
audience, seen-event dedupe keys (120-day TTL), last shown list. Bot-self
prefixes `🎪 ` / `🎟 ` are registered in `bot-self.ts`. Env:
`LANTERN_EVENT_SCOUT=0` disables the scheduled scan (commands still work);
`LANTERN_EVENT_SCOUT_LOCATION` / `LANTERN_EVENT_SCOUT_AUDIENCE` override the
defaults baked into `defaultScoutState()`. Each scan runs one LLM call per
category batch (`chunkCategories`, 3/call) with a 480s per-call `timeoutMs`
(`AgentClient.respondTo` now takes a per-call timeout) — a single
all-category turn exceeds the 180s SSE default. The WhatsApp bridge mirrors
the full command surface; its SCHEDULED scan defaults OFF
(`LANTERN_EVENT_SCOUT_WA=1` to enable) so the weekly list isn't texted on
two channels.

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
| `LANTERN_OWNER_NAME`                  | First name used for ranker boost ("Ada" → boost files whose path contains "ada" when the query says "my")                                                                                |
| `LANTERN_OWNER_EMAIL`                 | Mirror destination for bot status updates                                                                                                                                                        |
| `LANTERN_OWNER_TIMEZONE`              | IANA timezone (e.g. `America/Los_Angeles`). Used by quiet hours, daily digest scheduling, and calendar lookups. Defaults to process timezone when unset.                                         |
| `LANTERN_IMESSAGE_OWNER_HANDLE`       | (Optional) Owner's primary iMessage handle (phone or email). When set, bridge accepts DMs from this handle as owner-channel (dedicated-bot mode). When unset, falls back to self-chat detection. |
| `LANTERN_WA_OWNER_JID`                | (Optional) Owner's primary WhatsApp JID — `15125551234` or `15125551234@s.whatsapp.net`. Same role as the iMessage env.                                                                          |
| `LANTERN_PERSONAL_DOCS_ROOTS`         | Colon-separated allowed roots (default `~/Documents:~/Desktop:~/Downloads:~/Library/Mobile Documents/com~apple~CloudDocs`)                                                                                   |
| `LANTERN_PERSONAL_DOCS_OCR_MAX_PAGES` | Max PDF pages to render+OCR per file (default 3)                                                                                                                                                 |
| `LANTERN_MAIL_INDEX`                  | (Optional) Set to `0`/`off` to disable the OWNER-ONLY `search_email` tool (read-only search over Apple Mail's local "Envelope Index" SQLite — sender/subject/date of the owner's ENTIRE synced mailbox incl. Gmail, no OAuth). Default ON. Fails closed; live read-only open, never copied, so results are never stale. |
| `LANTERN_MAC_USAGE`                   | (Optional) `on` to enable the OWNER-ONLY Mac app-usage signal (reads knowledgeC.db, distills one "what you've been doing today" line into the owner's self-chat context). Default OFF. Summaries only; fails closed. |
| `LANTERN_MAC_USAGE_SEC`               | (Optional) Mac app-usage refresh interval in seconds (min 60, default 1800 = 30 min).                                                                                                            |
| `LANTERN_DEFAULT_CALENDAR`            | Calendar name to use when LLM doesn't specify (default tries `Home` / `Calendar` / `Personal` / `Work`)                                                                                         |
| `LANTERN_QUIET_START`                 | Start of quiet-hours window, 24h integer (default `1` = 1 AM). No auto-reply; messages queued for morning replay.                                                                                |
| `LANTERN_QUIET_END`                   | End of quiet-hours window, 24h integer (default `6` = 6 AM).                                                                                                                                    |
| `LANTERN_QUIET_QUEUE_MAX`             | Max messages buffered in the overnight queue per bridge (default 200).                                                                                                                           |
| `LANTERN_PROACTIVE_NUDGES`            | Set to `0` to disable anticipation nudges entirely (default on).                                                                                                                                 |
| `LANTERN_LIVE_WATCH`                  | Set to `0`/`off` to disable live watches (default on) — LLM-detected follow-ups on live public situations a contact mentioned (flight in the air, game, outage): re-checked via `web_search` every 15–120 min, resolved with one short follow-up text ("just saw he landed"). One active watch per contact, ≤8 total, ≤12h, killswitch/mute/quiet-hours aware. State: `<stateDir>/live-watches.jsonl` (0600). |
| `LANTERN_DRAFT_CONFIRM`               | Set to `0` or `off` to disable draft-and-confirm for LOW-confidence replies (reverts to 5s hold → auto-send). Default on.                                                                        |
| `LANTERN_DISLIKE_LLM_CLUSTER`         | Set to `0` to DISABLE the LLM fuzzy-clustering pass in the 👎 flywheel (the novel-preference learner). Default ON; fail-safe (deterministic pass always runs). Both bridges wire the `llmCall`. |
| `LANTERN_VOICE_REASONING`             | (Optional) `1`/`true`/`on` → replace the static `inferStyle` heuristic with an LLM-reasoned owner-voice profile (register/code-switching/emoji-meaning/warmth), derived from the owner's own recent messages, cached + refreshed slowly. Default OFF (heuristic runs, byte-identical). Fail-safe → heuristic on any error; dedicated `owner::voice-profile` session key. |
| `LANTERN_INTENT_ROUTER`               | (Optional) `1`/`true`/`on` → run an LLM intent-reasoning classifier upstream of the owner-message regex gate stack (disclosure-deny-led; also recap). Default OFF (the regex gates run, byte-identical). Additive: on ANY uncertainty/error/timeout it falls back to the regex gates (the floor); owner-only; throwaway `owner::intent::<ts>` session key; only routes to EXISTING handlers. |
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
(`~/Library/LaunchAgents/dev.lantern.*.plist`). Bridge env overrides go in
`~/.lantern/bridge.env` (sourced by `scripts/launchd/run-bridge-wrapper.sh` at
every start, overrides plist env) — takes effect with a plain
`launchctl kickstart -k`, no bootout/bootstrap needed. The iMessage bridge needs
Full Disk Access (chat.db) + Automation permission (Messages.app), which
is per-binary in macOS TCC — easiest path is to run it via Terminal
(which already has those grants) or grant FDA explicitly to
`/Users/shakes/.nvm/.../node` for true always-on. See
`docs/personal/BOT-SETUP.md`.

### Web-search grounding (built-in `web_search` tool)

The session tool loop has an always-on built-in `web_search` tool
(`services/control-plane/internal/handlers/web_search.go`): Anthropic's
server-side web search (one-shot Messages call with the tenant's key), falling
back to OpenAI's `web_search_options` search-preview models when no Anthropic
key resolves. It passes the read-only contact filter (public internet =
read-only). The bridges set the `webSearch: true` session flag on EVERY
contact reply — with `noTools` that attaches ONLY web_search (no connector
catalog) — and the persona gains a LIVE-LOOKUP rule (`canWebSearch` in
`natural.ts`): check live facts (flight status, news, hours) before replying,
read identifiers from the thread + image captions, never deflect with "keep
me posted", never narrate the tool.

| Env var (control-plane)          | Default                      | Purpose                          |
| -------------------------------- | ---------------------------- | -------------------------------- |
| `LANTERN_WEBSEARCH_MODEL`        | `claude-sonnet-4-6`          | Anthropic search-summarizer model |
| `LANTERN_WEBSEARCH_OPENAI_MODEL` | `gpt-4o-mini-search-preview` | OpenAI fallback model             |

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
| `POST` | `/session/:tenantId/mail/search` (iMessage bridge)  | Local Apple Mail envelope-index search backing the `search_email` tool. Owner-only via session gating; 422 when the index is unavailable/disabled.        |
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
