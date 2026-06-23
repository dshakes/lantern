# Agent-Sandbox Backend — Grounded Code Spike

> **What this is:** the concrete, file-and-line seam where a `SandboxBackend`
> (reconciling the `kubernetes-sigs/agent-sandbox` CRDs) slots into the existing
> runtime-manager, plus the exact `runtime.proto` → `SandboxSpec` field mapping.
> Companion to [ADR 0012](../adr/0012-agent-sandbox-backend.md). Read that first
> for *why*; this is *where* and *how*.
>
> **Status:** spike / not implemented. Skeleton compiles in shape, not against a
> real CRD binding yet (the agent-sandbox Rust types must be generated from the
> CRD OpenAPI or `kube`-derived first — see "Open work" below).

---

## 1. The seam already exists

Backends implement one trait and are selected by one `match`. Nothing about
adding a Sandbox backend touches the scheduler, the harness, the proto, or any
other backend.

**`services/runtime-manager/src/backend.rs:55`** — the trait every backend
implements (abridged to the methods that matter here):

```rust
#[async_trait]
pub trait RuntimeBackend: Send + Sync {
    async fn schedule(&self, req: &ScheduleRequest) -> Result<Handle>;
    async fn cancel(&self, handle_id: &str, reason: &str) -> Result<()>;
    async fn stream(&self, handle_id: &str) -> Result<BoxStream<'static, RuntimeEvent>>;
    async fn snapshot(&self, req: &SnapshotRequest) -> Result<SnapshotInfo>;
    async fn restore(&self, snapshot_uri: &str, req: &RestoreRequest) -> Result<Handle>;
    fn name(&self) -> &'static str;
    fn satisfies_isolation(&self, class: IsolationClass) -> bool { /* conservative default */ }
    async fn exec_command(&self, ...) -> Result<ExecOutput> { /* default: unimplemented */ }
    async fn stats_sample(&self, handle_id: &str) -> Result<StatsSample> { /* default: unimplemented */ }
}
```

**`services/runtime-manager/src/config.rs:4`** — the backend enum, add one arm:

```rust
pub enum RuntimeBackend {
    Docker,
    K8s,
    Firecracker,
    Kata,
    Wasm,
    Sandbox,           // NEW — agent-sandbox CRD reconciler
}
// in from_str(): "sandbox" | "agent-sandbox" => Ok(RuntimeBackend::Sandbox),
```

**`services/runtime-manager/src/main.rs:64`** — the selection `match`, add one branch:

```rust
let backend: Arc<dyn RuntimeBackend> = match &config.runtime_backend {
    RuntimeBackendKind::Docker      => Arc::new(DockerBackend::new(...)),
    RuntimeBackendKind::K8s         => Arc::new(K8sBackend::new_with_runtime_classes(...).await?),
    RuntimeBackendKind::Firecracker => Arc::new(FirecrackerBackend::new()),
    RuntimeBackendKind::Kata        => Arc::new(KataBackend::from_env(...)),
    RuntimeBackendKind::Wasm        => Arc::new(WasmBackend::new()?),
    RuntimeBackendKind::Sandbox     => Arc::new(                         // NEW
        SandboxBackend::new_with_runtime_classes(config.agent_image.clone(), rc_cfg).await?,
    ),
};
```

That is the entire wiring surface. `SandboxBackend` reuses the same
`RuntimeClassConfig` the K8s backend already takes (`config.rs:52`), so the
ADR 0009 RuntimeClass plumbing is shared verbatim.

---

## 2. Why this backend (and not just finishing `K8sBackend`)

`K8sBackend` builds a `batch/v1` `Job` and **leaves snapshot/restore
unimplemented** — these are the live stubs the new backend replaces:

```rust
// services/runtime-manager/src/backends/k8s.rs:793
async fn snapshot(&self, _req: &SnapshotRequest) -> Result<SnapshotInfo> {
    // returns an error — K8s Jobs have no snapshot primitive
}
// services/runtime-manager/src/backends/k8s.rs:797
async fn restore(&self, _snapshot_uri: &str, _req: &RestoreRequest) -> Result<Handle> {
    // returns an error
}
```

The Sandbox backend implements both by patching `spec.operatingMode`, because
the agent-sandbox controller (with a gVisor RuntimeClass) does the gVisor
checkpoint underneath. **That is the whole point of the migration.**

---

## 3. Proto → SandboxSpec field mapping

`ScheduleRequest` (the manager-side decode of wire `AgentSpec`, see
`proto.rs:149`) maps onto a `SandboxClaim` + its referenced `SandboxTemplate`.
The split: **stable, security-defining fields → `SandboxTemplate` (reused across
runs); per-run fields → `SandboxClaim`.**

