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
| `validate.sh` | the harness (style-matched to `scripts/dev-doctor.sh`); `--ci` skips cluster create/teardown when the caller (CI) owns the cluster |

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
