# Runbook: Cluster validation (gVisor / Kata)

**Closes the README gap:** "live Kata execution needs operator-run cluster validation."

---

## What "validated" means

The Lantern runtime dispatches UNTRUSTED agent workloads to gVisor (user-space kernel sandbox) and HOSTILE workloads to Kata (hardware-isolated microVMs). The GitHub-hosted CI job (`runtime · cluster e2e`) validates the always-on isolation legs (NetworkPolicy, securityContext, PSA, fail-closed RuntimeClass refusal) but **cannot** validate actual sandbox execution — GitHub runners have no `runsc` and no nested virtualisation (`/dev/kvm`).

"Validated" for the README status line means: an operator ran the harness below against a real sandbox cluster **and the per-leg report shows PASS for legs g, h, and i**.

---

## What you need

| Requirement | Detail |
|---|---|
| A Kubernetes cluster | EKS, GKE, AKS, or self-hosted with `kata-deploy` |
| `gvisor` RuntimeClass | Backed by a node pool running `runsc` (GKE Agent Sandbox, or `gvisor-containerd-shim` on self-hosted) |
| `kata` RuntimeClass | Backed by a dedicated, **tainted** node pool (`lantern.dev/runtimeclass=kata:NoSchedule`). On GKE this can be a second sandbox pool; on self-hosted use `kata-deploy`. |
| Node labels | `lantern.dev/runtimeclass=gvisor` / `lantern.dev/runtimeclass=kata` on the respective pools |
| `kubectl` | Any recent version; accessible from the machine running the harness |
| A kubeconfig | Pointing at the cluster with cluster-admin or equivalent permissions |

The harness does **not** provision the cluster. Use `infra/k8s/gke-agent-sandbox-setup.sh` for GKE (gVisor GA + Kata via a second pool), or bring your own.

---

## One command

```bash
# Option A — env var
KUBECONFIG=/path/to/kubeconfig.yaml make validate-cluster

# Option B — CLI flag
lantern vm validate --kubeconfig /path/to/kubeconfig.yaml

# Option C — direct script (same as A)
bash scripts/validate-cluster.sh --kubeconfig /path/to/kubeconfig.yaml
```

All three run identically. The `--context` flag selects a specific context when the kubeconfig contains multiple clusters:

```bash
lantern vm validate --kubeconfig ./k.yaml --context gke_project_us-central1_cluster
```

---

## What the harness does

### Step 1 — Preflight

- Confirms `kubectl` is in PATH.
- Confirms the cluster at the provided kubeconfig/context is reachable.
- Checks for a `RuntimeClass` named `gvisor`: **PRESENT** or **ABSENT**.
- Checks for a `RuntimeClass` named `kata`: **PRESENT** or **ABSENT**.
- Prints a node summary (name, status, roles, labels) — informational, never a failure.

### Step 2 — Always-on isolation legs (a–f)

Delegates to `infra/k8s/validate.sh --ci` against the operator's cluster. These are the same legs CI runs on every PR but against your real cluster:

| Leg | What it checks |
|-----|---------------|
| (a) | Egress default-deny (Calico/Cilium NetworkPolicy) + positive control |
| (b) | DNS carve-out still resolves inside the fenced namespace |
| (c) | securityContext: uid 1000, RO rootfs, cap-drop ALL, no-priv-esc, seccomp RuntimeDefault, no SA token |
| (d) | PSA `restricted` rejects a runAsRoot/privileged pod at admission |
| (f) | Fail-closed: UNTRUSTED pod requesting a missing RuntimeClass is refused, never falls back to runc |
| (e) | Helm chart renders cleanly (Kyverno/Cilium/ESO, all toggles on) |

Any failure here exits nonzero — fix the cluster's base isolation before the execution legs matter.

### Step 3 — gVisor execution leg (g)

- If `RuntimeClass gvisor` is **ABSENT**: leg is **SKIPPED** (operator needs to provision the pool). Exit 0 for this leg; the report says SKIPPED.
- If **PRESENT**: applies `infra/k8s/manifests/92-untrusted-gvisor-exec.yaml`, waits for the pod to run, then reads `/proc/version` and asserts it contains `"gVisor"` (the user-space kernel marker). Falls back to checking the node's `lantern.dev/runtimeclass=gvisor` label on runsc builds that do not stamp `/proc/version`.

