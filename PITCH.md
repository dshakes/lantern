# Lantern

**Lantern is the open-source runtime that takes an AI agent from your laptop to
production in your own cloud — and the same runtime powers a personal agent that
texts on your real WhatsApp/iMessage indistinguishably from you.**

One command to run locally. One to ship to your VPC. Apache-2.0.

---

## The problem

Building an agent demo is easy. Running agents in production is not. Teams hit the
same six walls:

1. **No durable runtime.** Frameworks give you a `while` loop. Real agents need
   durable, replayable steps, idempotency, retries, and run state you can trust.
2. **Unpredictable cost.** "It's probably ~$X" is not a budget. Finance wants a
   forecast and a hard cap; one runaway tool loop burns the month.
3. **No safety net for changes.** A prompt tweak silently regresses; you find out
   from users. There's no eval gate in CI.
4. **Untrusted code, bare pods.** Agents run other people's code and pull packages
   from the internet — usually in a container on a shared daemon. That's not isolation.
5. **Chat-only.** The agent lives in a vendor dashboard. Your users are on WhatsApp,
   Slack, the phone, your website.
6. **Vendor lock-in.** Your prompts, tokens, and customer data sit in someone else's
   cloud.

## The insight

The hard parts of "agent in production" are the **same primitives** whether the agent
is a headless backend worker or a personal assistant texting your family: durable
execution, capability-based model routing, budgets, isolation, verifiable provenance,
and real channels. Build that runtime once and you get both a production agent
platform and a world-class personal agent for free. Most companies build one or the
other; Lantern is the substrate for both.

## Why now

- Models are finally good enough that a personal agent can pass as *you* — if the
  surrounding system handles voice, memory, pacing, and safety. That system is the
  moat, not the model.
- Capability-addressed routing (`model: "auto"`) means you ride every model
  improvement without rewrites.
- Regulated and serious buyers will not ship agents to a vendor cloud. They need
  their VPC, audit trails, and hard cost controls. The control-plane / data-plane
  split is now table stakes.

---

## Solution — five modules, one runtime

| Module | What it is | Status |
|---|---|---|
| **1. Agent Runtime** | Go control plane + durable workflow engine + Rust multi-LLM router + microVM runtime (scheduler / manager / harness) + edge gateway. Run agents in **your** cloud; control plane never touches user code. | Core prod-ready; microVM live boot is alpha (fail-closed) |
| **2. Personal Agent ("Jarvis")** | WhatsApp + iMessage bridges that text **as you** — owner-only, learns your real voice from history, agentic macOS actions (Calendar / Notes / Mail), cross-channel memory, urgent-alerting, draft-and-confirm. | Live, in daily use |
| **3. Trust and Governance** | Policy-as-code budgets (hard-fail 402), eval-in-CI + rehearsals, HMAC-verifiable run receipts, guardrails, multi-tenant RLS, AES-256-GCM secrets, fail-closed prod posture. | Prod-ready |
| **4. Channels and Reach** | WhatsApp · iMessage · Slack · Telegram · Discord · Voice (Twilio/LiveKit) · Webchat · Email — signature-verified inbound, naturally paced replies. | Prod-ready |
| **5. Developer Experience** | TS/Python/Go SDKs, `lantern` CLI, one-command local dev, visual workflow editor that *executes*, MCP server registry, A2A agent cards, forkable agent marketplace with signed cross-tenant settlement. | Prod-ready |

## Who needs it (ICP)

- **Startups** shipping AI-native products who need real infrastructure without a
  six-month platform build — they want to clone it, configure their LLM keys, and
  ship in a day.
- **Enterprises with compliance requirements** who cannot route customer data through
  a SaaS vendor — they need the data plane in their own VPC with cryptographic audit
  trails.
- **Founders and operators** who want a personal assistant that actually sounds like
  them, on their own phone number, without a third-party holding the keys.

## Market framing

The agent-infrastructure category is being created right now. Every organization that
ships an LLM feature eventually needs durable execution, cost controls, and eval
tooling. The alternatives are: build it yourself (expensive), use a narrow framework
that stops at the demo layer (no isolation, no eval, no channels), or give a vendor
your data. Lantern is the Apache-2.0 option — full-featured, self-hosted, no paywall.

## Moat / insight

The natural-communication layer (voice-from-history, pacing, dialect, privacy guards,
claim verifier, bot-tell guards) is the part nobody else has and the part that takes
the most real-world iteration. The platform is the substrate; the personal agent
is the wedge that makes it real every day. Every improvement to the platform improves
the personal agent, and vice versa.

## How a run works — durable, budgeted, isolated, verifiable

![Agent run lifecycle](docs/assets/run-lifecycle.svg)

1. `POST /v1/runs/forecast` — tokens, cost, confidence; HTTP 402 if budget exceeded.
2. Budget gate — hard-fail if the policy says no.
3. Durable step execution — the workflow engine journals every step; idempotent replay on retry.
4. Capability routing — model router maps `"auto"` / `"reasoning-large"` / … to the right provider.
5. MicroVM isolation — untrusted code goes to Firecracker / K8s; never a bare pod.
6. Signed receipt — HMAC-SHA256 over the journal; verifiable by anyone at `/proof`.

---

## Proof it is real

- **Polyglot monorepo building:** Go control plane, Rust hot path (gateway / router /
  runtime / harness), TS dashboard + SDK + bridges, Python SDK — all building.
- **Tested:** ~290 Rust unit tests across the 5 services, 565 bridge-core tests,
  control-plane + SDK suites, machine-validated bridge behaviors (urgent-alert,
  location-privacy, voice) — green in CI.
- **Hardened:** two security audits remediated (auth, tenant isolation, webhook
  verification, XSS, secrets, fail-closed-in-prod); dependency CVEs patched.
- **Honest:** the exact items still needing a Linux/KVM host to validate (real
  Firecracker boot, live mTLS handshake, secret-vending transport) are enumerated in
  `SECURITY.md` and ship **fail-closed** — nothing pretends to work.

## Status and ask

**Public alpha.** Modules 2–5 are in real use. Module 1's microVM live-boot is the
last integration mile (Linux/KVM host), implemented and fail-closed today.

We are looking for **design partners** who want to run agents in their own cloud with
real cost, eval, and audit controls — and early users for the personal agent.
Apache-2.0; self-host everything. The managed cloud is convenience, not a paywall.

*Run it: `git clone https://github.com/dshakes/lantern && make dev`*
*See [README](README.md) and [SECURITY.md](SECURITY.md).*
