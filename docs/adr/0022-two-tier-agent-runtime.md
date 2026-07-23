# ADR 0022 — Two-tier agent runtime: shared inline executor + isolated microVM tier, routed by manifest

- **Status:** Accepted
- **Date:** 2026-07-23
- **Deciders:** Lantern control-plane, runtime-scheduler, runtime-manager
- **Tags:** runtime, isolation, routing, durability, staged-rollout

## Context

Lantern has two agent runtimes today, and only one of them carries traffic:

1. **The inline executor** (`services/control-plane/internal/handlers/rest.go`,
   `executeRunInlineSync`) — a goroutine inside the control-plane process. It
   drives the workflow interpreter and the plain-LLM tool-use loop, and it owns
   the durability story that actually works in production: `journal_events`
   event sourcing, `run_locks` leases, the 30s recovery sweep, completed-step
   replay caches, and `(run_id, step_id, attempt)` idempotency keys end-to-end
   (including `Idempotency-Key` on LLM provider calls). Every live run — loop
   agents, bridge-triggered runs, dashboard runs — executes here.

2. **The W12 headless microVM stack** — control-plane `/v1/runtime/schedule` →
   runtime-scheduler (`:50055`, placement) → runtime-manager (`:50054`,
   Firecracker / Kata / K8s Job / Wasmtime / devcontainer) → in-VM Rust harness
   (egress allowlist, secrets vending, audit streaming). Architecturally this is
   the invariant-#5 answer ("untrusted code runs in a microVM"), with real
   security engineering behind it (ADRs 0002–0008, P2-B7). But nothing routes
   agent runs to it. It is exercised only by explicit `/v1/runtime/*` calls,
   the CLI, and the examples.

The failure mode of this split is not theoretical. The runtime-manager sat
crash-looping on the primary dev machine (no Docker socket after a reboot) for
days without anything noticing, because no production path depends on it. A
runtime that carries no traffic rots: its bugs are invisible, its ops story is
untested, and every week it diverges further from the executor that does carry
traffic. Meanwhile the workflow-engine (`:50052`) is a third, dormant
implementation of durable step execution whose `llm_call`/`tool_call` dispatch
is wired but unreachable from any run path.

The alternative — migrating all runs into microVMs — is wrong for the opposite
reason: a per-run VM is expensive (boot latency, memory, warm-pool pressure)
and buys nothing for trusted first-party workloads. The loop agents and bridge
replies are latency-sensitive, run trusted code we wrote, and only ever touch
the DB and the LLM providers. Invariant #5 requires a microVM for **untrusted**
code, not for everything.

## Decision

**One runtime, two tiers, routed per agent by manifest.**

1. The agent manifest gains an `isolation` field:
   - `"shared"` (default, and the value assumed when absent) — the run executes
     on the inline executor exactly as today. Trusted, first-party, low-latency.
   - `"microvm"` — the run executes on the W12 stack: the run executor
     schedules an AgentSpec via the runtime-scheduler and the workload runs in
     the VM under the harness. Required for agents that execute user-supplied
     code, `exec` arbitrary tools, or load untrusted packages (invariant #5).
2. **Routing happens at run creation** in the control-plane run executor. It is
   a property of the agent version (manifest), not of the caller — a caller
   cannot downgrade an agent that declares `microvm` to the shared tier.
3. **Honest failure, never silent downgrade.** If the microVM tier is
   unavailable (scheduler unreachable, quota exceeded, manager down), a
   `microvm` run FAILS with a typed error surfaced on the run. It must never
   fall back to the shared tier — the isolation declaration is a security
   boundary, and a fallback would be a silent boundary violation. (This mirrors
   the prod startup guards: stubs are a dev convenience, not a fallback.)
4. **The journal stays the single durability substrate for both tiers.**
   MicroVM runs emit the same `journal_events` (`step_started`/`step_completed`/
   `step_failed`) through the harness→manager→control-plane report path, so
   run detail, receipts, replay, and recovery are tier-agnostic. No second
   event store.
5. **The workflow-engine is not a tier.** It remains dormant; a follow-up ADR
   decides absorb-or-delete. This ADR only forbids adding new run paths to it.

## Consequences

- The microVM stack sees real traffic as soon as one agent declares
  `isolation: "microvm"` — its health becomes production health, watched by the
  same service-health sweep that alerts the owner.
- The in-guest tool runner becomes load-bearing (it is the microVM tier's step
  executor); its completion is a prerequisite for routing workflow-graph agents
  there, so tier rollout is staged: exec-style headless agents first, graph
  agents after the tool runner lands.
- `isolation` is validated at agent-version publish time (unknown values
  rejected), so typos fail at deploy, not at run time.
- Cost: microVM runs pay boot + placement latency. That is the explicit price
  of the declaration; the manifest author chooses.

## Rollout

1. Manifest field + routing + honest-failure path land behind no flag (the
   default `shared` is a no-op for every existing agent).
2. First microVM-routed agent: one of the `examples/headless-agents/*` specs,
   run on a schedule so the tier has a heartbeat of real traffic.
3. The service-health sweep (same change batch) alerts the owner's self-chat
   when scheduler/manager go unreachable — the crash-loop-unnoticed failure
   mode is closed independent of traffic volume.
4. Graph-agent routing to the microVM tier is gated on the in-guest tool
   runner shipping (tracked separately).
