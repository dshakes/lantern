# K8s Job isolation validation harness

Closes the SECURITY.md "must-close" item **K8s Job isolation validated
end-to-end** (also the first Beta security gate in `docs/LAUNCH-CHECKLIST.md`):
prove against a **real cluster** — not unit tests — that the K8s isolation
class produced by `services/runtime-manager/src/backends/k8s.rs` actually
enforces:

- **default-deny network** — per-run `NetworkPolicy`; the workload pod cannot
  reach the internet (by domain *or* direct IP), while DNS (port 53) still works
- **`seccompProfile: RuntimeDefault`** at the pod level
- **`capabilities.drop: [ALL]`** + `allowPrivilegeEscalation: false` +
  `runAsNonRoot` / `runAsUser: 1000` + `readOnlyRootFilesystem: true`
- **no service-account token** in the pod (`automountServiceAccountToken: false`)
- a pod requesting **runAsRoot / privileged / privilege escalation is rejected**
  at admission (Pod Security Admission `restricted` on the tenant namespace)
- **[fail-closed]** an UNTRUSTED pod that requests a sandbox `runtimeClassName`
  (gVisor / Kata) which is **not installed** must **not** silently fall back to
  runc — it stays unschedulable / is refused (the core ADR-0009 invariant). This
  is asserted in CI *without* gVisor: we prove the refusal, not sandbox execution.

## How to run

```bash
make k8s-validate          # or: bash infra/k8s/validate.sh
```

Requires Docker running plus `kind` + `kubectl` (`brew install kind kubectl`).
Takes ~3–5 minutes: creates a throwaway kind cluster (`lantern-k8s-validate`),
installs **Calico**, applies the manifests, runs live `kubectl exec` probes and
jsonpath assertions, prints PASS/FAIL per assertion, exits non-zero on any
FAIL, and tears the cluster down via an EXIT trap.

Knobs:

| Env | Effect |
| --- | --- |
| `KEEP_CLUSTER=1` | skip teardown for debugging (`kind delete cluster --name lantern-k8s-validate` later) |
| `CALICO_MANIFEST=<url>` | override the pinned Calico manifest (default v3.28.2) |
| `NO_COLOR=1` | plain output |

Flags:

| Flag | Effect |
| --- | --- |
| `--ci` | the caller (CI workflow) owns the cluster lifecycle — skip create/teardown |
| `--execution` | also run the gVisor/Kata **execution** legs (g/h/i). Requires a real cluster with the `gvisor` + `kata` RuntimeClass handlers on labelled/tainted node pools — **off by default**; not runnable on stock kind or GitHub-hosted runners (no `runsc`, no nested virt) |

## Always-on legs (a–f) vs. execution legs (g–i)

Legs **a–f** prove the fail-CLOSED contract and run anywhere (kind + Calico, hosted
CI): egress default-deny, DNS carve-out, hardened `securityContext`, PSA
`restricted` rejection, the opt-in security chart renders, and — the ADR-0009
core — an UNTRUSTED pod requesting an **uninstalled** `runtimeClassName: gvisor`
**stays unschedulable / is refused**, never falling back to runc.

Legs **g–i** prove the other half — that *with* the sandbox installed, workloads
actually run *inside* it. They need a real sandbox-capable cluster and so only
run under `--execution`:

- **(g)** an UNTRUSTED pod on `runtimeClassName: gvisor` **runs** (not refused, not
  Pending) and is gVisor-sandboxed (proven via `/proc/version` advertising gVisor,
  or a `gvisor`-labelled node).
- **(h)** a HOSTILE pod on `runtimeClassName: kata` **runs in a Kata microVM**,
  proven by the guest kernel (`uname -r`) differing from the host node kernel — a
  bare runc pod would share the host kernel (identical), which is treated as a
  fail-open isolation breach.
- **(i)** the HOSTILE pod's node is **dedicated**: no pod from a different
  `lantern-t-*` tenant namespace shares it (the `NoSchedule` taint is enforced).

### Running the execution legs

GitHub-hosted runners cannot run g–i (no `runsc`, no `/dev/kvm`). Provision a real
cluster and run them yourself or via CI:

