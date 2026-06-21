# lantern-data-plane Helm chart

Deploys the Lantern **data plane** into the customer's own Kubernetes cluster
(EKS / GKE / AKS / bare metal): the workflow engine, the runtime manager, and
the data-plane agent that tunnels outbound to the Lantern control plane. Agent
code and data never leave the customer's VPC.

```bash
helm install lantern-dp infra/helm/lantern-data-plane \
  --namespace lantern-system --create-namespace \
  --set controlPlane.tenantId=<tenant> \
  --set controlPlane.agentToken=<token>
```

See `values.yaml` for the full set of knobs. This README documents the
**cluster-side security hardening** added in `feat/runtime-nextgen-hardening` —
all of it is **opt-in (safe defaults = disabled)** so a default
`helm install` deploys exactly the prior behavior.

---

## Node labels & RuntimeClasses (isolation tiers — ADR 0009)

The runtime-manager schedules untrusted/hostile agents onto hardened sandbox
runtimes by `runtimeClassName`:

| Isolation class | RuntimeClass    | Node runtime           |
| --------------- | --------------- | ---------------------- |
| UNTRUSTED       | gVisor          | gVisor / containerd-runsc |
| HOSTILE         | Kata            | Kata Containers        |

**Operator prerequisites** (do this BEFORE enabling the classes):

1. Install the node runtime handler on the relevant nodes (gVisor/runsc, Kata).
2. **Label** those nodes so the manager's nodeSelector lands sandboxed pods only
   on capable hardware:
   ```bash
   kubectl label node <node> lantern.dev/runtimeclass=gvisor   # or =kata
   ```
3. **Taint** them so nothing else schedules there (the manager adds the matching
   toleration to sandboxed pods):
   ```bash
   kubectl taint node <node> lantern.dev/runtimeclass=gvisor:NoSchedule
   ```
4. Set the RuntimeClass **names** and enable rendering:
   ```yaml
   runtimeManager:
     runtimeClasses:
       gvisor: "gvisor"      # REQUIRED for UNTRUSTED
       kata: "kata-qemu"     # REQUIRED for HOSTILE
   runtimeClasses:
     create: true            # render the RuntimeClass objects
   ```

Leaving a name **empty** marks that class **unavailable** — the manager
**fails closed** (refuses to schedule UNTRUSTED/HOSTILE) rather than silently
downgrading to `runc`. A RuntimeClass pointing at a missing handler makes pods
unschedulable (fail-safe, but visible) — only flip `create: true` once the
handlers are installed.

> `runtimeClasses.create` and the legacy `runtimeManager.createRuntimeClasses`
> are both honored.

---

## Security toggles

| Toggle (values key)          | Default | Requires (cluster operator)        | What it does |
| ---------------------------- | ------- | ---------------------------------- | ------------ |
| `policies.enabled`           | `false` | Kyverno                            | Tenant-namespace baseline: PSA labels + default-deny NetworkPolicy + ResourceQuota + LimitRange, generated on namespace create |
| `imageVerification.enabled`  | `false` | Kyverno (image-verification webhook) | Require a valid cosign signature on Lantern images; fail closed |
| `egress.cilium.enabled`      | `false` | Cilium CNI                         | Host/eBPF default-deny egress for agent pods (DNS + manager + proxy only) |
| `egress.proxy.enabled`       | `false` | —                                  | Credential-injecting forward proxy = the single controlled egress break |
| `externalSecrets.enabled`    | `false` | External Secrets Operator          | SecretStore + example ExternalSecret for operator/platform secrets |
| `runtimeClasses.create`      | `false` | gVisor/Kata node handlers          | Render the gVisor/Kata RuntimeClass objects |

> All of these render **Custom Resources** for operators that are NOT installed
> by this chart. `helm template` always renders cleanly; `kubectl apply` /
> `helm install` will fail unless the matching operator's CRDs are present.
> Install Kyverno / Cilium / ESO out of band (their own charts) first.

### Tenant baseline (Kyverno) — `policies.enabled`

The control-plane creates tenant namespaces (`lantern-t-<tenant_id>`) at
**runtime**, so they can't be shipped as static manifests. Instead this installs
Kyverno `ClusterPolicy` objects that fire on namespace **create** and lock the
namespace down before any agent pod lands:

- **mutate** — stamp `pod-security.kubernetes.io/{enforce,warn,audit}=restricted`.
- **generate** (synchronized) — a default-deny-all `NetworkPolicy` (empty
  podSelector ⇒ every pod; ingress+egress deny), a `ResourceQuota`
  (cpu/mem/pod caps), and a `LimitRange` (default container limits).

The runtime-manager's per-pod NetworkPolicy layers an **additive** allow (DNS +
manager) on top of this baseline deny, so the two compose: baseline denies all,
the per-pod policy re-opens exactly DNS + the manager channel for that run's pod.

Tune via `policies.namespaceSelector` (glob, default `lantern-t-*`),
`policies.resourceQuota.*`, `policies.limitRange.*`, and
`policies.generateExisting` (apply to namespaces that already exist).