| Lantern (`ScheduleRequest` / `AgentSpec`) | agent-sandbox target | Notes |
|---|---|---|
| `isolation_class` | `SandboxTemplate.podTemplate.spec.runtimeClassName` | via existing `isolation_to_runtime_class` (`k8s.rs:250`): STANDARD/UNTRUSTED→`gvisor`, HOSTILE→`kata`. **Fail-closed unchanged.** |
| `image` / `bundle_uri` + `bundle_digest` | `podTemplate.spec.containers[0].image` | digest-pinned (`AgentSpec.image_digest` is REQUIRED, no tags) |
| `command` / `args` | container `command` / `args` | direct |
| `limits.vcpu` / `limits.memory` / `limits.gpu` | container `resources.requests`/`limits` | K8s quantities already (`"500m"`, `"512Mi"`) — no conversion |
| `limits.scratch_size` | `volumeClaimTemplates[scratch]` or `emptyDir.sizeLimit` | tmpfs scratch → `emptyDir`; durable (DEVCONTAINER) → PVC template |
| `limits.timeout` | `Sandbox.spec.lifecycle.shutdownTime` (now + timeout) + `shutdownPolicy: Delete` | the CRD's TTL is absolute; compute `now + timeout` at claim time |
| `tenant_id` (authenticated) | claim **namespace** `lantern-t-<tenant_id>` + `additionalPodMetadata.labels[tenant-id]` | reuses `namespace_for` (`k8s.rs:133`); never from caller env |
| `secrets` (`SecretRef`) | **NOT mapped to K8s Secrets** — left to the harness | secret refs stay in the pod env as Lantern URIs; the in-VM harness vends short-TTL tokens (ADR 0005/0008). Deliberately *not* `envFrom: secretRef`. |
| `egress_rules` / `network` | `SandboxTemplate.spec.networkPolicy` (default-deny) **+** harness egress proxy | NetworkPolicy is defense-in-depth; the allowlist proxy (ADR 0006) is the real enforcement, unchanged |
| `env` (caller-supplied) | container `env` (+ injected `tenant_id`/`run_id`) | direct |
| `run_id` / `agent_version_id` | `additionalPodMetadata.labels` + claim name | for dashboards/audit correlation |
| `preferred_regions` / `PlacementHint` | `additionalPodMetadata` nodeAffinity / topology | scheduler's scoring output expressed as affinity hints (ADR 0012 §B negative #2) |
| `idempotent` | scheduler-side retry policy | unchanged; not a CRD field |
| `restore_snapshot_id` | claim adopts a `Suspended` sandbox → set `operatingMode: Running` | see §4 |
| warm-pool intent (`pool.rs`) | `SandboxWarmPool{ replicas, sandboxTemplateRef }` | declarative; replaces per-node PID controller for this substrate |

Lifecycle-state mapping (`VmState` ↔ agent-sandbox):

| `VmState` | agent-sandbox signal |
|---|---|
| `PENDING` / `SPAWNING` | `SandboxClaim` created, `Ready` condition false |
| `RUNNING` | `Ready` true, `status.podIPs` populated |
| `DRAINING` | `operatingMode: Suspended` in flight, or shutdownTime reached |
| `TERMINATED` | sandbox deleted / `Finished` condition |
| `FAILED` | backing pod terminal phase, `Finished` with failure |

---

## 4. Skeleton `backends/sandbox.rs`

The shape — not yet compiling against a real CRD binding. The two methods that
earn the migration are `snapshot` and `restore`; everything else mirrors
`K8sBackend`.

