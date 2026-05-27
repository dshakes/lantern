# Lantern

**The agent platform you can run on your laptop and ship to production with one command. Real WhatsApp/Slack/voice/web channels, durable workflows, predictable cost, eval-in-CI, and cryptographically verifiable receipts — all in your VPC.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-lantern.dev-8B5CF6?style=flat-square)](https://docs.lantern.dev)
[![Discord](https://img.shields.io/discord/placeholder?label=discord&style=flat-square&color=5865F2)](https://discord.gg/lantern)

```bash
lantern dev   # boots Postgres + Redis + MinIO + API + dashboard + WhatsApp bridge
              # opens browser, hot-reloads on every save
```

Lantern is the only agent platform that combines five things end-to-end:

1. **One-command local dev.** `lantern dev` spins up the whole stack with hot reload. No five-tab terminal dance.
2. **Real channels — agents that talk on WhatsApp/Slack/voice/webchat like humans.** Pair your own WhatsApp via QR (we ship the bridge). The natural-communication layer paces replies, mirrors reactions to acks, splits long answers into burst messages, and refuses to sound like ChatGPT. Your friends will not know.
3. **A cost forecast before every run.** `POST /v1/runs/forecast` returns estimated tokens, dollars, and confidence. Hard-fail budgets block runs that would overspend with HTTP 402.
4. **Eval-in-CI.** `lantern test --against=last-green` compares this branch to the last green baseline and fails on regression. Rehearsals replay past failures from production against your candidate version.
5. **Cryptographically verifiable receipts.** Every run can be HMAC-signed. Share the JSON; any third party can verify what executed at `/proof`. Cross-tenant invocations (W11c marketplace) settle through the same primitive.

Plus: multi-LLM routing, durable workflow execution that runs your visual editor's graph (not just saves it), 17 real connector APIs with real OAuth, embeddable webchat widget, A/B with auto-promotion, A2A interop, RLHF feedback baked in, human-takeover for in-flight runs, and a forkable agent marketplace with HMAC-signed cross-tenant commerce.

100% Apache 2.0. No feature gates. The managed cloud is convenience, not a paywall.

---

## The wedge

| What every agent framework ships | What Lantern adds |
|---|---|
| `npm install` + a tutorial. | **`lantern dev` boots the entire stack** (Postgres + Redis + MinIO + control-plane + dashboard + WhatsApp bridge) with hot reload and tagged log streams. One verb. |
| Chat-only, in their dashboard. | **Real channels.** Pair your WhatsApp by scanning a QR code. Embed a webchat `<script>` on any site. Voice numbers via Twilio/LiveKit. Agents reply on the surfaces your users already use. |
| Bot-speak that screams "AI". | **Natural communication layer.** Mirrors thumbs-up to "k", splits long replies into 2-3 paced messages with typing indicators, strips assistant-isms ("Certainly!", "Let me know if you need anything else"), infers conversational register per contact. Tested in 25 unit cases. |
| "Your agent probably costs about…" | **Pre-run cost forecast.** `POST /v1/runs/forecast` returns estimated tokens, dollars, and confidence grounded in your last 30 days of runs. Hard-fail runs that would exceed budget return HTTP 402. |
| "Monitor your evals in prod." | **Eval-in-CI + rehearsals.** Define suites declaratively, pin a baseline per branch, regress-check in pre-merge CI. Replay past production failures against new versions before flipping traffic. |
| Visual workflow designer that doesn't actually run anything. | **Workflow runtime that executes the saved graph.** trigger/ai-step/tool/connector/condition/end nodes all dispatch through the same LLM router + connector executor + budget enforcer as everything else. |
| "Trust us about what happened." | **Verifiable receipts.** HMAC-signed JSON over the journal-event SHA-256. Share with anyone; they verify at `/proof`. Cross-tenant marketplace invocations settle through the same primitive. |
| Auto-approve "human in the loop." | **Real takeover handshake.** Workflow approval nodes block on `takeover_requests`; operators grant → optionally exchange WebRTC SDP for live VM view → release when done. |
| "Deploy to our cloud." | **Deploy in your cloud.** Data plane runs in your EKS/GKE/AKS. Firecracker microVM isolation. Only metadata crosses the tunnel. |
| Hardcoded Anthropic/OpenAI. | **Provider-agnostic router.** Bring your own keys, swap providers, plug in a custom smart gateway. |

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
lantern dev
```

That's it. One command. It will:
- Start Postgres + Redis + MinIO via docker-compose (detached).
- Run the control-plane API (`:8080`) as a host Go process so your edits hot-reload.
- Run the Next.js dashboard (`:3001`) with HMR.
- Run the WhatsApp bridge (`:3100`) under `tsx` with hot reload.
- Tail every process's logs with per-service color tags into one terminal.
- Wait for `/healthz` and open `http://localhost:3001` in your browser.

Default login: `admin@lantern.dev` / `lantern`.

Flags worth knowing:

```bash
lantern dev --infra-only        # just Postgres+Redis+MinIO (BYO API + dashboard)
lantern dev --no-open           # don't auto-open the browser
lantern dev --dashboard-port 4000
lantern dev down                # stop everything
```

The four-Makefile-target dance (`make dev-infra` + `make run-api` + `make dashboard-dev` + `make run-whatsapp-bridge`) still works for power users, but `lantern dev` is the default daily-driver.

---

## Feature matrix

| Capability | Ships now | Notes |
|---|:---:|---|
| **One-command local dev** | ✅ | `lantern dev` boots infra + API + dashboard + bridges, hot reloads |
| **WhatsApp pairing + natural reply layer** | ✅ | QR pairing, paced burst messages, reaction-mirror on acks, persona prompt |
| **Embeddable webchat widget** | ✅ | `<script src=".../widget.js">` on any site; talks to `/v1/sessions` |
| **Voice channel (Twilio/LiveKit pluggable)** | ✅ | `voice_numbers` + `voice_calls`; `VoiceProvider` interface |
| **Workflow runtime** | ✅ | Saved graphs execute (trigger/ai-step/tool/connector/condition/approval/end) |
| **Headless microVM runtime** | ✅ | `runtime-scheduler` placement + `harness` (Rust, in-VM) for egress allowlist, JWT secret vending, OTel. Endpoints: `POST /v1/runtime/schedule`, dashboard at `/runtime`, CLI `lantern run <agent.yaml>`. Demos in `examples/headless-agents/` |
| **Verifiable HMAC receipts** | ✅ | `/v1/runs/{id}/receipt`, public verifier at `/proof`, key fingerprint at `/.well-known/lantern-receipts` |
| **Cross-tenant marketplace commerce** | ✅ | `POST /v1/marketplace/{slug}/invoke` settles via signed invocation receipt |
| **Human takeover handshake** | ✅ | `takeover_requests` table + WebRTC SDP fields; workflow approval blocks on it |
| **Run trace waterfall** | ✅ | Nested-span timeline with per-span tokens, cost, latency |
| **RLHF feedback widget** | ✅ | Thumbs + preferred-output on every run; feeds rehearsals |
| **Rehearsals** | ✅ | Replay past failures against candidate version; gates CI merge |
| **Pre-run cost forecaster** | ✅ | `POST /v1/runs/forecast` — historical + heuristic blend |
| **Policy-as-code budgets** | ✅ | Per-day cost, per-run cost, per-tool rate limits |
| **Eval suites + CI gating** | ✅ | Baselines per branch, regression returns HTTP 422 |
| **A/B experiments** | ✅ | Deterministic FNV-1a traffic split, auto-promotion on >2% lift |
| **Marketplace (publish/fork/star/buy)** | ✅ | Real tenant isolation, cross-tenant invocation, signed settlement |
| **MCP server registry** | ✅ | Curated servers, attach to any agent |
| **Managed sessions** | ✅ | Multi-turn, SSE streaming, persists across restarts |
| **17 connector APIs (real dispatch)** | ✅ | Gmail, GCal, Drive, Sheets, Slack, Discord, Telegram, Twilio, GitHub, Linear, Jira, Sentry, Vercel, Notion, HubSpot, Salesforce, Stripe — popup OAuth |
| **Smart model routing** | ✅ | `auto`, `reasoning-large`, `code-large` — balanced/cheap/quality/fast |
| **Provider-agnostic LLM layer** | ✅ | Bring your own keys; swap vendors anytime |
| **Visual workflow editor + interpreter** | ✅ | React Flow; saved graph executes against the real LLM+connector pipeline |
| **Cron scheduling** | ✅ | With optional email delivery |
| **A2A protocol + agent cards** | ✅ | `/.well-known/agent.json`, cross-tenant invocation |
| **Guardrails (PII, content, topic)** | ✅ | Per-agent, configurable |
| **TS SDK (full parity)** | ✅ | Primary SDK |
| **Python SDK (full parity)** | ✅ | Secondary |
| **Go SDK** | ✅ | For infra integrations |
| **`lantern` CLI** | ✅ | `dev`, `init`, `deploy`, `test`, `runs`, `agents`, `logs`, `login` |
| **Managed cloud (one-click deploy)** | ✅ | Billing + autoscaling |
| **Customer VPC data plane** | ✅ | EKS/GKE/AKS, Firecracker isolation |

---

## Engineering principles

Lantern is written under a deliberate set of rules. They're enforced in `CLAUDE.md` (the AI-agent contributor guide) and in code review.

1. **No silent mocks.** Every UI hits a real endpoint, a real DB row, a real network call. When the API is unreachable the dashboard shows an explicit "Demo data" banner via `notifySimulated` — the lie is never invisible.
2. **Truthful wording.** "Provision a data plane" only ships if we provision; until then it says "Register." Words mean what they say.
3. **Polyglot on purpose.** Go for control plane + workflow engine. Rust for the hot path (gateway, router, runtime-manager). TypeScript for dashboard + primary SDK. Python + Go SDKs at full parity. Each layer uses the right tool, not the unifying one.
4. **One source of truth per concern.** Tenant IDs come from `useAuth().user.tenantId`, never a hardcoded string. The DEMO_USER sentinel is in *one* place; everything else references it.
5. **Architectural invariants (in `CLAUDE.md`).** Control plane never touches user code. Workflow engine is the only mutator of run state. All long operations are durable. Streaming is end-to-end with no buffering. Untrusted code runs in a microVM. Models are addressed by capability, not vendor name. Every row has `tenant_id`. Every external side-effect carries an idempotency key.
6. **Tests before prose.** New behavior ships with unit tests (88 bridge tests, 6 workflow interpreter tests, growing). Bug fixes ship with regression tests.
7. **No half-finished implementations.** A feature is either real end-to-end or it doesn't exist. Where external dependencies block the last mile (Firecracker microVM for W11a, voice provider for W11d), the platform interface is the boundary and the cred plugs in.
8. **Cryptographic auditability is a primitive, not a feature.** Every run can be HMAC-signed. Cross-tenant commerce settles through the same signing key. The same `/.well-known/lantern-receipts` fingerprint verifies both surfaces.

## OSS stance

Apache 2.0, no catches. Every differentiator above is in this repo. The managed cloud offers convenience (one-click deploy, billing, autoscaling), not gated features. Self-host the full stack if you want.

You choose:
- your LLM providers (any combination of Anthropic, OpenAI, Google, open models via your own smart gateway)
- where the data plane runs (our cloud or yours)
- which models answer which capability aliases
- whether to use our smart router or swap in your own
- which surfaces ship: WhatsApp, Slack, Telegram, voice, webchat, email — pick what you need

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
lantern dev                         # boot the FULL stack (infra + API + dashboard + bridges)
  --infra-only                      #   just Postgres+Redis+MinIO (BYO services)
  --with-whatsapp=false             #   skip the WhatsApp bridge
  --no-open                         #   don't auto-open the browser
lantern dev down                    # stop infra containers

lantern init                        # scaffold a new agent
lantern agents list                 # list agents
lantern runs create --agent=x       # dispatch a run
lantern test --agent=x --suite=y    # run eval suite + compare to baseline
  --against=last-green              #   fail the CI build on regression
  --set-baseline                    #   pin this run as the new baseline
  --rehearse                        #   replay past failures against current version
lantern deploy --agent=x --env=prod # ship to managed cloud
lantern logs --run=<id> -f          # tail event stream
lantern login                       # token-based auth
```

Four verbs do 95% of the daily workflow: `dev`, `deploy`, `test`, `login`.

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
