# Lantern

**Open-source runtime for production AI agents — predictable cost, catch regressions in CI, deploy in your own VPC.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-lantern.dev-8B5CF6?style=flat-square)](https://docs.lantern.dev)
[![Discord](https://img.shields.io/discord/placeholder?label=discord&style=flat-square&color=5865F2)](https://discord.gg/lantern)

Lantern is the agent platform you can actually put in front of paying customers. It gives you three things that every other agent framework hand-waves away:

1. **A cost forecast before every run.** Know what a run will spend before you dispatch it. Block runs that would blow the budget. No more $40,000 surprises.
2. **Eval-in-CI.** `lantern test --against=last-green` compares this branch's eval score to the last green baseline and fails the build on regression. Agents stop silently getting worse.
3. **Deploy in your own VPC.** Control plane runs managed or self-hosted; the data plane — the thing that actually runs agents and touches your data — lives in your cluster. SOC2 and enterprise-friendly by design.

Under the hood: multi-LLM routing (provider-agnostic, bring your own keys), durable workflow execution, managed multi-turn sessions, 17 real connector APIs, a full MCP server registry, policy-as-code per-tool budgets, A/B traffic splitting with auto-promotion, A2A interop, and a forkable agent marketplace.

100% Apache 2.0. No feature gates. The managed cloud is a convenience, not a paywall.

---

## The wedge

| What every agent framework ships | What Lantern adds |
|---|---|
| "Your agent probably costs about…" | **Pre-run cost forecast.** POST `/v1/runs/forecast` returns estimated tokens, dollars, and confidence grounded in your last 30 days of runs. Hard-fail runs that would exceed budget return HTTP 402. |
| "Monitor your evals in prod." | **Eval-in-CI.** Define suites declaratively, pin a baseline per branch, and regress-check in pre-merge CI. Non-zero exit on drop. |
| "Deploy to our cloud." | **Deploy in your cloud.** Data plane runs in your EKS/GKE/AKS. Firecracker microVM isolation. Only metadata crosses the tunnel. |
| Hardcoded Anthropic/OpenAI. | **Provider-agnostic router.** Bring your own keys, swap providers, plug in a custom smart gateway. |
| Mock marketplace pages. | **A real marketplace** — publish, fork, star, with per-tenant isolation. |

---

## 60-second example

```bash
npm install @lantern/sdk
```

```ts
import { LanternClient } from "@lantern/sdk";

const lantern = new LanternClient({ apiKey: process.env.LANTERN_API_KEY });

// 1. Create an agent.
await lantern.agents.create({
  name: "triage",
  description: "Classifies incoming support emails",
});

// 2. Set a hard budget — never spend >$25/day, >$0.10/run.
await lantern.budgets.upsert("triage", {
  maxCostUsdPerDay: 25,
  maxCostUsdPerRun: 0.10,
  hardFail: true,
});

// 3. Forecast before dispatching — HTTP 402 if budget-blocked.
const forecast = await lantern.runs.forecast({
  agentName: "triage",
  input: "Hey, my invoice is wrong again...",
});
console.log(`Expect ~$${forecast.estimatedCostUsd} (${Math.round(forecast.confidence * 100)}% confidence)`);

// 4. Run it.
const run = await lantern.runs.create({
  agentName: "triage",
  input: { email: "..." },
});

// 5. In CI, fail the build if the new version regresses.
// $ lantern test --agent=triage --suite=golden --against=last-green
```

---

## Quick start — local dev

```bash
# Boot Postgres + Redis + MinIO + control-plane in docker-compose.
lantern dev

# Or the manual path:
make dev-infra        # Postgres + Redis + MinIO only
make run-api          # control-plane on :8080
make dashboard-dev    # Next.js dashboard on :3000
```

Log in at `http://localhost:3000` with `admin@lantern.dev` / `lantern`.

---

## Feature matrix

| Capability | Ships now | Notes |
|---|:---:|---|
| Pre-run cost forecaster | ✅ | `POST /v1/runs/forecast` — historical + heuristic blend |
| Policy-as-code budgets | ✅ | Per-day cost, per-run cost, per-tool rate limits |
| Eval suites + CI gating | ✅ | Baselines per branch, regression returns HTTP 422 |
| A/B experiments | ✅ | Deterministic traffic split, auto-promotion on >2% lift |
| Marketplace (publish/fork/star) | ✅ | Real tenant isolation, not a mock |
| MCP server registry | ✅ | 8 curated first-party servers, attach to any agent |
| Managed sessions | ✅ | Multi-turn, SSE streaming, persists across restarts |
| 17 connector APIs | ✅ | Gmail, GCal, Drive, Sheets, Slack, Discord, Telegram, Twilio, GitHub, Linear, Jira, Sentry, Vercel, Notion, HubSpot, Salesforce, Stripe |
| Smart model routing | ✅ | `auto`, `reasoning-large`, `code-large` — balanced/cheap/quality/fast |
| Provider-agnostic LLM layer | ✅ | Bring your own keys; swap vendors anytime |
| Visual workflow editor | ✅ | React Flow; persists to `agents.workflow` JSONB |
| Cron scheduling | ✅ | With optional email delivery |
| A2A protocol + agent cards | ✅ | `/.well-known/agent.json` |
| Guardrails (PII, content, topic) | ✅ | Per-agent, configurable |
| TS SDK (full parity) | ✅ | Primary SDK |
| Python SDK (full parity) | ✅ | Secondary |
| Go SDK | ✅ | For infra integrations |
| `lantern` CLI | ✅ | `init`, `deploy`, `test`, `dev`, `runs`, `agents`, `logs`, `login` |
| Managed cloud (one-click deploy) | ✅ | Billing + autoscaling |
| Customer VPC data plane | ✅ | EKS/GKE/AKS, Firecracker isolation |

---

## OSS stance

Apache 2.0, no catches. The four differentiators above are all in this repo. The managed cloud offers convenience (one-click deploy, billing, autoscaling), not gated features. Self-host the full stack if you want.

You choose:
- your LLM providers (any combination of Anthropic, OpenAI, Google, open models via your own smart gateway)
- where the data plane runs (our cloud or yours)
- which models answer which capability aliases
- whether to use our smart router or swap in your own

The only things we ask for in the managed offering are your money (transparent per-run pricing) and usage telemetry we need to bill you.

---

## Architecture

```
                              +------------------------+
        SDK / CLI / ----------|   Control Plane        |
        Dashboard             |   Go, :8080 REST       |
                              |   :50051 gRPC          |
                              +-----------+------------+
                                          |
     +----------+-----------+---------+---+-------+-----------+---------+
     v          v           v         v           v           v         v
 +--------+ +--------+ +----------+ +--------+ +--------+ +--------+ +---------+
 | Agents | | Runs + | | Budgets  | | Evals  | | A/B    | | Market | | MCP     |
 | Versions| |Forecast| |  (policy)| | + CI   | | exps   | | place  | | registry|
 +--------+ +--------+ +----------+ +--------+ +--------+ +--------+ +---------+
     |          |          |           |          |          |           |
     +----------+----------+--------+--+----------+----------+-----------+
                                    |
                   Postgres (pgvector) + Redis + S3/MinIO
                                    |
                     gRPC tunnel (outbound-only, mTLS)
 ===========================================================================
    DATA PLANE   (customer VPC — EKS/GKE/AKS — or Lantern managed cloud)

     +---------------------+     +--------------------+      +-------------+
     | Workflow Engine     |     | Runtime Manager    |      | Model       |
     | durable steps       +---->| Firecracker / Kata |----->| Router      |
     | journal + replay    |     | K8s Jobs           |      | multi-LLM   |
     +---------------------+     +--------------------+      +-------------+
```

Only metadata and routing decisions cross the tunnel. Tokens, prompts, and customer data stay in the data plane's cloud account. See [`docs/architecture/01-overview.md`](docs/architecture/01-overview.md).

---

## Project layout

```
lantern/
  services/
    control-plane/        Go    -- REST + gRPC, forecaster, budgets, evals, experiments, marketplace, MCP
    workflow-engine/      Go    -- durable step execution, event sourcing
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
    sdk-python/           Py    -- Python SDK (full parity)
    sdk-go/               Go    -- Go SDK (forecasts, budgets, evals, runs)
    cli/                  Go    -- `lantern` CLI (Cobra)
    proto/                proto -- gRPC definitions
    ui-kit/               TS    -- shared React component library
  apps/
    web/                  TS    -- Next.js 15 dashboard (RSC + streaming)
    docs/                 TS    -- documentation site
    landing/              TS    -- marketing site
  infra/
    docker/                     -- docker-compose dev stack
    helm/                       -- Helm charts
    terraform/                  -- AWS/GCP IaC modules
  docs/
    architecture/               -- design documents
    adr/                        -- Architecture Decision Records
```

---

## CLI

```
lantern init                      # scaffold a new agent
lantern dev                       # boot local Postgres+Redis+MinIO+control-plane
lantern agents list               # list agents
lantern runs create --agent=x     # dispatch a run
lantern test --agent=x --suite=y  # run eval suite + compare to baseline
  --against=last-green            #   fail the CI build on regression
  --set-baseline                  #   pin this run as the new baseline
lantern deploy --agent=x --env=prod
lantern logs --run=<id> -f        # tail event stream
lantern login                     # token-based auth
```

---

## Local development

| Service | Credentials |
|---|---|
| PostgreSQL | `lantern:lantern@localhost:5432/lantern` |
| Redis | `localhost:6379` |
| MinIO | `lantern:lanternsecret` at `localhost:9000` (console `:9001`) |
| Dashboard | `admin@lantern.dev` / `lantern` |

### Prerequisites

- Docker and Docker Compose
- Go 1.23+
- Node.js 22+ and npm

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