```rust
use anyhow::{Context, Result};
use async_trait::async_trait;
use futures::stream::BoxStream;

use crate::backend::{Handle, RuntimeBackend, SnapshotInfo, StatsSample};
use crate::config::RuntimeClassConfig;
use crate::proto::{IsolationClass, RestoreRequest, RuntimeEvent, ScheduleRequest, SnapshotRequest};

// Generated from the agent-sandbox CRD OpenAPI (see "Open work"). Group
// agents.x-k8s.io/v1beta1 and extensions.agents.x-k8s.io/v1alpha1.
use crate::sandbox_crd::{Sandbox, SandboxClaim, SandboxTemplate, SandboxWarmPool, SandboxOperatingMode};

pub struct SandboxBackend {
    client: kube::Client,
    agent_image: String,
    runtime_classes: RuntimeClassConfig,   // shared with K8sBackend — ADR 0009
}

impl SandboxBackend {
    pub async fn new_with_runtime_classes(
        agent_image: String,
        runtime_classes: RuntimeClassConfig,
    ) -> Result<Self> {
        Ok(Self { client: kube::Client::try_default().await?, agent_image, runtime_classes })
    }

    /// Reuses the K8s backend's class→RuntimeClass logic and fail-closed gate.
    fn runtime_class_for(&self, class: IsolationClass) -> Result<Option<String>> {
        crate::backends::k8s::isolation_to_runtime_class(class, &self.runtime_classes)
            .map(|(rc, _warn)| rc)
    }

    /// Ensure a per-(tenant, version, class) SandboxTemplate exists. Idempotent.
    async fn ensure_template(&self, req: &ScheduleRequest) -> Result<String> { /* upsert ST */ todo!() }
}

#[async_trait]
impl RuntimeBackend for SandboxBackend {
    fn name(&self) -> &'static str { "sandbox" }

    // Same invariant as K8sBackend: only satisfy UNTRUSTED/HOSTILE when the
    // hardened RuntimeClass is advertised. ADR 0009 / ADR 0012 carry over.
    fn satisfies_isolation(&self, class: IsolationClass) -> bool {
        crate::backends::k8s::k8s_satisfies_isolation(&self.runtime_classes, class)
    }

    async fn schedule(&self, req: &ScheduleRequest) -> Result<Handle> {
        let template = self.ensure_template(req).await?;          // SandboxTemplate
        let ns = crate::backends::k8s::namespace_for(req)?;       // lantern-t-<tenant>
        // Create a SandboxClaim; controller adopts a warm pod or cold-starts.
        let claim = SandboxClaim::new_for(&template, &ns, req);
        let created = kube::Api::namespaced(self.client.clone(), &ns)
            .create(&Default::default(), &claim).await
            .context("create SandboxClaim")?;
        Ok(Handle { id: created.name(), node_name: created.assigned_node(), cold_start_ms: 0.0 })
    }

    async fn cancel(&self, handle_id: &str, _reason: &str) -> Result<()> {
        // Delete the SandboxClaim; owner refs cascade to Sandbox/Pod/Service/PVC.
        todo!()
    }

    async fn stream(&self, handle_id: &str) -> Result<BoxStream<'static, RuntimeEvent>> {
        // Watch the Sandbox status conditions; map to RuntimeEvent (see §3 table).
        todo!()
    }

    // ── The two methods K8sBackend leaves as errors (k8s.rs:793-801) ──

    async fn snapshot(&self, req: &SnapshotRequest) -> Result<SnapshotInfo> {
        // Pause = patch operatingMode -> Suspended. The controller takes a
        // gVisor checkpoint (filesystem + memory). No bespoke snapshot store.
        self.patch_operating_mode(&req.vm_id, SandboxOperatingMode::Suspended).await?;
        Ok(SnapshotInfo { snapshot_uri: format!("sandbox://{}/suspended", req.vm_id), size_bytes: -1 })
    }

    async fn restore(&self, _snapshot_uri: &str, req: &RestoreRequest) -> Result<Handle> {
        // Resume = patch operatingMode -> Running. Auto-restores latest snapshot.
        let h = self.patch_operating_mode(&req.run_id, SandboxOperatingMode::Running).await?;
        Ok(h)
    }
}
```

The harness, secret relay, and egress proxy do **not** appear here — they live
in the pod's `podTemplate` (baked image, ADR 0004) and on the node, identical to
the Job backend. The only thing that changed is *who creates and pauses the
pod*: the agent-sandbox controller instead of `K8sBackend`.

---

## 5. What stays Lantern's (the value-add wrapper)

Nothing in this backend touches the differentiators — that's the design:

- **Secret vending** (ADR 0005/0008): harness still calls `VendSecret`; the
  control-plane relay still gates by VM binding. Secrets never become K8s
  `Secret` objects.
- **Egress allowlist** (ADR 0006): in-guest proxy + nftables stay; the CRD's
  `networkPolicy` is only defense-in-depth.
- **Tenant model**: namespace `lantern-t-<tenant_id>`, JWT-stamped `tenant_id`,
  RLS, quotas, `agent_budgets` HTTP-402 — all upstream of this backend, in the
  control-plane and scheduler.
- **Scoring**: warm-pool/region/fair-share/cost/health scoring stays in the
  scheduler; its output becomes template selection + affinity on the claim.

---

## 6. Open work (before this compiles / ships)

1. **CRD bindings.** Generate Rust types for `Sandbox` (`agents.x-k8s.io/v1beta1`)
   and `SandboxTemplate`/`SandboxClaim`/`SandboxWarmPool`
   (`extensions.agents.x-k8s.io`) — `kube-derive` + the published CRD OpenAPI.
2. **`ensure_template` semantics.** Decide template identity key
   `(tenant, agent_version, class)` and GC policy for orphaned templates.
3. **Snapshot-locality / region scoring → affinity** translation in the scheduler.
4. **Warm-pool replica cap** per tenant before emitting `SandboxWarmPool`
   (closes upstream DoS gap #251 on our side).
5. **Parity matrix** (ADR 0012 gate): untrusted→gVisor, hostile→Kata,
   fail-closed on missing RuntimeClass, default-deny egress, **suspend/resume
   round-trip with state intact**, warm-pool adopt under quota.
6. **Install:** add the agent-sandbox controller + CRDs to the data-plane
   Helm/Kustomize alongside the RuntimeClasses (ADR 0009 migration step 2).

---

## See also
- [ADR 0012](../adr/0012-agent-sandbox-backend.md) — the decision + options A/B/C
- [ADR 0009](../adr/0009-kubernetes-default-runtime-substrate.md) — K8s substrate, RuntimeClass tiers
- [04b-microvm-productionization](04b-microvm-productionization.md) — the service wiring this fits into
- `services/runtime-manager/src/backend.rs` — the trait
- `services/runtime-manager/src/backends/k8s.rs` — the backend this one parallels
