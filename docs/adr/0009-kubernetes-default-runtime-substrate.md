# ADR 0009 — Kubernetes is the default runtime substrate; isolation is a RuntimeClass tier

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Lantern runtime team
- **Tags:** runtime, isolation, scheduling, kubernetes, security
- **Supersedes (in part):** the class→backend mapping in [ADR 0002](0002-runtime-class-per-workload.md)
- **Related:** [18-agent-runtime-nextgen](../architecture/18-agent-runtime-nextgen.md), [04-runtime-isolation](../architecture/04-runtime-isolation.md), [17-deployment-model](../architecture/17-deployment-model.md)

## Context

ADR 0002 established that the agent author declares an `IsolationClass` and the
platform maps it to a physical backend, with **Firecracker as the default** for
`STANDARD` and a literal class→backend table spanning five distinct backends
(K8s Job, Firecracker, Kata, Wasmtime, devcontainer). The manager picks one
`default_backend` per node via `RUNTIME_BACKEND`, and `choose_backend`
(`services/runtime-manager/src/service.rs`) hard-refuses to run `UNTRUSTED`/`HOSTILE`
on anything that is not a microVM backend.

Three things changed since ADR 0002 (2026-05-12):

1. **Lantern's deployment model is Kubernetes.** The data plane runs in the
   customer's VPC on EKS/GKE/AKS ([17-deployment-model](../architecture/17-deployment-model.md)).
   Running Firecracker as the *primary* path requires bare-metal / nested-virt nodes
   the customer must provision and operate separately from their cluster — friction
   that contradicts "agents execute in customer infra" as the easy path.

2. **The industry converged on K8s-with-RuntimeClass-tiering.** GKE Agent Sandbox
   (GA May 2026, gVisor default + Kata option), Northflank (infrastructure-adaptive
   Kata/gVisor), and others express isolation as a **RuntimeClass on a pod** rather
   than as separate orchestration backends. This collapses five backends into one
   substrate while keeping hardware-grade isolation available *as a tier*.

3. **Maintaining five first-class backends is a tax.** Only Firecracker (cold-boot)
   and K8s Job are genuinely exercised; Kata has no integration test, Docker is
   dev-only. Five code paths multiply the security surface and the CI matrix.

The question: **what is the default substrate, and how is isolation expressed on it,
without weakening the ADR 0002 invariant that untrusted/hostile code never runs in a
shared-kernel container?**

## Decision

**Kubernetes is the default runtime substrate.** Every isolation class runs as a
Kubernetes pod; **isolation strength is selected by `runtimeClassName`, not by a
separate backend.** Firecracker is retained — as the `kata-fc` RuntimeClass and/or a
dedicated microVM node pool — but is **no longer the default**.

New class → (substrate, RuntimeClass) mapping, replacing the ADR 0002 table:

```
TRUSTED       → K8s pod, runtimeClassName: runc        (signed first-party only; shared nodes)
STANDARD      → K8s pod, runtimeClassName: gvisor      (DEFAULT; shared, gVisor-isolated)
UNTRUSTED     → K8s pod, runtimeClassName: gvisor      + egress allowlist + seccomp deny-default
HOSTILE       → K8s pod, runtimeClassName: kata-qemu   (microVM via K8s; dedicated pool, no co-tenancy)
                          (or kata-fc for Firecracker-backed Kata)
WASM          → K8s pod, runtimeClassName: crun+wasm   (or in-process Wasmtime on trusted hosts)
DEVCONTAINER  → long-lived K8s pod + PVC, runtimeClassName: gvisor
```

Defaults from ADR 0002 are otherwise unchanged: unset → `STANDARD`; marketplace +
LLM-generated bundles are forced to `UNTRUSTED`; `TRUSTED` requires the signing key.
The only change is that `STANDARD`'s substrate is now **gVisor-on-K8s** instead of
bare Firecracker.

### The security invariant is preserved, not weakened

