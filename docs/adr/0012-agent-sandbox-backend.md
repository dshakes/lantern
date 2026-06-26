# ADR 0012 — Back the runtime on the `kubernetes-sigs/agent-sandbox` CRD instead of hand-rolled pod orchestration

- **Status:** Proposed
- **Date:** 2026-06-23
- **Deciders:** Lantern runtime team
- **Tags:** runtime, isolation, scheduling, kubernetes, snapshots, warm-pool
- **Builds on:** [ADR 0009](0009-kubernetes-default-runtime-substrate.md) (K8s is the substrate; isolation is a RuntimeClass tier)
- **Related:** [04b-microvm-productionization](../architecture/04b-microvm-productionization.md), [19-agent-sandbox-backend-spike](../architecture/19-agent-sandbox-backend-spike.md), [18-agent-runtime-nextgen](../architecture/18-agent-runtime-nextgen.md)

## Context

ADR 0009 made Kubernetes the default substrate and expressed isolation as a
`runtimeClassName` tier (`runc` → `gvisor` → `kata`). The K8s backend
(`services/runtime-manager/src/backends/k8s.rs`) currently hand-builds a
`batch/v1` `Job`, sets `runtimeClassName` from the `IsolationClass`
(`isolation_to_runtime_class`, `k8s.rs:250`), attaches a default-deny
NetworkPolicy, and the scheduler (`services/runtime-scheduler/`, Go) owns
placement, warm-pool accounting, leader election, and a cluster store.

Two things have happened since ADR 0009:

1. **`kubernetes-sigs/agent-sandbox` shipped and is becoming the standard.**
   It is a **SIG Apps subproject** (launched KubeCon Atlanta, Nov 2025;
   Google/GKE-driven). It defines a `Sandbox` CRD (`agents.x-k8s.io`,
   `v1beta1`) — "isolated, stateful, singleton workloads, ideal for AI agent
   runtimes" — plus extension CRDs `SandboxTemplate`, `SandboxClaim`, and
   `SandboxWarmPool` (`extensions.agents.x-k8s.io`). A single controller
   reconciles the pod, PVCs (`volumeClaimTemplates`), a headless Service
   (stable per-sandbox DNS via `status.serviceFQDN`), and the warm pool. It is
   runtime-agnostic — isolation is whatever `runtimeClassName` the
   `podTemplate` carries (gVisor or Kata), exactly the ADR 0009 model.

2. **The capabilities agent-sandbox ships are the ones Lantern's runtime has
   stubbed or designed-but-not-wired.** Concretely:
   - `K8sBackend::snapshot` and `::restore` **return errors today**
     (`k8s.rs:793–801`). agent-sandbox provides **gVisor checkpoint
     suspend/resume** — `operatingMode: Suspended` freezes filesystem **and
     memory** state; `Running` restores it, with **scale-to-zero +
     wake-on-traffic**. This is the single highest-value agent-runtime feature
     (idle agents cost \$0, resume in <1s with full state) and we do not have
     it.
   - Warm pools: agent-sandbox's `SandboxWarmPool` is declarative
     (`spec.replicas`, auto-replenish, sub-second adopt). Lantern reimplements
     this as a per-`(class,digest)` LIFO pool plus a custom PID controller and
     scheduler scoring term.
   - Stable per-sandbox network identity + the **Sandbox Router** (proxy keyed
     on `X-Sandbox-ID`) — Lantern has no equivalent external addressing
     primitive.

The question this ADR settles: **for the K8s substrate, do we keep hand-rolling
pod/Job orchestration + a bespoke scheduler, or do we reconcile the
agent-sandbox CRDs and inherit suspend/resume, warm pools, snapshots, and stable
DNS from the standard?**

This is *not* a question about the layers Lantern is uniquely good at — the
short-TTL secret relay (ADRs 0005/0008), the in-guest egress proxy (ADR 0006),
per-tenant namespaces + RLS + budgets, and the harness contract. Those stay and
become the value-add *on top of* the substrate. This ADR is only about the
pod-lifecycle plumbing underneath `RuntimeBackend`.

