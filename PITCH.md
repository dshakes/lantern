# PAL Runtime

**PAL Runtime is an open-source runtime for AI agents that you host in your own cloud.
The agent loop runs on your control plane. The code the agent writes runs in a
microVM. Every step is journaled, every agent has a budget, and every completed run
can be signed.**

The same runtime drives a personal agent that answers on its owner's WhatsApp and
iMessage, in their voice, and holds anything risky for them to approve.

Apache-2.0. `make dev` runs it on a laptop.

---

## The problem

An agent demo takes an afternoon. Running agents in production hits the same six walls:

1. **Runs aren't durable.** A framework gives you a `while` loop. When the process
   dies mid-run, the run restarts from zero and repeats its side effects.
2. **Cost has no ceiling.** One runaway tool loop can spend the month's budget before
   anyone looks.
3. **Changes ship blind.** A prompt tweak regresses quietly and users find it first.
4. **Untrusted code runs in a container.** Agents execute code they wrote or
   downloaded, usually on a shared kernel next to the keys that call the model.
5. **Agents live in a dashboard.** Users are on WhatsApp, Slack, the phone and the
   website.
6. **The data leaves.** Prompts, tokens and customer data sit in a vendor's cloud.

## The insight

Production agents and personal agents need the same primitives: durable steps,
capability-routed models, budgets, isolation, provenance and real channels. Build the
runtime once and both fall out of it. Every fix the personal agent forces on the
runtime, and every guarantee the runtime adds, improves the other side.

## Why now

- Agents now write and run code as a matter of course. That code needs its own
  kernel, and the loop that holds the keys must not share it. Google's Agent Compute
  Engine announcement (October 22, 2026) puts a microVM per agent and credentials
  outside it at the center of its pitch. PAL Runtime runs that shape today, self-hosted.
- Addressing models by capability (`model: "auto"`) lets an agent pick up a better
  model without a code change.
- Regulated buyers will not send agent traffic through a vendor cloud. They need the
  data plane in their VPC, audit trails and hard cost limits.

---

## What ships

| Module | What it is | Status |
|---|---|---|
| **Agent runtime** | Go control plane and durable workflow engine, Rust model router, microVM runtime (scheduler, manager, in-VM harness). The control plane never touches user code. | Core in use. Firecracker lifecycle (boot, exec, snapshot, restore, fork) passes end to end on real KVM in a jailed Lima nested-virt guest; bare-metal numbers pending. |
| **Egress broker** | VM with no network device; egress crosses vsock to a host broker that enforces the allowlist and injects credentials. | Opt-in (`PAL_EGRESS_MODE=broker`), Firecracker only. Default mode routes egress through an in-guest proxy; enforcement needs the image's iptables REDIRECT rule. |
| **Trust and governance** | Budgets that return HTTP 402, eval gates that return HTTP 422 in CI, rehearsals of past failures, signed run receipts (Ed25519 when a signing seed is configured, HMAC-SHA256 otherwise), row-level security on every tenant table, AES-256-GCM credentials at rest. | In use. RLS and per-scope authZ enforcement are flag-gated per environment. |
| **Personal agent** | WhatsApp and iMessage bridges that reply as the owner, learn their voice from their own sent messages, take Calendar / Notes / Mail actions on confirmation, and hold money promises and unverifiable claims for approval. | In daily use by the founder. |
| **Channels** | WhatsApp, iMessage, Slack, Telegram, Discord, voice (Twilio, LiveKit), embeddable webchat. | In use. |
| **Developer experience** | TypeScript, Python and Go SDKs, the `lantern` CLI (`doctor`, `onboard`, `test`, `vm`), a visual workflow editor whose graphs execute (tool nodes not yet wired), MCP registry, A2A agent cards, agent marketplace. | In use. |

## Who it's for

- **Startups shipping AI-native products** that need durable runs, budgets and
  isolation without a six-month platform build.
- **Companies with compliance requirements** that need the data plane in their own
  VPC and a signed record of what each run did.
- **Founders and operators** who want an assistant on their own number that sounds
  like them, with no third party holding the keys.

## Market

Every team that ships an LLM feature ends up needing durable execution, cost
controls and eval gates. Today the options are to build it, to use a framework that
stops at the demo, or to hand a vendor the data. PAL Runtime is the self-hosted,
Apache-2.0 option, with no paywalled tier.

## Moat

The communication layer of the personal agent: voice learned from the owner's own
messages, pacing taken from their real reply times, dialect rules, a commitment gate
that holds money promises, a grounding gate that holds claims the bot can't verify,
and a verifier that rewrites "I sent it" to "I'll send it" unless it did. Each of
these came from a real failure in live use. The platform is the substrate; the
personal agent is the daily stress test.

## How a run works

![Agent run lifecycle](docs/assets/diagrams/run-lifecycle.svg)

1. **Forecast.** `POST /v1/runs/forecast` estimates tokens and cost and says whether
   the run would exceed its budget.
2. **Budget gate.** A hard-fail budget returns HTTP 402 before any model is called.
3. **Durable steps.** Every step is journaled. After a crash the recovery sweep
   re-drives the run and completed steps return their cached output instead of
   running again.
4. **Capability routing.** `"auto"` or `"reasoning-large"` maps to a concrete provider
   model.
5. **Isolation.** Untrusted code runs in a Firecracker or Kata microVM, never a bare
   pod.
6. **Receipt.** `POST /v1/runs/{id}/receipt` signs the hash of the run's journal: Ed25519 when
   `PAL_RECEIPT_ED25519_SEED` is set (HMAC-SHA256 dev fallback otherwise). Anyone can
   check an Ed25519 receipt at `/proof` against the published key.

---

## Proof

- **Real KVM.** The Firecracker integration test boots, snapshots, restores and forks
  a jailed VM; it passes on a Lima nested-KVM host and runs in CI where the runner
  exposes KVM (best-effort on hosted runners). Three forks shared one memory inode (copy-on-write) and each
  spawned in 131–160 ms ([Lima nested-virt, indicative](docs/benchmarks/runtime-latency.md)).
- **Tested.** Go (`-race`), Rust, TypeScript and Python suites, plus DB-backed
  row-level-security tests that connect as the restricted role. `make ci-local` runs
  the CI matrix.
- **Fail-closed in production.** A missing service token or a stub scheduler stops
  the service from starting. A missing isolation runtime refuses the run instead of
  downgrading it.
- **Honest about gaps.** What still needs a bare-metal host to validate is listed in
  [`SECURITY.md`](SECURITY.md).

## Status and ask

**Public alpha.** The control plane, budgets, evals, receipts, channels and personal
agent are in real use. The microVM runtime is proven on nested KVM; bare-metal
validation is next.

We want **design partners** who need agents in their own cloud with real cost, eval
and audit controls, and early users for the personal agent.

*Run it: `git clone https://github.com/dshakes/pal && cd pal && make dev`.
See the [README](README.md) and [SECURITY.md](SECURITY.md).*
