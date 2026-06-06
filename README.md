<div align="center">

# 🏮 Lantern

**The agent platform you run on your laptop and ship to production with one command.**

Real WhatsApp / iMessage / Slack / voice / web channels · multi‑LLM routing · durable workflows · predictable cost · eval‑in‑CI · cryptographically verifiable receipts — all in your own cloud.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.23+-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev)
[![Rust](https://img.shields.io/badge/Rust-2024-CE412B?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-000000?style=flat-square&logo=next.js&logoColor=white)](https://nextjs.org)

```bash
make dev        # zero-toolchain: full stack in Docker
# — or —
lantern dev     # hot-reload daily driver: infra + API + dashboard + bridges, one verb
```

</div>

---

## What is Lantern?

Lantern is a **production runtime for AI agents**. It is a polyglot monorepo with a **control‑plane / data‑plane split**: a Go/Rust control plane that orchestrates agents, runs, budgets, evals, and routing — and a data plane (your EKS/GKE/AKS or Lantern's edge) where untrusted agent code executes in microVM isolation. Only metadata crosses the boundary; your prompts, tokens, and customer data never leave your cloud.

What makes it different from "another agent framework":

| Most agent frameworks | Lantern |
|---|---|
| `npm install` + a tutorial | **One command boots the whole stack** — Postgres + Redis + MinIO + control‑plane + dashboard + bridges, with hot reload and tagged logs |
| Chat‑only, inside their dashboard | **Real channels** — pair your own WhatsApp by QR, run iMessage on a Mac, Slack/Telegram/Discord, voice numbers (Twilio/LiveKit), an embeddable webchat `<script>` |
| "Your agent probably costs about…" | **A cost forecast before every run** — `POST /v1/runs/forecast` returns tokens, dollars, and confidence; hard‑fail budgets block overspend with HTTP 402 |
| "Monitor your evals in prod" | **Eval‑in‑CI + rehearsals** — pin a baseline per branch, fail the build on regression (HTTP 422), replay real production failures against a candidate before flipping traffic |
| A visual builder that only *saves* a graph | **A workflow engine that *executes* the graph** through the same router + connector + budget pipeline as everything else |
| "Trust us about what happened" | **Cryptographically verifiable receipts** — HMAC‑signed over the run's journal; anyone can verify at `/proof` |
| "Deploy to *our* cloud" | **Deploy in *your* cloud** — data plane in your VPC, Firecracker/Kata isolation, outbound‑only mTLS tunnel |

**100% Apache‑2.0. No feature gates.** Every differentiator here is in this repo; the managed cloud is convenience (one‑click deploy, billing, autoscaling), not a paywall.

<p align="center">
  <img src="docs/assets/lantern-architecture.svg" alt="Lantern architecture — control plane, data plane, surfaces, and data stores" width="100%">
</p>

---

## Five modules, one runtime

Lantern is organized as five composable modules over a shared runtime. (For the
elevator version, see [`PITCH.md`](PITCH.md).)

<p align="center">
  <img src="docs/assets/modules.svg" alt="Lantern's five modules over one shared runtime" width="100%">
</p>

| Module | What it gives you | Maturity |
|---|---|---|
| **1 · Agent Runtime** | Run agents in *your* cloud: durable workflow engine, capability‑based multi‑LLM router, microVM isolation (scheduler / manager / harness), edge gateway. Control plane never touches user code. | Core prod‑ready; microVM live‑boot is alpha (**fail‑closed**) |
| **2 · Personal Agent ("Jarvis")** | WhatsApp + iMessage assistant that texts **as you** — owner‑only, learns your real voice from history, agentic macOS actions, cross‑channel memory, urgent‑alerting, privacy guards. | Live |
| **3 · Trust & Governance** | Policy‑as‑code budgets (hard‑fail 402), eval‑in‑CI + rehearsals, HMAC‑verifiable receipts, guardrails, multi‑tenant RLS, AES‑256‑GCM secrets, fail‑closed‑in‑prod. | Prod‑ready |
| **4 · Channels & Reach** | WhatsApp · iMessage · Slack · Telegram · Discord · Voice (Twilio/LiveKit) · Webchat · Email — signature‑verified, naturally paced. | Prod‑ready |
| **5 · Developer Experience** | TS/Python/Go SDKs, `lantern` CLI, one‑command dev, a visual workflow editor that *executes*, MCP registry, A2A cards, forkable agent marketplace. | Prod‑ready |

> **Alpha honesty:** modules 2–5 are in real use; Module 1's microVM **live boot**
> (Firecracker), the live TLS/mTLS handshake, and secret‑vending transport are
> implemented + unit‑tested but ship **fail‑closed** pending Linux/KVM
> integration — enumerated in [`SECURITY.md`](SECURITY.md). Nothing pretends to work.

Every run is durable, budgeted, isolated, and cryptographically verifiable —
the same path for a backend job or a WhatsApp message:

<p align="center">
  <img src="docs/assets/run-lifecycle.svg" alt="Agent run lifecycle — budget gate, durable steps, capability routing, microVM isolation, signed receipt, eval-in-CI loop" width="100%">
</p>

---

## Quick start

### Option A — zero toolchain (Docker only) ⭐ fastest clone‑to‑running

You need only **Docker** (with Compose v2). Everything builds inside containers.

```bash
git clone https://github.com/dshakes/lantern.git
cd lantern
make dev          # builds + starts infra + control-plane + workflow-engine
                  # + gateway + model-router + dashboard + landing
```

Then open **http://localhost:3001** and log in with **`admin@lantern.dev` / `lantern`**.
The dev tenant, admin user, and schema are seeded automatically on first boot. Run `make seed` to add sample agents and runs.

> The macOS WhatsApp/iMessage bridges are **host services** (they need macOS Contacts/Calendar/chat.db), so they're not part of the Linux `make dev` stack — run them with `lantern dev` or `make run-whatsapp-bridge` / `make run-imessage-bridge`.

### Option B — hot‑reload daily driver (`lantern dev`)

The nicest local DX: host processes with hot reload, one terminal, tagged log streams. Needs Go + Node installed (see [Prerequisites](#prerequisites)).

```bash
git clone https://github.com/dshakes/lantern.git
cd lantern
( cd packages/cli && go install ./cmd/lantern )   # build the `lantern` binary onto your PATH

lantern dev       # ↓ boots everything, waits for /healthz, opens the dashboard
```

`lantern dev` installs each component's npm dependencies on first run (dashboard
and the bridges, including the shared `bridge-core`), so there's no separate
`npm install` step. It will:
- start **Postgres + Redis + MinIO** via Docker (detached),
- run the **control‑plane** API (`:8080` REST, `:50051` gRPC) as a host Go process so edits hot‑reload,
- run the **Next.js dashboard** (`:3001`) with HMR,
- run the **WhatsApp** (`:3100`) and **iMessage** (`:3200`, macOS only) bridges under `tsx`,
- tail every process with per‑service color tags, then open `http://localhost:3001`.

Flags worth knowing:

```bash
lantern dev --infra-only          # just Postgres + Redis + MinIO (bring your own services)
lantern dev --no-open             # don't auto-open the browser
lantern dev --with-whatsapp=false # skip the WhatsApp bridge
lantern dev --dashboard-port 4000
lantern dev down [--volumes]      # stop everything (optionally wipe data)
lantern dev logs <service> -f     # tail a single container
```

### Option C — power‑user, à la carte

```bash
make dev-infra        # terminal 1: Postgres + Redis + MinIO only
make run-api          # terminal 2: control-plane on :8080 (sets DATABASE_URL/REDIS_URL/S3_ENDPOINT)
make dashboard-dev    # terminal 3: dashboard on :3001
make run-whatsapp-bridge   # terminal 4 (optional): WhatsApp bridge on :3100
```

> 💡 `make run-api-free` routes LLM calls through your local `claude` CLI (Claude Max subscription) so you can run the whole platform at **$0** in development.

---

## Prerequisites

`make dev` (Option A) needs **only Docker**. Everything else is for host‑process development.

| Tool | Version | Needed for | Install (macOS) |
|---|---|---|---|
| **Docker** + Compose v2 | recent | everything (infra always runs in containers) | `brew install --cask docker` |
| **Go** | **1.23+** (CLI needs **1.25+**) | control‑plane, engine, scheduler, SDK‑go, CLI | `brew install go` |
| **Node.js** | **20 LTS+** | dashboard, landing, docs, SDK‑ts, bridges | `brew install node` |
| **Rust** | **1.85+** (edition 2024) | gateway, model‑router, runtime‑manager, harness | `brew install rustup-init && rustup-init` |
| **make** | any | task runner | preinstalled / Xcode CLT |
| **protoc** + `ts-proto` | recent | only `make proto` (regenerating types) | `brew install protobuf` |

On Linux, use your package manager (`apt install golang nodejs npm docker.io protobuf-compiler`, `rustup` from rustup.rs). There is no pinned `.nvmrc`/`rust-toolchain.toml` yet — any current LTS Node and stable Rust ≥ 1.85 work.

### Dev credentials (seeded, local only — never use in production)

| Service | Value |
|---|---|
| PostgreSQL | `postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable` |
| Redis | `redis://localhost:6379` |
| MinIO | `lantern` / `lanternsecret` at `localhost:9000` (console `:9001`) |
| Dashboard login | `admin@lantern.dev` / `lantern` |
| Dev tenant / user | `00000000-…-0001` (slug `dev`) / `00000000-…-0002` (role `owner`) |

For optional integrations (Google OAuth, real LLM keys, connector OAuth), copy `.env.example` → `.env.local` (gitignored) and fill in what you need; `make run-*` auto‑loads it.

---

## Service & port reference

| Service | Lang | Port(s) | Role |
|---|---|---|---|
| **control‑plane** | Go | `:8080` (REST/SSE) · `:50051` (gRPC) | system of record: agents, runs, sessions, budgets, evals, marketplace, MCP |
| **workflow‑engine** | Go | `:50052` (gRPC) | durable, event‑sourced step execution — the only mutator of run state |
| **model‑router** | Rust | `:50053` (gRPC) | capability‑based multi‑LLM routing, failover, caching |
| **runtime‑scheduler** | Go | `:50055` (gRPC) · `:8085` (REST) | microVM placement (warm‑pool / region / fair‑share / cost / health) |
| **runtime‑manager** | Rust | `:50054` (gRPC) | spawns isolated workloads (Firecracker / Kata / K8s / Wasmtime) |
| **harness** | Rust | in‑VM | PID 1 inside every microVM: egress allowlist, JWT vending, heartbeats |
| **gateway** | Rust | `:8443` (HTTPS) | TLS, auth, rate limit, end‑to‑end token streaming |
| **surface‑gateway** | Rust | `:8444` (HTTP) | inbound channel webhooks (Slack/WhatsApp/Telegram/Twilio/Discord) |
| **scheduler / memory / notifier / billing** | Go | internal | cron · vector memory · notifications · usage metering |
| **whatsapp‑bridge** | TS | `:3100` | macOS WhatsApp "Jarvis" assistant |
| **imessage‑bridge** | TS | `:3200` | macOS iMessage "Jarvis" assistant |
| dashboard / landing / docs | TS | `:3001` / `:3000` / `:3002` | Next.js apps |
| Postgres · Redis · MinIO | — | `:5432` · `:6379` · `:9000`/`:9001` | data stores |

---

## 60‑second SDK example

```bash
npm install @lantern/sdk
```

```ts
import { LanternClient } from "@lantern/sdk";

const lantern = new LanternClient({ apiKey: process.env.LANTERN_API_KEY });

// 1. Create an agent.
await lantern.agents.create({ name: "triage", description: "Classifies support emails" });

// 2. Hard budget — never spend >$25/day or >$0.10/run.
await lantern.budgets.upsert("triage", {
  maxCostUsdPerDay: 25, maxCostUsdPerRun: 0.10, hardFail: true,
});

// 3. Forecast before dispatching — would-exceed-budget returns HTTP 402.
const f = await lantern.runs.forecast({ agentName: "triage", input: "my invoice is wrong again..." });
console.log(`~$${f.estimatedCostUsd} (${Math.round(f.confidence * 100)}% confidence)`);

// 4. Run it.
const run = await lantern.runs.create({ agentName: "triage", input: { email: "..." } });

// 5. In CI: fail the build if the new version regresses against the last green baseline.
// $ lantern test --agent=triage --suite=golden --against=last-green
```

SDKs ship for **TypeScript** (primary), **Python**, and **Go**.

---

## Features

**Routing & models** · 4 routing strategies (`balanced` / `cheap` / `best` / `fast`) over capability aliases (`auto`, `reasoning-large`, `code-large`, …) — never hardcode a vendor model. Provider‑agnostic with failover and prompt/semantic caching; bring your own Anthropic/OpenAI keys or a custom gateway.

**Agents, runs & sessions** · Immutable agent versions · event‑sourced run journal with replay · interactive multi‑turn sessions with SSE streaming · distributed run locking · cron scheduling.

**Cost & safety rails** · Pre‑run cost forecaster (`/v1/runs/forecast`) · policy‑as‑code budgets (per‑day/per‑run/per‑tool, hard‑fail HTTP 402) · per‑agent guardrails.

**Quality & confidence** · Declarative eval suites with per‑branch baselines and CI gating (HTTP 422 on regression) · rehearsals that replay past production failures · A/B experiments with deterministic FNV‑1a splitting and auto‑promotion on >2% lift · RLHF run feedback.

**Workflows & humans** · Visual editor whose saved graph actually executes (`trigger / ai-step / tool / connector / condition / loop / approval / subagent / end`) · human‑takeover handshake (`takeover_requests` + WebRTC SDP).

**Integrations** · **17 real connector APIs** (Gmail, Google Calendar/Drive/Sheets, Slack, Discord, Telegram, Twilio, GitHub, Linear, Jira, Sentry, Vercel, Notion, HubSpot, Salesforce, Stripe) with real OAuth · **MCP** server registry + per‑agent attachments · **A2A** agent cards (`/.well-known/agent.json`).

**Marketplace** · Publish / fork / star public agents · cross‑tenant invocation with HMAC‑signed settlement.

**Trust** · Verifiable HMAC receipts over the journal SHA‑256, publicly verifiable at `/proof` · AES‑256‑GCM credential encryption at rest · multi‑tenant by default with Postgres RLS · idempotency keys on every external side‑effect · OTel traces carrying `tenant_id`/`run_id`/`step_id`.

**Headless microVM runtime** · Schedule untrusted agents into Firecracker / Kata / K8s Job / Wasmtime / devcontainer isolation; the in‑VM Rust harness enforces an egress allowlist and vends short‑TTL secrets. Per‑tenant quota (HTTP 402 over cap). Demos in [`examples/headless-agents/`](examples/headless-agents/).

**Surfaces** · WhatsApp · iMessage · Slack · Discord · Telegram · Voice (Twilio/LiveKit) · Webchat embed · Email.

---

## The personal assistant ("Jarvis")

Lantern ships two macOS bridges — **WhatsApp** and **iMessage** — that turn an LLM into a personal assistant that texts *as you*, on your own number, indistinguishably. This is a serious differentiator and a showcase of the platform's natural‑communication layer.

<p align="center">
  <img src="docs/assets/jarvis-pipeline.svg" alt="Jarvis reply pipeline — safety, context, persona, LLM, authenticity guards, confidence routing" width="100%">
</p>

- **Owner‑only & private.** Only the owner's channel reaches the doc/action pipeline. A contact can never extract the owner's private facts (marriage, family, location, schedule) — the persona deflects warmly instead of confirming or denying.
- **Personal‑docs assistant.** Answers questions about local files (passport, license, receipts) inside allowlisted roots, OCR'ing scanned PDFs; the OCR cache is `0600` because it holds PII.
- **Agentic Mac actions.** Creates Calendar events, Notes, and Mail via locale‑safe AppleScript — only after the owner confirms a suggested follow‑up.
- **Sounds like you.** Authentic‑voice and bot‑tell guards strip "Certainly!", em‑dashes, and reasoning leaks; a register‑aware **medium‑tone Telangana Telugu** layer keeps the dialect right. Pacing replays your real per‑contact reply latency with typing indicators and message bursts.
- **Remembers across channels.** A unified person graph, 14‑day episodic memory, and 7‑day topic index are shared between WhatsApp and iMessage.
- **Proactive & self‑improving.** Anticipation nudges (pre‑meeting, anniversaries, overdue replies, open commitments), a 👎 learning flywheel that mines rejections into durable style lessons, draft‑and‑confirm for low‑confidence replies, and quiet‑hours queueing with natural morning replay.

The owner profile (`~/.lantern/owner-profile.md`) is the single source of truth — facts, per‑contact addressing rules, dialect preferences, and timezone — hot‑reloaded every 30s, never hardcoded. Copy the template at [`docs/personal/owner-profile.example.md`](docs/personal/owner-profile.example.md) to `~/.lantern/owner-profile.md` to get started (your real profile stays out of the repo — it's gitignored). See [`docs/architecture/15-personal-workflows.md`](docs/architecture/).

---

## Architecture

Lantern is **polyglot on purpose**: Go for the control plane and workflow engine (K8s‑native, durable), Rust for the latency‑sensitive hot path (gateway, router, runtime‑manager, harness), TypeScript for the dashboard, primary SDK, and bridges. Protobuf is the single source of truth for cross‑service types.

**Load‑bearing invariants** (enforced in [`CLAUDE.md`](CLAUDE.md) and review):

1. Control plane never touches user code — only `runtime-manager` + `harness` do.
2. The workflow engine is the sole mutator of run state; services emit events.
3. All long operations are durable, idempotent, and replayable as steps.
4. Streaming is end‑to‑end (runtime → gateway → SDK → dashboard) with no buffering.
5. Untrusted code runs in a microVM — never a bare pod.
6. Models are addressed by capability, not vendor name.
7. Multi‑tenant by default — every row carries `tenant_id`; no cross‑tenant joins.
8. Every external side‑effect carries an idempotency key `(run_id, step_id, attempt)`.
9. Observability is not optional — every service emits OTel traces.
10. Secrets never appear in logs/traces — resolved at execution time via refs.

Full design docs: [`docs/architecture/`](docs/architecture/) · decisions: [`docs/adr/`](docs/adr/).

---

## Project layout

```
lantern/
  services/
    control-plane/      Go    REST + gRPC: agents, runs, budgets, evals, marketplace, MCP, voice
    workflow-engine/    Go    durable step execution, event-sourced journal + replay
    model-router/       Rust  capability-based multi-LLM routing, failover, caching
    runtime-scheduler/  Go    microVM placement engine
    runtime-manager/    Rust  Firecracker / Kata / K8s / Wasmtime orchestration
    harness/            Rust  in-microVM init: egress allowlist, JWT vending, heartbeats
    gateway/            Rust  API edge: TLS, auth, rate limiting, streaming proxy
    surface-gateway/    Rust  inbound channel webhooks
    scheduler/          Go    cron + delayed jobs
    memory/             Go    core / recall (pgvector) / archival
    notifier/           Go    webhooks, email, Slack, SMS, push
    billing/            Go    usage metering, cost attribution
    data-plane-agent/   Go    reverse-tunnel agent for customer-cloud topologies
    whatsapp-bridge/    TS    macOS WhatsApp "Jarvis" assistant
    imessage-bridge/    TS    macOS iMessage "Jarvis" assistant
  packages/
    sdk-ts/             TS    primary SDK            cli/        Go   `lantern` CLI (Cobra)
    sdk-python/         Py    Python SDK             proto/      —    protobuf contracts (lantern/v1)
    sdk-go/             Go    Go SDK                 bridge-core/ TS  shared bridge library
  apps/
    web/   Next.js dashboard      landing/  marketing site      docs/  documentation site
  examples/             runnable agents incl. examples/headless-agents/{01..04}
  infra/                docker-compose · Helm · Terraform · kind
  docs/architecture · docs/adr · docs/assets (diagrams)
```

---

## `lantern` CLI

```
lantern dev                          boot the full stack (infra + API + dashboard + bridges)
lantern init                         scaffold a new agent
lantern agents list                  list agents
lantern runs create --agent=x        dispatch a run
lantern run <agent.yaml>             schedule a headless microVM agent
lantern test --agent=x --suite=y     run an eval suite
  --against=last-green               fail CI on regression
  --set-baseline                     pin this run as the new baseline
  --rehearse                         replay past failures against the current version
lantern deploy --agent=x --env=prod  ship to managed cloud
lantern logs --run=<id> -f           tail the event stream
lantern login                        token-based auth
```

---

## Testing & CI

```bash
make test         # all suites: Go (-race), Rust, TypeScript (vitest), Python (pytest)
make lint         # golangci-lint + cargo clippy + tsc
make audit        # govulncheck + cargo audit + npm audit
make ci-local     # lint + test + audit — the same gate CI runs
```

New behavior ships with unit tests; bug fixes ship with a regression test. Run `make ci-local` before every push.

---

## Deployment model

- **Managed cloud** — one‑click deploy, billing, autoscaling. Convenience, not a paywall.
- **Customer VPC data plane** — runs in your EKS/GKE/AKS; the control plane reaches it over an outbound‑only mTLS tunnel. Prompts, tokens, and customer data stay in your account; only metadata and routing decisions cross. Terraform/Helm in [`infra/`](infra/).

You choose your LLM providers, where the data plane runs, which models answer which capability aliases, whether to use the built‑in router, and which surfaces ship.

---

## Contributing

1. Read [`CLAUDE.md`](CLAUDE.md) — repo conventions and the architectural invariants above.
2. Read the relevant [ADR](docs/adr/) if your change touches a load‑bearing decision; add one for cross‑service changes.
3. Regenerate types with `make proto` after editing a `.proto` (never hand‑edit generated code).
4. Run `make ci-local` before pushing.

---

## License

[Apache 2.0](LICENSE). No catches — every differentiator above lives in this repo.