### Image verification (cosign) — `imageVerification.enabled`

A Kyverno `verifyImages` `ClusterPolicy` requiring a valid cosign signature on
Lantern images (`imageVerification.imageReferences`, default = this chart's own
`registry/repository/*`). **Fails closed** (`failureAction: Enforce`).

- **keyless** (default) — Sigstore keyless: the signature must chain to a Fulcio
  cert whose OIDC identity is the GitHub Actions workflow that signed it.
  `imageVerification.keyless.subject` = the `sign-images.yml` workflow identity,
  `.issuer` = GitHub's OIDC issuer. **Update `subject` to your org/repo** before
  enabling Enforce.
- **key** — set `imageVerification.mode: key` and paste a PEM into
  `imageVerification.publicKey`.

The signing side is `.github/workflows/sign-images.yml` (see below).

### Host-level egress (Cilium + proxy) — `egress.cilium.enabled` / `egress.proxy.enabled`

Defense-in-depth **on top of** the runtime-manager's per-pod NetworkPolicy:

- `egress.cilium.enabled` renders a `CiliumClusterwideNetworkPolicy` (or a
  namespaced `CiliumNetworkPolicy` when `egress.cilium.scope: namespaced`) that
  **default-denies egress** for agent pods (`egress.cilium.podSelector`,
  default `lantern.dev/agent=true`), allowing only DNS, the manager/control-plane
  (`:50054`), and — when the proxy is on — the egress proxy.
- `egress.proxy.enabled` renders a minimal **authenticating forward proxy**
  (default `ubuntu/squid`, configurable via `egress.proxy.image` /
  `egress.proxy.config`) + Service.

**Trust model.** Agent pods are untrusted and have **no direct internet**. Their
only path out is the proxy, which terminates the connection, applies its own
allowlist/auth, and injects upstream credentials the agent never sees. A
compromised agent pod can use the proxy's mediated, audited path but cannot
exfiltrate raw credentials — those live at the proxy. The chart guarantees the
**composition** (Cilium funnels agents to the proxy; the proxy is the only
broad-egress workload); the credential-injection rules themselves are
proxy-config-specific — wire them in `egress.proxy.config` (squid.conf) for your
upstreams.

**The shipped default squid.conf is DENY-ALL** — it permits nothing outbound and
does **not** allow RFC1918 (`localnet`), because pod/Service IPs live in those
ranges and an "allow localnet" default would let a compromised, proxied agent
reach any in-cluster Service or another tenant's pods (internal SSRF / lateral
movement). Cloud metadata (`169.254.169.254`) is denied too. The proxy is inert
until the operator supplies an explicit **destination allowlist** via
`egress.proxy.config` (a full squid.conf with `dstdomain`/`dst` ACLs + an
`http_access allow` for them, ending in `http_access deny all`).

### External Secrets (ESO) — `externalSecrets.enabled`

Renders a `SecretStore` (or `ClusterSecretStore` when
`externalSecrets.clusterScope: true`) for the configured provider
(`externalSecrets.provider`: `vault` default / `aws` / `gcp`) plus one example
`ExternalSecret`.

> **Scope note.** Lantern's **primary** secret path for *agent runtime* secrets
> is the **in-VM mTLS vend** — the harness fetches short-TTL secrets at execution
> time and `lantern.secret/...` refs **never land in pod env**. ESO is **not**
> that path. ESO is for **operator-managed platform secrets** (postgres
> password, agent token, registry pull creds) so they can live in
> Vault/AWS/GCP instead of helm values. Adapt the example `ExternalSecret`'s
> `remoteRef` to your backend layout.

---

## CI: image signing (`.github/workflows/sign-images.yml`)

Signs the published runtime images with cosign **keyless** signing (Fulcio +
Rekor) using the GitHub Actions **OIDC token** (`id-token: write`) — no
long-lived keys, no secrets. The signature's identity IS the workflow, which is
exactly what `imageVerification.keyless.subject` trusts. Invoke it via
`workflow_call` from your image-publish workflow (pass digest-pinned image
refs), or `workflow_dispatch` to backfill.

---

## Verifying renders

```bash
helm lint infra/helm/lantern-data-plane
# default (everything OFF) — prior behavior, no security CRs:
helm template infra/helm/lantern-data-plane
# all toggles ON — renders the full security set:
helm template infra/helm/lantern-data-plane \
  --set policies.enabled=true --set imageVerification.enabled=true \
  --set egress.cilium.enabled=true --set egress.proxy.enabled=true \
  --set externalSecrets.enabled=true --set runtimeClasses.create=true
```

`infra/k8s/validate.sh` adds an operator-free assertion `(e)` that the security
chart renders with all toggles on, the expected kinds appear, the Kyverno
`{{request.object…}}` variable survives templating, and the **default** render
stays clean (opt-in honored). The live Kyverno/Cilium/ESO behavior is **not**
exercised there because the kind cluster runs Calico, not those operators.