## Options considered

### Option A — Adopt agent-sandbox as a first-class backend (**proposed**)

Add a `SandboxBackend` implementing the existing `RuntimeBackend` trait
(`services/runtime-manager/src/backend.rs:55`). It reconciles `Sandbox` /
`SandboxClaim` / `SandboxWarmPool` custom resources instead of constructing a
raw `Job`. Wired in via one new `config::RuntimeBackend::Sandbox` enum arm and
one `match` branch in `main.rs:64`. The grounded mapping and a skeleton
implementation are in
[19-agent-sandbox-backend-spike](../architecture/19-agent-sandbox-backend-spike.md).

- `schedule` → create a `SandboxClaim` referencing a per-`(tenant, version,
  class)` `SandboxTemplate`; the controller adopts a warm pod or cold-starts.
- `snapshot` / pause → patch `spec.operatingMode: Suspended` (the
  feature we currently return an error for).
- `restore` / resume → `operatingMode: Running` (auto-restores latest
  snapshot).
- `satisfies_isolation` → unchanged: gated on the template's
  `runtimeClassName` being `gvisor` (UNTRUSTED) / `kata` (HOSTILE), preserving
  the ADR 0009 fail-closed invariant.
- Warm pool: a `SandboxWarmPool` per `(template, class)` replaces
  `pool.rs` for the K8s substrate.

Lantern's scheduler is **retained as an admission + scoring layer**, not
deleted: it still stamps `tenant_id`, enforces quota/budget (HTTP 402), and may
compute placement *hints* (region, fair-share), but it emits a `SandboxClaim`
and lets the controller place, rather than dialing a per-node manager.

**Net effect:** deletes the most-stubbed, hardest-to-finish code (custom
snapshot store wiring on K8s, per-node warm-pool PID controller, bespoke
cluster store / leader election for the K8s path) and replaces it with a
maintained, standardizing controller — while keeping every Lantern
differentiator as the wrapper.

### Option B — Map the CRD onto the existing proto, keep both backends

Keep `runtime.proto` and the manager as the contract; make `IsolationClass`
translate to `runtimeClassName` and `Snapshot`/pause translate to
`operatingMode: Suspended`, but run agent-sandbox *alongside* the Job backend,
selected per-cluster. Lower commitment; lets us A/B the controller against
`K8sBackend` and migrate workloads gradually. Costs: two code paths to maintain,
the snapshot/warm-pool win is only realized where the Sandbox backend is
selected, and the proto still implies a per-node manager that the CRD path
doesn't use.

### Option C — Stay fully bespoke

Finish the hand-rolled scheduler + manager snapshot/warm-pool path; do not adopt
the CRD. Justified **only** if Firecracker-direct snapshots, the 6-class
taxonomy, or non-K8s substrates are differentiators we will market on. Given
that the K8s snapshot/restore path is currently a stub and the data plane is
already K8s in the customer VPC (ADR 0009), this is the most expensive path and
the least defensible — we would be rebuilding, and then maintaining against, a
standard the ecosystem is consolidating on.

## Decision

**Adopt Option A**, staged behind the existing `RuntimeBackend` trait, with
Option B's coexistence as the *migration mechanism* (the Job backend stays until
the Sandbox backend passes the same integration matrix). Concretely:

1. Add `SandboxBackend` (`backends/sandbox.rs`) implementing `RuntimeBackend`,
   reconciling the agent-sandbox CRDs. Default backend stays `k8s` (Job) until
   parity is proven; opt in per data-plane via
   `LANTERN_RUNTIME_BACKEND=sandbox`.
2. Keep the Lantern scheduler as the admission/quota/scoring layer; have it emit
   `SandboxClaim`s (with placement expressed as template selection +
   `additionalPodMetadata` affinity) rather than dialing per-node managers for
   the Sandbox path.
3. Map the proto faithfully (see the spike doc). The harness, secret relay, and
   egress proxy are **unchanged** — they live in the pod's `podTemplate` and on
   the node, exactly as with the Job backend.