### Step 4 — Kata execution legs (h/i)

- If `RuntimeClass kata` is **ABSENT**: both legs **SKIPPED**.
- If **PRESENT**:
  - **(h)** Applies `infra/k8s/manifests/93-hostile-kata-exec.yaml`. Waits for the pod. Reads `uname -r` inside the guest and asserts it differs from the host node's kernel (a Kata microVM has its own guest kernel; a bare runc pod would share the host kernel — identical kernels = fail-open breach).
  - **(i)** Confirms the node the Kata pod landed on has **no other `lantern-t-*` tenant pods** (the taint must make it dedicated).

### Step 5 — Report

Writes `cluster-validation-report.md` (default path, override with `--report`) containing:
- A summary table of every leg with ✅ PASS / ❌ FAIL / ⏭ SKIPPED
- Explanation of what SKIPPED legs require
- The full detail log

---

## How to read the report

```
| Leg | Result | Detail |
|-----|--------|--------|
| always-on legs (a–f)      | ✅ PASS   | validate.sh --ci exited 0          |
| (g) gVisor pod runs        | ✅ PASS   | reached Running under runtimeClassName=gvisor |
| (g) gVisor sandbox confirmed | ✅ PASS  | /proc/version advertises gVisor    |
| (h) Kata pod runs          | ⏭ SKIPPED | RuntimeClass 'kata' not installed  |
| (h) Kata microVM confirmed | ⏭ SKIPPED | RuntimeClass 'kata' not installed  |
| (i) dedicated Kata node    | ⏭ SKIPPED | RuntimeClass 'kata' not installed  |
```

**All PASS, no SKIP** → fully validated. Update the README status line.

**All PASS + some SKIP** → partially validated. The SKIPPED legs require the missing RuntimeClass. Provision the node pool and re-run.

**Any FAIL** → a runnable leg failed. Follow the `→ hint` in the terminal output and re-run after fixing.

---

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | All runnable legs passed (SKIPPED legs are not failures) |
| 1 | One or more runnable legs failed |
| 2 | Preflight error (kubectl absent, cluster unreachable, etc.) |

---

## Provisioning a sandbox cluster (GKE)

```bash
PROJECT=my-gcp-project REGION=us-central1 bash infra/k8s/gke-agent-sandbox-setup.sh
```

The script creates:
- A base GKE cluster with network policy enabled
- A gVisor node pool (GKE Sandbox, `--sandbox type=gvisor`) labelled `lantern.dev/runtimeclass=gvisor`
- A dedicated "Kata" pool (second sandbox pool, labelled + tainted `lantern.dev/runtimeclass=kata:NoSchedule`)
- RuntimeClass objects `gvisor` and `kata`
- The `lantern-t-validate` namespace (PSA `restricted`)

After the script completes, run the harness:

```bash
lantern vm validate --kubeconfig ~/.kube/config
```

---

## Wiring into CI (optional)

The workflow `.github/workflows/runtime-cluster-e2e.yml` already has a `cluster-e2e-execution` job that runs on `workflow_dispatch` when the repo secret `CLUSTER_E2E_KUBECONFIG_B64` is set. To enable it:

```bash
# 1. Base64-encode the kubeconfig (macOS)
base64 < ~/.kube/config | tr -d '\n'

# 2. Store the output as the repo secret CLUSTER_E2E_KUBECONFIG_B64 in GitHub.

# 3. Dispatch the workflow:
gh workflow run "runtime · cluster e2e (kind + calico)"
```

The execution job will run `validate.sh --ci --execution` against your cluster and post the per-leg results to the workflow summary.

---

## Accuracy note

**Kata was NOT validated here.** This runbook and harness make Kata validation a 5-minute operator task; the harness itself does not fake the result. A leg marked SKIPPED is never reported as PASS. Only a ✅ PASS next to leg (h) in a report generated against a real cluster with a Kata RuntimeClass constitutes validation.
