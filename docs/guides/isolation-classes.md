# Isolation Classes

Lantern expresses isolation as a **RuntimeClass tier on a Kubernetes pod** — not as
five separate backends. You declare the class in `agent.yaml`; the runtime-manager
selects the corresponding `runtimeClassName` and security context automatically.

See [ADR 0009](../adr/0009-kubernetes-default-runtime-substrate.md) for the full
decision and security argument. See [ADR 0002](../adr/0002-runtime-class-per-workload.md)
for the original class → backend design that ADR 0009 supersedes.

## The classes

| Class | RuntimeClass | Co-tenancy | Use when |
|---|---|---|---|
| `TRUSTED` | `runc` | shared nodes | Lantern-authored or fully-audited signed first-party code; no untrusted input paths |
| `STANDARD` *(default)* | `gvisor` | shared, gVisor-isolated | Typical third-party code; safe default for most agents |
| `UNTRUSTED` | `gvisor` + egress deny-default + seccomp | shared, hardened | Code that loads packages from the internet or runs LLM-generated code |
| `HOSTILE` | `kata-qemu` / `kata-fc` | **dedicated node pool, no co-tenancy** | Adversarial input; user-uploaded code; browser automation |
| `WASM` | `crun`+Wasm (or in-process Wasmtime on trusted hosts) | shared | Pure-function, capability-typed tools; sub-ms overhead |
| `DEVCONTAINER` | long-lived pod + PVC, `gvisor` | per-workspace | Long-lived agents that maintain workspace state across calls |

## Decision tree

```text
Does the code come from Lantern's own signed bundle, fully audited by your team?
  Yes → TRUSTED
  No  ↓

Does it load packages from the internet, run pip/npm at runtime, or execute
LLM-generated code?
  No  → STANDARD  (gVisor; the default for most agents)
  Yes ↓

Is the input potentially adversarial (user-uploaded scripts, web-scraped code,
browser automation against arbitrary sites)?
  No  → UNTRUSTED  (gVisor + egress deny-default)
  Yes → HOSTILE    (Kata microVM, dedicated pool)

Is the workload a pure function with no network needs and microsecond latency
requirements?
  Yes → WASM

Does the agent need persistent disk state across invocations?
  Yes → DEVCONTAINER
```

## The fail-closed gate

Isolation is **fail-closed by design**, enforced at two points:

1. **`choose_backend`** in `services/runtime-manager/src/service.rs` — refuses to
   schedule `UNTRUSTED` or `HOSTILE` unless the node advertises the required
   hardened RuntimeClass (`gvisor` or `kata-qemu`/`kata-fc`).

2. **`build_job`** — a second gate applies the correct `runtimeClassName` to the
   pod spec; an empty or wrong class aborts the spawn before the pod is created.

**The invariant:** an `UNTRUSTED` or `HOSTILE` workload will never silently
downgrade to a bare `runc` pod. If the required RuntimeClass is absent, the spawn
returns `FAILED_PRECONDITION` (HTTP 412) rather than proceeding without isolation.

> On macOS / Docker backends (local dev without a hardened cluster), the
> runtime-manager returns `FAILED_PRECONDITION` for `UNTRUSTED` and `HOSTILE`
> specs. Use `isolation: trusted` or `isolation: standard` for local dev, and
> gate your CI on a real kind+gVisor or GKE Agent Sandbox cluster for the
> hardened classes.

## Per-class security context

Regardless of class, every pod gets a hardened base `securityContext`:

- `runAsNonRoot: true`
- `readOnlyRootFilesystem: true`
- `allowPrivilegeEscalation: false`
- `capabilities.drop: [ALL]`
- `automountServiceAccountToken: false`
- `seccompProfile: RuntimeDefault`

`HOSTILE` additionally pins to a dedicated node pool via `nodeAffinity` and
`tolerations` so no other tenant's pod lands on the same physical node.

## Network isolation

Every workload pod gets a per-workload `NetworkPolicy`:

- **Ingress: default deny** (nothing can reach in except the manager's health probe).
- **Egress: default deny** except DNS (UDP/TCP 53 to `kube-dns`).

The in-VM harness then enforces a **guest-side egress allowlist** (`spec.egress_rules`)
on top of the host NetworkPolicy — defense-in-depth. For `UNTRUSTED` and `HOSTILE`,
the harness adds nftables rules that drop every outbound connection not in the
allowlist and emit an audit event on each denial.

## Cluster-side opt-in hardening

The Helm chart in `infra/k8s/` provides opt-in cluster-side policies (all off by
default; enable per-environment in Helm values):

- **Kyverno tenant baseline** — PSA `restricted` + default-deny NetworkPolicy +
  per-`lantern-t-*` namespace ResourceQuota and LimitRange.
- **cosign image-signature verification** — keyless GitHub-OIDC, fail-closed.
- **Cilium host-level egress** — deny-default at the host NIC, credential-injecting
  egress proxy for the outbound path.
- **External Secrets Operator** — optional integration for cluster-managed secret stores.

## Firecracker

Firecracker is retained as `kata-fc` — a Kata RuntimeClass backed by Firecracker
microVMs. It is no longer the default substrate (that is K8s with gVisor/Kata
RuntimeClasses), but it is available for operators who want Firecracker-grade cold
boot (~28ms via snapshot restore) on dedicated nodes.

On Apple Silicon (M3+/macOS 15+), [`infra/lima/`](../../infra/lima/) provisions a
Lima guest with nested-virt KVM. A microVM boots to login in ~1.6s (verified on M4
Max).

## Cluster e2e legs

The always-on legs — egress deny (including `169.254.169.254` and RFC1918),
`securityContext`, PSA `restricted`, and the fail-closed RuntimeClass refusal — run
on kind + Calico in CI (`make k8s-validate`). The execution legs that prove a
workload actually runs *inside* gVisor or Kata (checking `/proc/version` and guest
kernel identity) ship wired and documented but skip unless a kubeconfig with those
runtimes installed is provided (GitHub-hosted runners cannot nest-virtualize).