This is sequencing + an additive backend; the load-bearing code lands behind a
security-auditor sign-off and the **same integration matrix ADR 0009 already
requires** (untrusted→gVisor, hostile→Kata, fail-closed on a node lacking the
RuntimeClass, default-deny egress) **plus** two new gates: suspend/resume
round-trips with state intact, and warm-pool adopt under quota.

### The ADR 0009 invariant is preserved

`UNTRUSTED`/`HOSTILE` still receive gVisor/Kata isolation — now carried by the
`SandboxTemplate.podTemplate`'s `runtimeClassName` instead of a Job's. The
fail-closed check moves from "manager refuses to build the Job" to "backend
refuses to create the `SandboxClaim` unless the referenced template advertises
the hardened RuntimeClass," and the scheduler's node-capability filter is
unchanged. Same guarantee, expressed in CRD terms.

## Consequences

### Positive
1. **Suspend/resume + snapshots for free.** Our biggest functional gap
   (`k8s.rs:793–801` stubs) becomes an inherited feature — including
   scale-to-zero with PVC preservation and wake-on-traffic.
2. **Less bespoke code to own.** Declarative `SandboxWarmPool` replaces the
   per-node PID controller; the controller owns pod/PVC/Service/owner-ref
   cascades. The Lantern scheduler shrinks to admission + scoring.
3. **GitOps + `kubectl` story.** Sandboxes become inspectable CRs with printer
   columns and owner refs — operationally legible in the customer's own
   cluster, matching the ADR 0009 deployment model.
4. **Standard gravity.** We ride GKE Pod-snapshot density work, Helm packaging,
   and SIG tooling instead of reimplementing them; the runtime story becomes
   "Lantern adds tenancy, secrets, egress, and cost governance on top of the
   K8s-standard sandbox primitive."

### Negative
1. **New dependency on a young CRD.** agent-sandbox is early-beta: extension
   CRDs straddle `v1alpha1`/`v1beta1`, snapshots are gVisor-leaning, and there
   is an open warm-pool DoS gap (unbounded `SandboxWarmPool.spec.replicas`,
   upstream #251). *Mitigation:* our scheduler caps replicas per tenant before
   emitting the pool; we pin a release and run the conversion webhook.
2. **Some placement signals don't map natively.** Warm-pool locality,
   snapshot locality, and fair-share scoring become template selection +
   affinity hints rather than first-class scheduler decisions. *Mitigation:*
   keep the scoring layer; express its output as `additionalPodMetadata` /
   nodeAffinity on the claim. Accept reduced fidelity where it doesn't pay.
3. **Two backends during migration.** Until parity, Job and Sandbox paths
   coexist (Option B's cost). *Mitigation:* time-boxed; the Job backend is
   deleted once the Sandbox backend passes the matrix.
4. **Controller is another component in the data-plane install.** *Mitigation:*
   the data-plane Helm/Kustomize already provisions RuntimeClasses (ADR 0009);
   the agent-sandbox controller + CRDs land in the same chart.

### Neutral
- Firecracker / Kata-fc node pools are unaffected (same as ADR 0009): the
  Sandbox backend targets the gVisor/Kata RuntimeClass tiers; the dedicated
  microVM pool keeps the Firecracker backend.
- ADRs 0004–0008 (harness baked in, short-JWT secret vending, egress allowlist,
  snapshot retention, secret relay) are **unchanged** — they apply inside the
  sandbox pod exactly as inside the Job pod.

## Follow-ups
- Spike + parity matrix: [19-agent-sandbox-backend-spike](../architecture/19-agent-sandbox-backend-spike.md).
- Before committing: exercise the *current* runtime end-to-end against a live
  cluster (`examples/headless-agents/MANUAL-TEST.md`) to confirm the real
  vs. stubbed baseline this ADR assumes — the docs run ahead of the code in
  places (the scheduler is Go, not the Rust the 04b doc implies; the
  control-plane defaults to a *stub* scheduler client).
