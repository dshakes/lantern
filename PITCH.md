# Lantern — pitch

> **Lantern is the runtime that takes an AI agent from your laptop to production
> in your own cloud — and the same runtime powers a personal agent that texts on
> your real WhatsApp/iMessage indistinguishably from you.** One command to run
> locally, one to ship to your VPC. Apache‑2.0.

---

## The problem

Building an agent demo is easy. Running an agent **in production** is not. Teams
hit the same wall:

- **No durable runtime.** Frameworks give you a `while` loop. Real agents need
  durable, replayable steps, idempotency, retries, and run state you can trust.
- **Unpredictable cost.** "It's probably ~$X" is not a budget. Finance wants a
  forecast and a hard cap; one runaway tool loop burns the month.
- **No safety net for changes.** A prompt tweak silently regresses; you find out
  from users. There's no eval gate in CI.
- **Untrusted code, bare pods.** Agents run other people's code and pull packages
  from the internet — usually in a container on a shared daemon. That's not
  isolation.
- **Chat‑only.** The agent lives in a vendor dashboard. Your users are on
  WhatsApp, Slack, the phone, your website.
- **Vendor lock‑in.** Your prompts, tokens, and customer data sit in someone
  else's cloud.

## The insight

The hard parts of "agent in production" are the **same** primitives whether the
agent is a headless backend worker **or** a personal assistant texting your
family: durable execution, capability‑based model routing, budgets, isolation,
verifiable provenance, and real channels. Build that runtime once, and you get
both a **production agent platform** and a **world‑class personal agent** for
free. Most companies build one or the other; Lantern is the substrate for both.

## Why now

- Models are finally good enough that a personal agent can pass as *you* — if the
  surrounding system handles voice, memory, pacing, and safety. That system is
  the moat, not the model.
- Capability‑addressed routing (`model: "auto"`) means you ride every model
  improvement without rewrites.
- Regulated/serious buyers won't ship agents to a vendor cloud — they need
  *their VPC*, audit trails, and hard cost controls. The control‑plane /
  data‑plane split is now table stakes.

---

## What Lantern is — five modules, one runtime

![Lantern's five modules over one shared runtime](docs/assets/modules.svg)

| Module | What it is | Status |
|---|---|---|
| **1. Agent Runtime** | Control plane (Go) + durable workflow engine + capability‑based multi‑LLM router (Rust) + microVM runtime (scheduler/manager/harness) + edge gateway. Run agents in **your** cloud; control plane never touches user code. | Core prod‑ready; microVM live boot is alpha (fail‑closed) |
| **2. Personal Agent ("Jarvis")** | WhatsApp + iMessage bridges that text **as you** — owner‑only, learns your real voice from history, medium‑tone Telangana/Telugu, agentic macOS actions (Calendar/Notes/Mail), cross‑channel memory, urgent‑alerting, draft‑and‑confirm. | Live, in daily use |
| **3. Trust & Governance** | Policy‑as‑code budgets (hard‑fail 402), eval‑in‑CI + rehearsals, HMAC‑verifiable run receipts, guardrails, multi‑tenant RLS, AES‑256‑GCM secrets, fail‑closed prod posture. | Prod‑ready |
| **4. Channels & Reach** | WhatsApp · iMessage · Slack · Telegram · Discord · Voice (Twilio/LiveKit) · Webchat · Email — signature‑verified inbound, natural paced replies. | Prod‑ready |
| **5. Developer Experience** | TS/Python/Go SDKs, `lantern` CLI, one‑command local dev, visual workflow editor that *executes*, MCP server registry, A2A agent cards, forkable agent marketplace with signed cross‑tenant settlement. | Prod‑ready |

## The wedge (how we're different)

- **Clone‑to‑production.** `make dev` (Docker‑only) or `lantern dev` (hot‑reload) → the whole stack; `deploy` → your VPC. One repo, no feature gates.
- **A cost forecast before every run** + hard‑fail budgets (HTTP 402). Finance‑grade.
- **Eval‑in‑CI + rehearsals** — regressions fail the build (HTTP 422); replay real production failures against a candidate before flipping traffic.
- **Cryptographically verifiable receipts** — share a run's signed JSON; anyone verifies what executed at `/proof`.
- **microVM isolation by design** — untrusted code routes to Firecracker/Kata or **hard‑fails**; it never silently downgrades to a bare container.
- **A personal agent that passes as you** — the natural‑communication layer (voice‑from‑history, pacing, dialect, privacy guards) is the part nobody else has.
- **Your cloud, your keys.** Data‑plane in your EKS/GKE/AKS; only metadata crosses an outbound‑only mTLS tunnel.

## How a run works — durable, budgeted, isolated, verifiable

![Agent run lifecycle](docs/assets/run-lifecycle.svg)

## Proof it's real (not slideware)

- Polyglot monorepo: Go control plane, Rust hot path (gateway/router/runtime/harness), TS dashboard + SDK + bridges, Python SDK — all building.
- **Tested:** ~290 Rust unit tests across the 5 services, 565 bridge‑core tests, control‑plane + SDK suites, machine‑validated bridge behaviors (urgent‑alert, location‑privacy, voice) — green in CI.
- **Hardened:** two security audits remediated (auth, tenant isolation, webhook verification, XSS, secrets, fail‑closed‑in‑prod); dependency CVEs patched.
- **Honest:** the exact items still needing a Linux/KVM host to validate (real Firecracker boot, live mTLS handshake, secret‑vending transport) are enumerated in `SECURITY.md` and ship **fail‑closed** — nothing pretends to work.

## Status & ask

**Public alpha.** Modules 2–5 are in real use; Module 1's microVM live‑boot is the
last integration mile (Linux/KVM host), implemented and fail‑closed today.

We're looking for **design partners** who want to run agents in their own cloud
with real cost/eval/audit controls — and early users for the personal agent.
Apache‑2.0; self‑host everything. The managed cloud is convenience, not a paywall.

*Run it: `git clone … && make dev`. See [README](README.md) and [SECURITY.md](SECURITY.md).*