```bash
# 1. Stand up a gVisor/Kata cluster (GKE Agent Sandbox shown):
PROJECT=my-gcp-project REGION=us-central1 infra/k8s/gke-agent-sandbox-setup.sh

# 2. Run the legs (the script prints the exact command):
infra/k8s/validate.sh --ci --execution
```

To run them in CI: store the cluster's base64 kubeconfig as the repo secret
`CLUSTER_E2E_KUBECONFIG_B64`, then dispatch the **runtime · cluster e2e** workflow
— its `cluster-e2e-execution` job runs `validate.sh --ci --execution` against the
cluster (and no-ops with an honest notice when the secret is absent — never a fake
green). Kata on GKE is not GA; on a cluster without a Kata handler the (h)/(i)
legs correctly fail-closed — run them on a self-hosted cluster with `kata-deploy`
for the full Kata path.

## Why Calico

kind's default CNI (kindnet) **does not enforce NetworkPolicy** — a
default-deny egress test against it passes vacuously. `kind-cluster.yaml`
disables the default CNI and `validate.sh` installs Calico so the egress-block
assertion is real. The script also runs a **positive control**: an unfenced pod
in `default` must reach the internet, proving the block on the fenced pod is
the policy, not broken networking.

## Files

| File | Purpose |
| --- | --- |
| `kind-cluster.yaml` | throwaway single-node cluster, default CNI disabled, Calico pod subnet |
| `manifests/00-namespace.yaml` | `lantern-t-validate` namespace (PSA `restricted`) + `lantern-agent-runner` SA |
| `manifests/10-networkpolicy.yaml` | per-run default-deny ingress+egress fence; allow DNS + runtime manager only |
| `manifests/20-job.yaml` | sample workload Job mirroring `build_job()` in `k8s.rs` (busybox+sleep so probes can exec) |
| `manifests/90-escalation-probe.yaml` | negative probe — root/privileged pod that admission must reject |
| `manifests/91-untrusted-missing-runtimeclass.yaml` | fail-closed probe — UNTRUSTED pod requesting `runtimeClassName: gvisor` (not installed) that must stay unschedulable, never run on runc |
| `manifests/92-untrusted-gvisor-exec.yaml` | execution probe (leg g) — UNTRUSTED pod that must RUN inside gVisor (`--execution` only) |
| `manifests/93-hostile-kata-exec.yaml` | execution probe (legs h/i) — HOSTILE pod that must run in a Kata microVM on a dedicated node (`--execution` only) |
| `gke-agent-sandbox-setup.sh` | operator script — provisions a GKE Agent Sandbox cluster (gVisor pool + tainted Kata pool + RuntimeClasses) for the execution legs |
| `validate.sh` | the harness (style-matched to `scripts/dev-doctor.sh`); `--ci` skips cluster create/teardown when the caller (CI) owns the cluster; `--execution` runs legs g/h/i |

## Manifest vs. `k8s.rs` gaps (documented, intentionally not fixed here)

What `build_job()` / `build_network_policy()` emit today **matches** the
hardened manifests on: per-run pod-selector egress fence, DNS allow (UDP+TCP
53), seccomp `RuntimeDefault`, cap drop ALL, non-root uid 1000, no-priv-esc,
read-only rootfs, `automountServiceAccountToken: false`, `backoffLimit: 0`.

Gaps the validation manifests harden beyond today's `k8s.rs`:

1. **No ingress deny** — `k8s.rs` sets `policyTypes: [Egress]` only;
   `10-networkpolicy.yaml` adds `Ingress` with no rules (deny all inbound).
2. **No manager-allow egress rule** — `k8s.rs` allows only DNS + CIDR
   allowlist peers; the harness→runtime-manager channel (TCP 50054) would be
   fenced too. `10-networkpolicy.yaml` adds an explicit allow to the manager
   pod in `lantern-system`.
3. **Namespace/SA/PSA provisioning is assumed** — `k8s.rs` never creates the
   `lantern-t-<tenant>` namespace, the `lantern-agent-runner` ServiceAccount,
   or the `pod-security.kubernetes.io/enforce: restricted` label. Tenant
   namespace provisioning must produce `00-namespace.yaml`'s shape, otherwise
   Job creation fails (missing SA) and assertion (d) has no admission backstop.
