<div align="center">

# 🏮 Lantern

**The agent platform you run on your laptop and ship to production with one command.**

Real channels · multi-LLM routing · durable workflows · predictable cost · eval-in-CI · cryptographically verifiable receipts — in your own cloud.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.23+-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev)
[![Rust](https://img.shields.io/badge/Rust-2024-CE412B?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-000000?style=flat-square&logo=next.js&logoColor=white)](https://nextjs.org)

```bash
make dev        # zero-toolchain: full stack in Docker
# — or —
lantern dev     # hot-reload daily driver: infra + API + dashboard + bridges
```

</div>

---

## The pitch

**An agent demo takes an afternoon. Agents in *production* take a year.** Durable execution so a crash doesn't lose state or double-spend tokens. A cost forecast finance will actually sign — with a hard cap that blocks the runaway tool loop *before* it bills. An eval gate in CI so a prompt tweak can't silently regress in front of users. Real isolation for untrusted code — a microVM, not a container on a shared daemon. And the channels your users actually live on, not another vendor dashboard.

**Lantern is the runtime that solves the production half — and runs entirely in _your_ cloud.** Your prompts, tokens, and customer data never leave your VPC. One command runs the whole stack on your laptop; one ships it to your own Kubernetes.

The bet: those primitives are identical whether the agent is a headless backend worker or a personal assistant **texting your family on your real number**. Build the runtime once — durable steps, capability-routed models (`model: "auto"`), hard budgets, microVM isolation, cryptographically verifiable receipts, real channels — and you get both. The system around the model is the moat, not the model.

> Read the full thesis — problem, insight, why-now, the five modules — in [`PITCH.md`](PITCH.md).

---

## What is Lantern?

Lantern is a **production runtime for AI agents** with a control-plane / data-plane split: Go/Rust orchestration layer manages agents, runs, budgets, evals, and routing — while your prompts and customer data stay in your own VPC. 100% Apache-2.0. No feature gates.

<p align="center">
  <img src="docs/assets/lantern-architecture.svg" alt="Lantern architecture — control plane, data plane, surfaces, and data stores" width="100%">
</p>

---

## Why Lantern?

| Most agent frameworks | Lantern |
|---|---|
| `npm install` + a tutorial | **One command** boots Postgres + Redis + MinIO + control-plane + dashboard + bridges, with hot reload |
| Chat-only, inside their dashboard | **Real channels** — WhatsApp, iMessage, Slack, Telegram, Discord, voice (Twilio/LiveKit), embeddable webchat |
| "Your agent probably costs about…" | **Cost forecast before every run** — `POST /v1/runs/forecast` returns tokens, dollars, and confidence; hard-fail budgets block overspend with HTTP 402 |
| "Monitor your evals in prod" | **Eval-in-CI + rehearsals** — pin a baseline per branch, fail the build on regression (HTTP 422), replay real failures against a candidate before flipping traffic |
| A visual builder that only *saves* a graph | **A workflow engine that *executes* the graph** through the same router + connector + budget pipeline |
| "Trust us about what happened" | **Cryptographically verifiable receipts** — Ed25519-signed over the run's journal; verify offline at `/.well-known/lantern-receipts` / `/proof` |
| "Deploy to *our* cloud" | **Deploy in *your* cloud** — data plane in your VPC, Kubernetes-default substrate, outbound-only mTLS tunnel |

---

## How it works

<p align="center">
  <img src="docs/assets/run-lifecycle.svg" alt="Agent run lifecycle — budget gate, durable steps, capability routing, microVM isolation, signed receipt, eval-in-CI loop" width="100%">
</p>

Every run passes through the same path — budget gate → durable step execution → capability-based LLM routing → isolated execution → signed receipt. Doesn't matter if it started as a WhatsApp message or a backend job.

<img src="docs/assets/cp-dp-architecture.svg" alt="Control-plane / data-plane architecture — Auth → Budget → Identity → Scheduler dispatch in the SaaS control plane; runtime-scheduler → runtime-manager → in-VM harness in the data plane; gRPC tenant metadata flows down, mTLS heartbeat and audit events flow back up to the receipt signer" width="100%">

---

## Five modules, one runtime

<p align="center">
  <img src="docs/assets/modules.svg" alt="Lantern's five modules over one shared runtime" width="100%">
</p>

| Module | What it gives you | Maturity |
|---|---|---|
| **1 · Agent Runtime** | Durable workflow engine, capability-based multi-LLM router, Kubernetes-default substrate with isolation as a RuntimeClass tier (runc → gVisor → Kata microVM → Firecracker-backed Kata). Fail-closed: untrusted/hostile refused unless the hardened RuntimeClass is configured — never silently downgraded to a bare pod. Durable crash-replay (exactly-once, no re-spent tokens). One trace per spawn (W3C across CP → scheduler → manager → harness). Ed25519 per-instance identity + scheduler HA + per-tenant spawn rate limiting. | Phases 0–4 landed; Phase 5/6 (frontier UX, confidential compute) on roadmap |
| **2 · Personal Agent ("Jarvis")** | WhatsApp + iMessage assistant that texts *as you* — owner-only, learns your real voice from history, agentic macOS actions, cross-channel memory, urgent-alerting, privacy guards. | Live |
| **3 · Trust & Governance** | Policy-as-code budgets (hard-fail 402), eval-in-CI + rehearsals, Ed25519-signed verifiable receipts, per-agent-instance identity tokens, RBAC scopes on runtime routes, gRPC service-token auth, OTel traces (tenant_id/run_id/step_id), LLM idempotency keys on all provider calls, AES-256-GCM secrets. RLS policies on all 34 tenant tables — enforcement staged via `LANTERN_RLS_ENFORCE` (handler cutover in progress). | Substantially complete; RLS enforcement pending cutover |
| **4 · Channels & Reach** | WhatsApp · iMessage · Slack · Telegram · Discord · Voice (Twilio/LiveKit) · Webchat · Email — signature-verified, naturally paced. | Prod-ready |
| **5 · Developer Experience** | TS/Python/Go SDKs, `lantern` CLI, one-command dev, visual workflow editor that *executes*, MCP registry, A2A cards, forkable agent marketplace. Python SDK: management surface at parity; runtime `AgentContext` still stubbed. | Prod-ready (TS); Python management parity done, runtime context pending |

> **Status (as of 2026-06-23):** modules 2–5 are in real use. Module 1 is substantially complete:
> - ✅ **K8s-default substrate + RuntimeClass tiering** — `STANDARD` runs on gVisor, `HOSTILE` on Kata, fail-closed double gate in `choose_backend` + `build_job` (never downgrades to a bare pod). Node-affinity, per-workload default-deny NetworkPolicy, PSA-restricted, cosign image verification, and the boot-time RuntimeClass preflight are all landed (#36).
> - ✅ **Durable crash-replay** — journal-backed exactly-once execution: no re-spent tokens on crash, side-effect dedup via `side_effect_receipts`, run lease + recovery watchdog (#38).
> - ✅ **One-trace-per-spawn observability** — W3C `traceparent` propagates CP → scheduler → manager → harness; GenAI semconv spans carry reasoning and cache tokens; real-time loop/retry anomaly events mid-run; `GET /v1/runtime/metrics` for the cockpit Live mode (#39).
> - ✅ **Ed25519 per-instance identity** — minted at spawn, presented as Bearer on `VendSecret`, externally verifiable at `/.well-known/lantern-agent-identity`; flag-gated RLS `lantern_app` role (#40).
> - ✅ **Cluster-e2e execution legs** — gVisor leg validates `runsc` in CI; Kata legs (guest kernel ≠ host kernel, dedicated-pool no-co-tenancy) ship wired + documented and skip without an operator-provided kubeconfig (GitHub-hosted runners cannot nest-virtualize — not faked) (#41).
> - ⚠️ **Still open:** live Kata execution and RLS flag-flip need operator-run cluster validation; Phase 5/6 (flight-recorder UX, confidential compute) remain on the roadmap. Nothing pretends to be done that isn't.

---

## Agent runtime — the execution kernel

The runtime is the load-bearing core: a vendor-operated, multi-tenant, **durable** agent runtime that executes inside *your* VPC, with a tamper-evident, externally-verifiable, data-plane audit substrate. Kubernetes is the default substrate ([ADR&#160;0009](docs/adr/0009-kubernetes-default-runtime-substrate.md)); isolation is a RuntimeClass tier on a pod, not a separate backend.

<p align="center">
  <img src="docs/assets/runtime-architecture.svg" alt="Agent Execution Kernel — control-plane (identity, secret relay, report ingestion, receipts, OTel) → HA scheduler → per-node manager (K8s-default, fail-closed isolation gate, hardened pods) → in-VM harness (mTLS, egress deny-default, cert-bound report), over a durable journal + Ed25519 receipt spine" width="100%">
</p>

Every spawn produces **one correlated chain** — `schedule → place → spawn → identity → vend → egress → report → terminate` — where each link shares `(tenant_id · run_id · step_id · agent_instance_id · trace_id)` and is replayable and externally verifiable.

<p align="center">
  <img src="docs/assets/runtime-lifecycle.svg" alt="Runtime lifecycle sequence — schedule with quota gate, mint per-instance identity, 5-factor placement, hardened K8s Job, mTLS heartbeat, VendSecret with Bearer, deny-default egress, cert-bound report ingestion, journal append, terminate with grace window, Ed25519 receipt" width="100%">
</p>

Isolation is **fail-closed**: untrusted/hostile workloads are refused unless the hardened RuntimeClass is present — double-gated in `choose_backend()` and again in `build_job()`, never downgraded to a bare pod.

<p align="center">
  <img src="docs/assets/runtime-isolation-tiers.svg" alt="Isolation matrix — TRUSTED→runc, STANDARD/UNTRUSTED→gVisor, HOSTILE→Kata microVM (no co-tenancy), WASM, DEVCONTAINER; the fail-closed double gate; per-pod securityContext hardening; and opt-in cluster-side Kyverno baseline, cosign image verification, Cilium egress, and External Secrets Operator" width="100%">
</p>

Defense-in-depth across governance, security, scalability, resiliency, and observability — with the trust boundaries made explicit (the harness, caller env, and `X-Forwarded-For` are all treated as untrusted input).

<p align="center">
  <img src="docs/assets/runtime-security-layers.svg" alt="Runtime defense-in-depth — concentric isolation rings, the five non-negotiables, explicit trust boundaries, the three review layers that each caught real bugs, and the standards (OWASP Agentic Top-10, EU AI Act, IETF Agent Audit Trail, OTel GenAI semconv) the architecture is built against" width="100%">
</p>

Full strategy, gap analysis vs. AgentCore / Vertex / Anthropic / OpenAI / Temporal, and the phased roadmap: [`docs/architecture/18-agent-runtime-nextgen.md`](docs/architecture/18-agent-runtime-nextgen.md).

---

## Headless agent runtime in 60 seconds

Write an `agent.yaml`, pick an isolation class, run it:

```yaml
# my-agent.yaml
apiVersion: lantern.dev/v1
kind: AgentSpec
metadata:
  name: hello
spec:
  image_digest: lantern/demos/hello@sha256:0000...0001
  isolation: standard          # gVisor; the default for most agents
  limits:
    vcpu: "250m"
    memory: "128Mi"
    timeout: 60s
  secrets:
    - env_name: OPENAI_API_KEY
      secret_uri: lantern.secret://tenant/my-tenant/key/openai
  egress_rules:
    - host: api.openai.com     # harness denies everything else
  idempotent: true
```

```bash
lantern run my-agent.yaml --input '{"task": "summarize the news"}'
# → vm_id: vm_01abc...
lantern logs --vm vm_01abc -f
# → [harness] booted in 340ms  [workload] summarizing…  [workload] done
```

The run is **journaled and crash-replayable**: if the process dies mid-step,
the recovery watchdog restarts it and the journal returns cached step results —
no re-spent tokens, no double API calls. When it finishes:

```bash
curl -X POST http://localhost:8080/v1/runs/<run_id>/receipt \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"
# → Ed25519-signed receipt, verifiable offline at /.well-known/lantern-receipts
```

Full walkthrough: [`docs/guides/headless-agent-quickstart.md`](docs/guides/headless-agent-quickstart.md).
Four end-to-end demo agents: [`examples/headless-agents/`](examples/headless-agents/).

---

## Documentation map

| Resource | Where |
|---|---|
| **User guides** (quickstart, isolation, durable execution, observability, identity, receipts) | [`docs/guides/`](docs/guides/) |
| **Architecture docs** (all 18 components + ADRs) | [`docs/architecture/`](docs/architecture/) · [`docs/adr/`](docs/adr/) |
| **Runtime strategy + gap analysis** | [`docs/architecture/18-agent-runtime-nextgen.md`](docs/architecture/18-agent-runtime-nextgen.md) |
| **Operator runbooks** (control-plane, data-plane, DB, gateway, scheduler, budget, restore) | [`docs/runbooks/`](docs/runbooks/) |
| **Prometheus alerts + Grafana dashboards** | [`infra/monitoring/`](infra/monitoring/) |
| **Demo agents** | [`examples/headless-agents/`](examples/headless-agents/) |
| **Manual runtime test walkthrough** | [`examples/headless-agents/MANUAL-TEST.md`](examples/headless-agents/MANUAL-TEST.md) |
| **Docs site** (full reference, served at `:3002` in dev) | `apps/docs/` · `make dashboard-dev` |
| **Personal assistant setup** | [`docs/personal/BOT-SETUP.md`](docs/personal/BOT-SETUP.md) |
| **Repo conventions + invariants** | [`CLAUDE.md`](CLAUDE.md) |

---

## Quick start

```bash
git clone https://github.com/dshakes/lantern.git
cd lantern
make dev          # builds + starts the full stack
```

Open **http://localhost:3001** · log in with **`admin@lantern.dev` / `lantern`** · run `make seed` for sample data.

Verify the stack is ready before doing anything else:

```bash
( cd packages/cli && go install ./cmd/lantern )
lantern doctor    # checks health, auth, LLM provider, and a live run
```

> The macOS WhatsApp/iMessage bridges need macOS Contacts/Calendar/chat.db — they are not part of the Linux `make dev` stack. Run them on a Mac with `lantern dev` or `make run-whatsapp-bridge` / `make run-imessage-bridge`. First time? `make bridge-setup` is an interactive wizard.

<details>
<summary>Option B — hot-reload daily driver (<code>lantern dev</code>)</summary>

Needs Go + Node installed (see [Prerequisites](#prerequisites) below).

```bash
( cd packages/cli && go install ./cmd/lantern )   # build the `lantern` binary
lantern dev
```

`lantern dev` installs npm deps on first run and will:
- Start **Postgres + Redis + MinIO** via Docker (detached)
- Run the **control-plane** API (`:8080` REST, `:50051` gRPC) as a host Go process with hot reload
- Run the **Next.js dashboard** (`:3001`) with HMR
- Run the **WhatsApp** (`:3100`) and **iMessage** (`:3200`, macOS only) bridges
- Tail every process with per-service color tags, then open `http://localhost:3001`

```bash
lantern dev --infra-only          # just Postgres + Redis + MinIO
lantern dev --no-open             # don't auto-open the browser
lantern dev --with-whatsapp=false # skip the WhatsApp bridge
lantern dev --dashboard-port 4000
lantern dev down [--volumes]      # stop everything (optionally wipe data)
lantern dev logs <service> -f     # tail a single container
```

</details>

<details>
<summary>Option C — à la carte (power users)</summary>

```bash
make dev-infra             # terminal 1: Postgres + Redis + MinIO
make run-api               # terminal 2: control-plane on :8080
make dashboard-dev         # terminal 3: dashboard on :3001
make run-whatsapp-bridge   # terminal 4 (optional): WhatsApp bridge on :3100
```

> `make run-api-free` routes LLM calls through your local `claude` CLI (Claude Max subscription) — run the full platform at **$0** in development.

</details>

<a id="prerequisites"></a>
<details>
<summary>Prerequisites</summary>

`make dev` needs **only Docker**. Host-process development needs:

| Tool | Version | Needed for | Install (macOS) |
|---|---|---|---|
| **Docker** + Compose v2 | recent | everything (infra always runs in containers) | `brew install --cask docker` |
| **Go** | **1.23+** (CLI needs **1.25+**) | control-plane, engine, scheduler, SDK-go, CLI | `brew install go` |
| **Node.js** | **20 LTS+** | dashboard, landing, docs, SDK-ts, bridges | `brew install node` |
| **Rust** | **1.85+** (edition 2024) | gateway, model-router, runtime-manager, harness | `brew install rustup-init && rustup-init` |
| **make** | any | task runner | preinstalled / Xcode CLT |
| **protoc** + `ts-proto` | recent | only `make proto` (regenerating types) | `brew install protobuf` |

On Linux: `apt install golang nodejs npm docker.io protobuf-compiler`, `rustup` from rustup.rs.

**Dev credentials** (seeded, local only — never use in production):

| Service | Value |
|---|---|
| PostgreSQL | `postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable` |
| Redis | `redis://localhost:6379` |
| MinIO | `lantern` / `lanternsecret` at `localhost:9000` (console `:9001`) |
| Dashboard login | `admin@lantern.dev` / `lantern` |
| Dev tenant / user | `00000000-…-0001` (slug `dev`) / `00000000-…-0002` (role `owner`) |

For optional integrations (Google OAuth, real LLM keys, connector OAuth), copy `.env.example` → `.env.local` (gitignored) and fill in what you need.

</details>

---

## 60-second SDK example

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

SDKs: **TypeScript** (primary), **Python**, **Go**.

---

## Feature highlights

**Routing & models**
- 4 strategies: `balanced` / `cheap` / `best` / `fast` over capability aliases (`auto`, `reasoning-large`, `code-large`, …)
- Provider-agnostic with failover and prompt/semantic caching — bring your own Anthropic/OpenAI keys
- Models addressed by capability, never by vendor name

**Agents, runs & sessions**
- Immutable agent versions · event-sourced run journal with replay
- Interactive multi-turn sessions with SSE streaming · distributed run locking · cron scheduling

**Cost & safety rails**
- Pre-run cost forecaster (`/v1/runs/forecast`) returns tokens, dollars, confidence
- Policy-as-code budgets: per-day / per-run / per-tool, hard-fail HTTP 402

**Quality & confidence**
- Declarative eval suites with per-branch baselines and CI gating (HTTP 422 on regression)
- Rehearsals replay past production failures against a candidate version before traffic flips
- A/B experiments with deterministic FNV-1a splitting and auto-promotion on >2% lift
- RLHF run feedback (score 1-5, mines into style lessons)

**Workflows & humans**
- Visual editor whose saved graph actually executes (`trigger / ai-step / tool / connector / condition / loop / approval / subagent / end`)
- Human-takeover handshake (`takeover_requests` + WebRTC SDP)

**Integrations**
- **17 real connector APIs**: Gmail, Google Calendar/Drive/Sheets, Slack, Discord, Telegram, Twilio, GitHub, Linear, Jira, Sentry, Vercel, Notion, HubSpot, Salesforce, Stripe — real OAuth
- **MCP** server registry + per-agent attachments · **A2A** agent cards (`/.well-known/agent.json`)

**Marketplace**
- Publish / fork / star public agents · cross-tenant invocation with settlement receipts

**Trust**
- Ed25519-signed verifiable receipts over the journal SHA-256, verifiable offline at `/.well-known/lantern-receipts`
- Per-agent-instance Ed25519 identity minted at spawn, presented as Bearer on `VendSecret`, externally verifiable at `/.well-known/lantern-agent-identity`; stamped on every audit row
- RBAC scopes on all runtime routes (`runtime:read/write/admin`, 403 + audit on denial)
- Non-owner Postgres role (`lantern_app`) with RLS proven to deny cross-tenant reads; flag-gated (`LANTERN_RLS_ENFORCE`) for staged rollout
- AES-256-GCM credential encryption at rest · idempotency keys on every external side-effect
- OTel traces carrying `tenant_id` / `run_id` / `step_id` / `agent_instance_id` · W3C `traceparent` propagated CP → scheduler → manager → harness (one trace per spawn); gateway and model-router now emit their own OTLP spans (gateway: OTLP/HTTP `:4318`; model-router: OTLP/gRPC `:4317`) tagged with `tenant_id` and, on the model-router, `run_id` / `step_id` / `model_used` / `cost_usd` — env-gated via `OTEL_EXPORTER_OTLP_ENDPOINT` or `LANTERN_OTEL_ENABLED=1`, no-op when unset
- Production alert rules (13 rules, 3 groups), 2 Grafana dashboards, and 8 operator runbooks in [`infra/monitoring/`](infra/monitoring/) and [`docs/runbooks/`](docs/runbooks/)

<img src="docs/assets/security-sequence.svg" alt="Security sequence — JWT caller schedules via RBAC; control plane runs quota+budget gate and mints a per-instance identity; spawns the data-plane agent; harness vends secrets over mTLS; audit events stream back; caller receives an Ed25519-signed receipt verifiable offline at /proof" width="100%">

**Headless agent runtime** · Kubernetes-default substrate; isolation as a RuntimeClass tier; durable crash-replay; one trace per spawn:

<img src="docs/assets/runtime-dispatch.svg" alt="Runtime dispatch — TRUSTED maps to runc, STANDARD to gVisor, UNTRUSTED to gVisor+egress-deny, HOSTILE to Kata microVM dedicated pool; if gVisor or Kata is not configured the request is refused fail-closed, never downgraded to runc" width="100%">

In-VM Rust harness enforces an egress allowlist, vends short-TTL secrets over mTLS, and streams a bidirectional heartbeat. Per-tenant quota (HTTP 402 over cap). Scheduler HA via Postgres advisory-lock leader election. Per-tenant spawn rate limiting (token bucket, 429 before work side-effects). Demos in [`examples/headless-agents/`](examples/headless-agents/). User guides in [`docs/guides/`](docs/guides/).

<details>
<summary>Run the headless runtime locally</summary>

```bash
make dev-infra            # terminal 1: Postgres + Redis + MinIO
make run-runtime-manager  # terminal 2: runtime-manager on :50054 (Docker backend)
make run-scheduler        # terminal 3: scheduler on :50055 / :8085
make run-api-runtime      # terminal 4: control-plane wired to the scheduler on :8080
lantern run examples/headless-agents/01-hello/agent.yaml --input '{"name":"world"}'
```

Prefer containers? `docker compose -f infra/docker/docker-compose.yml --profile runtime up --build`

To run **real Firecracker on Apple Silicon** (M3+/macOS 15+), [`infra/lima/`](infra/lima/) provisions a Lima guest with nested-virt KVM — a microVM boots to login in ~1.6 s (verified on an M4 Max).

</details>

---

## The personal assistant ("Jarvis")

Two macOS bridges — **WhatsApp** and **iMessage** — turn an LLM into a personal assistant that texts *as you*, on your own number.

<p align="center">
  <img src="docs/assets/jarvis-pipeline.svg" alt="Jarvis reply pipeline — safety, context, persona, LLM, authenticity guards, confidence routing" width="100%">
</p>

- **Owner-only & private.** A contact can never extract the owner's private facts — the persona deflects warmly instead of confirming or denying.
- **Answers your files.** Finds passport, license, receipts inside allowlisted roots, OCR'ing scanned PDFs; OCR cache is `0600` because it holds PII.
- **Mac actions.** Creates Calendar events, Notes, and Mail via locale-safe AppleScript — only after the owner confirms.
- **Sounds like you.** Bot-tell guards strip "Certainly!", em-dashes, and reasoning leaks. Pacing replays your real per-contact reply latency with typing indicators.
- **Remembers across channels.** Unified person graph, 14-day episodic memory, and 7-day topic index shared between WhatsApp and iMessage.
- **Self-improving.** 👎 learning flywheel mines rejections into durable style lessons; anticipation nudges fire for pre-meeting, anniversaries, overdue replies, and open commitments.

Owner profile at `~/.lantern/owner-profile.md` — facts, per-contact rules, dialect, timezone — hot-reloaded every 30s. Copy the template at [`docs/personal/owner-profile.example.md`](docs/personal/owner-profile.example.md) (your real profile is gitignored). See [`docs/architecture/15-personal-workflows.md`](docs/architecture/).

### Your agents

The personal suite is a set of **owner-facing** loop agents — they nudge or brief you in your self-chat and never touch your contacts — plus two **assistant** agents that reply to contacts as you. This distinction matters: owner-facing agents can be aggressive and proactive; assistant agents carry trust. Highlights below; the full roster (scheduled, bridge, and reactive tiers) and how each loops lives in `apps/docs` → `/personal`.

| Agent | What it does | Reactive / Proactive | Reaches you via | Touches your contacts? |
|---|---|---|---|---|
| **concierge** | Captures tasks (from you or from what people message you), researches how to handle them, and nudges you with one-tap actions — reply / snooze / done — until handled. | Both | self-chat nudges | No — private to-do layer |
| **relationship-keeper** | Each week finds people you've gone quiet on (21+ days) and nudges you to reach out, with a draft in your voice if you want it. | Proactive (weekly) | self-chat | No — you do the outreach |
| **financial-sentinel** | Watches bills and subscriptions. Flags price hikes and recurring charges, and drafts a review or cancel for your one-tap OK. Never moves money. | Proactive (daily) | self-chat | No |
| **inbox-triage** | Polls Gmail every ~45 min, classifies each new message (action / FYI / noise), and for action items drafts a ready-to-send reply you confirm with one tap. | Proactive (meso) | self-chat + one-tap send | No — you confirm every send |
| **ai-radar** | Every ~5 min scans Anthropic / OpenAI / DeepMind / HuggingFace / Simon Willison / GitHub releases / HackerNews / Reddit / podcasts, dedupes, and surfaces genuinely new AI developments. Pull anytime with `news` (e.g. `news openai`, `news week`). | Proactive (micro, ~5m) | self-chat (`news`) | No |
| **whatsapp-assistant** | Auto-replies to your WhatsApp contacts in your voice. | Reactive (on inbound) | replies to contacts | **Yes** — talks to contacts as you |
| **imessage-assistant** | Auto-replies to your iMessage contacts in your voice. | Reactive (on inbound) | replies to contacts | **Yes** — talks to contacts as you |

The loop agents (concierge, relationship-keeper, financial-sentinel) run on the Lantern platform as scheduled agents — created via `POST /v1/agents/loop` and visible on the dashboard with runs and cost like any other agent. Bridge nudges require `LANTERN_CONCIERGE=on` (off by default). financial-sentinel acts on `life_events` bills already classified by the bridges.

#### The five loop tiers — same engine, five clock speeds

Every loop agent is created at one of five **tiers**. The tier is the only knob that sets cadence; the durable engine, budget cap, and signed receipt are identical across all of them. `POST /v1/agents/loop` takes `"tier": "nano|micro|meso|macro|mega"` and stamps the matching cron (nano is event-driven — no schedule row). See `loop_agent.go`.

<img src="docs/assets/loop-tiers.svg" alt="The five loop tiers: nano (event-driven, no cron — bridge fires on a signal; commute-copilot, energy-guardian, health-coach, focus-guardian), micro (every 5 min, */5 * * * *; ai-radar), meso (every 45 min, */45 * * * *; inbox-triage), macro (daily 8am, 0 8 * * *; chief-of-staff, financial-sentinel, domain-tracker), mega (weekly Mon 9am, 0 9 * * 1; relationship-keeper). Top turns fastest, bottom slowest." width="100%">

#### Owner-facing loops — nudge you in self-chat, never touch your contacts

<img src="docs/assets/agent-loops-owner.svg" alt="Owner-facing agent loops — concierge (Capture→Research→Nudge→You act), relationship-keeper (Scan people→Gone quiet?→Draft→Nudge you→You reach out), financial-sentinel (Scan bills→Price hike?→Flag review→You decide), inbox-triage (Read Gmail→Classify msg→Queue draft→You confirm), ai-radar (Scan AI feeds→Dedupe→Rank new→Surface); each loop returns to its first step" width="100%">

#### Contact-facing loops — reply AS YOU to real contacts ⚠

<img src="docs/assets/agent-loops-contact.svg" alt="Contact-facing agent loops — whatsapp-assistant and imessage-assistant both follow the same reactive loop: Contact messages → Understand → Draft in your voice → Send to contact → repeat; these agents reply as you to real contacts" width="100%">

### The harness, layer by layer

<p align="center">
  <img src="docs/assets/personal-harness-architecture.svg" alt="Personal harness layered architecture — Surfaces ingress, then five layers (Sense, Remember, Reason, Sound-like-you, Act), a Safety and Privacy rail alongside, and the control-plane substrate underneath" width="100%">
</p>

**The harness** is the whole stack behind the bot: your **surfaces** (iMessage, WhatsApp, Voice, Email, Webchat) feed five layers that **sense** what's happening, **remember** you and your people, **reason** about what to do, make the reply **sound like you**, and **act** — grounded throughout by the control plane and guarded by a privacy rail that runs alongside every layer.

**Cross-app memory** is the load-bearing middle. A **person graph** resolves any `(channel, handle)` to one canonical identity, so a fact learned on WhatsApp is there when the same person emails or calls. On top sit a 14-day **episodic memory** (`date · topic · outcome`), a 7-day **topic index** for cross-thread recall, your **owner profile** (facts · relationships · style lessons), live **presence**, and a **life-events ledger** (bills · deliveries · travel · fraud). The substrate is split: local `0600` JSONL on the Mac for the most personal signals, plus control-plane Postgres (RLS, encrypted at rest) for the tenant-scoped graph and timeline.

**Leveraged in every layer.** That memory isn't a sidecar — **sense** writes signals into it, **remember** is it, **reason** decides against it, **sound-like-you** draws voice and relationship rules from it, and **act** records outcomes back into it. The result is one assistant that knows you across every channel and follows through. Full interactive walkthrough at the docs site **[`/personal`](docs/personal/)**.

### Phone-trigger context — your iPhone, your bot

iPhone automations (CarPlay/Bluetooth driving, geofences, Focus, the Action Button, NFC) fire signed Shortcuts that POST one tiny signal over a **private Tailscale** network. The control plane appends it to an owner-only `0600` file; the bridge reads it **on-demand on every owner turn** (zero lag) and folds it into context — grounding *your* self-chat and the availability concierge, while **never** sharing your location with a contact.

<p align="center">
  <img src="docs/assets/personal-harness-flow.svg" alt="Personal harness phone-trigger flow — iPhone automations POST signals over Tailscale to the control plane; the bridge reads them on-demand, grounding owner self-chat and the availability concierge; location is never shared with contacts" width="100%">
</p>

One command generates the whole shortcut set: `scripts/iphone/app-context/generate-signals.sh`. Recipes + trigger table in [`scripts/iphone/app-context/RICH-SIGNALS.md`](scripts/iphone/app-context/RICH-SIGNALS.md); remote-access setup in [`docs/personal/REMOTE-ACCESS.md`](docs/personal/REMOTE-ACCESS.md). The interactive version lives on the docs site at **`/personal`**.

---

## Architecture invariants

These are enforced in [`CLAUDE.md`](CLAUDE.md) and code review. Violating them silently causes incidents.

1. Control plane never touches user code — only `runtime-manager` + `harness` do.
2. The workflow engine is the sole mutator of run state; services emit events.
3. All long operations are durable, idempotent, and replayable as steps.
4. Streaming is end-to-end (runtime → gateway → SDK → dashboard) with no buffering.
5. Untrusted code runs in a hardened RuntimeClass (gVisor or Kata microVM) — never a bare pod.
6. Models are addressed by capability, not vendor name.
7. Multi-tenant by default — every row carries `tenant_id`; no cross-tenant joins.
8. Every external side-effect carries an idempotency key `(run_id, step_id, attempt)`.
9. Observability is not optional — every service emits OTel traces.
10. Secrets never appear in logs/traces — resolved at execution time via refs.

Full design docs: [`docs/architecture/`](docs/architecture/) · decisions: [`docs/adr/`](docs/adr/).

---

## Deployment model

- **Managed cloud** — one-click deploy, billing, autoscaling. Convenience, not a paywall.
- **Customer VPC** — data plane in your EKS/GKE/AKS. The data-plane agent dials **out** to the control plane at `:50051` (no inbound ports in your VPC). It exchanges a one-time bootstrap token for a session JWT (`typ=dataplane-session`, 1 h TTL), then holds a persistent `RunStream` gRPC connection. The control plane pushes run assignments down the stream; the agent reports status and completion back up. When no data plane is connected, runs execute inline in the control plane (managed-cloud model). Prompts, tokens, and customer data stay in your account. Terraform/Helm in [`infra/`](infra/).

You choose your LLM providers, where the data plane runs, which models answer which capability aliases, and which surfaces ship.

**DB migrations:** the control plane applies schema changes at startup via golang-migrate ([ADR 0010](docs/adr/0010-versioned-db-migrations.md)). Migration `0001` (the current full schema, `IF NOT EXISTS`) is the baseline — it creates a fresh schema or silently adopts an existing one by recording version 1 in the `schema_migrations` ledger. No manual step, no downtime.

---

<details>
<summary>Service & port reference</summary>

| Service | Lang | Port(s) | Role |
|---|---|---|---|
| **control-plane** | Go | `:8080` (REST/SSE) · `:50051` (gRPC) | system of record: agents, runs, sessions, budgets, evals, marketplace, MCP |
| **workflow-engine** | Go | `:50052` (gRPC) | durable, event-sourced step execution — the only mutator of run state |
| **model-router** | Rust | `:50053` (gRPC) | capability-based multi-LLM routing, failover, caching |
| **runtime-scheduler** | Go | `:50055` (gRPC) · `:8085` (REST) | microVM placement (warm-pool / region / fair-share / cost / health) |
| **runtime-manager** | Rust | `:50054` (gRPC) | spawns isolated workloads (Docker / Firecracker / Kata / K8s / Wasmtime) |
| **harness** | Rust | in-VM | PID 1 inside every microVM: egress allowlist, JWT vending, heartbeats |
| **gateway** | Rust | `:8443` (HTTPS) | TLS, auth, rate limit, end-to-end token streaming |
| **surface-gateway** | Rust | `:8444` (HTTP) | inbound channel webhooks (Slack/WhatsApp/Telegram/Twilio/Discord) |
| **scheduler / memory / notifier / billing** | Go | internal | cron · vector memory · notifications · usage metering |
| **whatsapp-bridge** | TS | `:3100` | macOS WhatsApp "Jarvis" assistant |
| **imessage-bridge** | TS | `:3200` | macOS iMessage "Jarvis" assistant |
| dashboard / landing / docs | TS | `:3001` / `:3000` / `:3002` | Next.js apps |
| Postgres · Redis · MinIO | — | `:5432` · `:6379` · `:9000`/`:9001` | data stores |

</details>

<details>
<summary>Project layout</summary>

```
lantern/
  services/
    control-plane/      Go    REST + gRPC: agents, runs, budgets, evals, marketplace, MCP, voice
    workflow-engine/    Go    durable step execution, event-sourced journal + replay
    model-router/       Rust  capability-based multi-LLM routing, failover, caching
    runtime-scheduler/  Go    microVM placement engine
    runtime-manager/    Rust  Docker / Firecracker / Kata / K8s / Wasmtime orchestration
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
  e2e/                  live-stack end-to-end suites (runtime control path) — `make test-e2e`
  infra/                docker-compose · Helm · Terraform · kind · k8s (isolation validation) · lima (Firecracker on Apple Silicon)
  docs/architecture · docs/adr · docs/assets (diagrams)
```

</details>

<details>
<summary><code>lantern</code> CLI reference</summary>

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

</details>

<details>
<summary>Testing & CI</summary>

```bash
make test         # all suites: Go (-race), Rust, TypeScript (vitest), Python (pytest)
make test-db      # Go tests that need a live Postgres (starts dev Postgres if needed)
make test-e2e     # live-stack e2e suites against the real API on :8080 — skips green when the stack is down
make k8s-validate # K8s Job isolation harness: throwaway kind cluster + Calico, proves default-deny egress / seccomp / cap-drop / PSA live
make lint         # golangci-lint + cargo clippy + tsc
make audit        # govulncheck + cargo audit + npm audit
make ci-local     # lint + test + audit — the same gate CI runs
```

**What is green today (as of GA-phase3):**
- Control-plane Go suite — 9+ packages including 24 DB-backed handler tests (auth / sessions cross-tenant isolation / connectors encrypted-credential round-trip)
- `TestRLSEnforcement_AllTenantTables` — catalog gate ensures every tenant table has `ENABLE` + `FORCE` + `USING`/`WITH CHECK` policy; adding a new tenant table without RLS fails CI
- gRPC auth interceptor — 7/7 `grpcauth_test.go`
- bridge-core — 613 tests (node:test + tsx) in `make test-ts`
- runtime-scheduler — full Go suite
- Python SDK — 66 pytest (CI only; pytest not installed on dev host)
- Vuln gate — `govulncheck` + `cargo-audit` + `npm audit` on every PR

**What is still aspirational** (designed, not yet run in CI): Testcontainers integration tests, k6 E2E API suite, Playwright web E2E, fuzz harnesses, chaos testing. These appear in `docs/architecture/11-testing.md` as design intent.

New behavior ships with unit tests; bug fixes ship with a regression test. Run `make ci-local` before every push.

</details>

<details>
<summary>Troubleshooting</summary>

**Port already in use** — every `make run-*` target calls `scripts/kill-port.sh` first, so a stale process is usually cleared. If it isn't:

```bash
bash scripts/kill-port.sh 8080 50051 50054 50055
```

**`make dev-infra` fails** — Docker isn't running. Start Docker Desktop and retry.

**`make run-api` fails with a Postgres auth error** — don't call `go run ./cmd/server` directly; it defaults to your OS user for Postgres auth. `make run-api` sets `DATABASE_URL`, `REDIS_URL`, and `S3_ENDPOINT` correctly.

**WhatsApp / iMessage bridges don't start** — macOS-only (they need `chat.db` and Contacts access). Not part of the Linux `make dev` stack. Run on a Mac with `make run-whatsapp-bridge` / `make run-imessage-bridge`. The iMessage bridge additionally needs Full Disk Access granted to the Node binary in System Settings → Privacy → Full Disk Access.

**microVM live-boot fails** — Firecracker requires Linux + `/dev/kvm`. On macOS the runtime-manager refuses Hostile/Untrusted workloads with `FAILED_PRECONDITION` (fail-closed by design). Use `RUNTIME_BACKEND=docker` (the default) for local dev; for real Firecracker on Apple Silicon (M3+/macOS 15+) use [`infra/lima/`](infra/lima/).

</details>

---

## Contributing

1. Read [`CLAUDE.md`](CLAUDE.md) — repo conventions and the architectural invariants.
2. Read the relevant [ADR](docs/adr/) before touching a load-bearing decision; add one for cross-service changes.
3. Run `make proto` after editing a `.proto` — never hand-edit generated code.
4. Run `make ci-local` before pushing.

---

## License

[Apache 2.0](LICENSE). No catches — every differentiator above lives in this repo.
