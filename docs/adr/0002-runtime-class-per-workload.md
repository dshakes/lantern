# ADR 0002 — Runtime isolation class is declared per workload, not chosen by the platform

- **Status:** Accepted
- **Date:** 2026-05-12
- **Deciders:** Lantern runtime team
- **Tags:** runtime, isolation, scheduling

## Context

Lantern supports several physical execution backends — K8s Job, Firecracker, Kata Containers, Wasmtime, and long-lived devcontainer pods. The six classes are catalogued in [`docs/architecture/04-runtime-isolation.md`](../architecture/04-runtime-isolation.md). Each has very different cost, cold-start, and security characteristics:

- Firecracker is the right default for tenant code: ~150ms warm restore, hardware-level isolation, packs hundreds per node.
- Kata is heavier (~300ms warm) but more compatible — needed for workloads that touch unusual kernel surfaces.
- K8s Job is the cheapest cold start path for first-party code we wrote and signed ourselves.
- Wasmtime is microseconds, but the WASI surface is tiny — useful only for pure-function tools.
- devcontainer is for the "agent owns a workspace for three days" pattern.

The question: who picks which backend for a given run?

Three reasonable answers:

1. **Platform infers it from the agent code** (always sandbox the worst case).
2. **Platform picks per workload based on threat-model heuristics** (analyze the bundle).
3. **The agent author declares an `IsolationClass` and the platform honors it** (with a safe default).

## Decision

Every agent declares an isolation class in its spec. The proto field is `AgentSpec.isolation` (`runtime.proto:93`); the SDK surface is `agent.yaml`'s `isolation.class`. The scheduler picks the backend purely from the class — no inference, no override at schedule time.

Defaults:
- If unset, default is `ISOLATION_STANDARD` (Firecracker). Never `TRUSTED`.
- Marketplace-installed agents and LLM-generated code are forced to `ISOLATION_UNTRUSTED` regardless of what the author declared.
- `ISOLATION_TRUSTED` is allowed only for first-party agents signed by Lantern's signing key.

The mapping class → backend lives in the scheduler:

```
TRUSTED       → K8s Job
STANDARD      → Firecracker (default pool)
UNTRUSTED     → Firecracker (hardened pool + egress allowlist + seccomp deny-default)
HOSTILE       → Kata, dedicated node pool, no co-tenancy
WASM          → Wasmtime in-process on trusted hosts
DEVCONTAINER  → long-lived K8s pod + PVC
```

## Consequences

### Positive

1. **Author intent is explicit.** A code review can see "this agent runs as HOSTILE" without reading the bundle. Audit, billing, and incident response all hinge on the declared class.
2. **The scheduler stays simple.** No bundle inspection, no heuristics, no surprise upgrades. The class → backend map is a literal table.
3. **The platform can refuse degradation.** An agent declaring `HOSTILE` cannot accidentally land on a K8s Job because a node pool is full — the scheduler will queue it rather than weaken isolation.
4. **Per-class capacity planning is tractable.** Each backend pool has its own SLO and its own warm-pool PID controller. Mixing classes on one pool was the failure mode we avoided.

### Negative

1. **Authors can over-isolate.** Someone marks every agent `HOSTILE` "to be safe" and burns the Kata pool. Mitigation: dashboard surfaces a "you probably want STANDARD" warning; per-tenant Kata quota.
2. **Authors can under-isolate first-party-feeling code.** Mitigation: `TRUSTED` requires a signing key; the platform forces `UNTRUSTED` for marketplace + LLM-generated bundles.
3. **Class changes require a new agent version.** This is good for auditability and bad for emergency hardening; the platform retains an admin-only override for incident response.

## Alternatives considered

### Always Firecracker
Tempting — it's the right default. But:
- `HOSTILE` workloads need Kata's broader compatibility (Firecracker has a narrow device set; some malware-analysis sandboxes won't run).
- `WASM` is dramatically cheaper for pure-function tools (microseconds vs ~150ms). Forcing them into Firecracker is leaving an order of magnitude on the table.
- First-party Lantern steps don't need microVM isolation; K8s Job is cheaper and faster to debug.

### Always Kata
Heavier than Firecracker for the same isolation. E2B and AWS Lambda both run Firecracker in production for the same reason ([E2B](https://e2b.dev/), [Firecracker boot times](https://dev.to/adwitiya/how-i-built-sandboxes-that-boot-in-28ms-using-firecracker-snapshots-i0k)). We chose Firecracker as default for cold-start; Kata is the escape hatch.

### K8s-only (no microVMs)
Untrusted code in a shared kernel is a hard pass. The 2024-2025 industry consensus (E2B, Modal, fly.io, Vercel sandboxes) is that microVMs are table stakes for an agent platform. See [State of MicroVM Isolation 2026](https://emirb.github.io/blog/microvm-2026/).

### Platform infers class from the bundle
Brittle and dangerous. A static analyzer that misses one syscall is a security incident; an explicit author declaration is auditable.

## References

- [`docs/architecture/04-runtime-isolation.md`](../architecture/04-runtime-isolation.md) — the class table
- [`docs/architecture/04b-microvm-productionization.md`](../architecture/04b-microvm-productionization.md) — how the scheduler uses this
- [`packages/proto/lantern/v1/runtime.proto`](../../packages/proto/lantern/v1/runtime.proto) — `IsolationClass`