`UNTRUSTED` and `HOSTILE` still receive hardware/kernel isolation — now expressed as a
**hardened RuntimeClass** (gVisor for untrusted, Kata microVM for hostile) rather than
a bare-pod backend. The `choose_backend` refusal logic is **extended**:

- A K8s node may satisfy `UNTRUSTED` **only if it advertises the `gvisor`
  RuntimeClass**; it may satisfy `HOSTILE` **only if it advertises `kata-qemu`/`kata-fc`**.
- A node that does not advertise the required hardened RuntimeClass **still fails
  closed** (`Status::failed_precondition`) exactly as today — it never downgrades an
  untrusted/hostile workload to bare `runc`.
- The class→RuntimeClass requirement is enforced at the manager (which builds the pod
  spec) **and** asserted by the scheduler's node-capability filter (placement only
  picks nodes that advertise the needed RuntimeClass).

This is the same guarantee as ADR 0002 — "the platform can refuse degradation" —
restated in RuntimeClass terms.

### Migration

1. **Code:** K8s backend sets `runtimeClassName` from the IsolationClass; extend
   `choose_backend` to accept a K8s node for untrusted/hostile **only** when the
   hardened RuntimeClass is advertised; flip the manager's default backend/config to
   `k8s`. (Phase 1 in [18-agent-runtime-nextgen](../architecture/18-agent-runtime-nextgen.md).)
2. **Install:** the data-plane Helm/Kustomize provisions the `gvisor` and `kata-qemu`
   RuntimeClasses and labels node pools accordingly; a default-deny egress
   NetworkPolicy + credential-injecting egress proxy lands with it.
3. **Compatibility:** dedicated Firecracker nodes keep working via `kata-fc` / the
   microVM node pool — existing `HOSTILE` workloads are unaffected.

This decision is documentation + sequencing; the load-bearing code lands in Phase 1
behind a security-auditor sign-off and integration tests (untrusted→gVisor,
hostile→Kata, fail-closed on a node lacking the RuntimeClass, default-deny egress).

## Consequences

### Positive
1. **One substrate.** Five backends collapse to "a pod + a RuntimeClass." Smaller
   security surface, smaller CI matrix, one warm-pool/PID-controller model.
2. **Matches the deployment model.** The data plane is already K8s in the customer
   VPC; the runtime now rides the same substrate with no separate microVM fleet to
   provision for the common case.
3. **Industry-aligned and portable.** RuntimeClass tiering is the GKE Agent Sandbox /
   Northflank pattern; it ports across EKS/GKE/AKS and on-prem.
4. **Isolation stays a first-class, declared property.** A reviewer still sees
   "this agent runs HOSTILE"; it now maps to `kata-qemu` rather than a bare-metal pool.

### Negative
1. **gVisor syscall-compatibility gaps.** A minority of workloads hit unimplemented
   syscalls under gVisor. *Mitigation:* such agents declare `HOSTILE` (Kata, full
   kernel) or a `runc`-on-trusted exception via the admin override.
2. **gVisor performance overhead** (~10–15% on syscall-heavy paths). *Mitigation:*
   `TRUSTED` first-party code runs on `runc`; the overhead buys shared-node density
   that bare Firecracker can't match for `STANDARD`.
3. **RuntimeClass must be installed and verified.** A cluster missing `gvisor`/`kata`
   refuses untrusted/hostile (fail-closed) — correct but operationally visible.
   *Mitigation:* the data-plane installer provisions them; a preflight check surfaces
   the gap before traffic.
4. **Kata-on-K8s nested-virt requirement** for `HOSTILE`. *Mitigation:* dedicated
   bare-metal/nested-virt node pool labeled for Kata; `kata-fc` keeps Firecracker.

### Neutral
- Firecracker is not removed; it is repositioned from "the default" to "the Kata
  microVM tier / dedicated pool." ADRs 0004–0007 (harness baked into the image,
  short-JWT secret vending, egress allowlist, snapshot retention) are unaffected —
  they apply to the Kata microVM tier exactly as before.
