use std::collections::BTreeMap;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use futures::stream::BoxStream;
use futures::{AsyncBufReadExt, StreamExt, TryStreamExt};
use k8s_openapi::api::batch::v1::{Job, JobSpec};
use k8s_openapi::api::core::v1::{
    Affinity, Capabilities, Container, ContainerPort, EnvVar, NodeAffinity, NodeSelector,
    NodeSelectorRequirement, NodeSelectorTerm, Pod, PodSecurityContext, PodSpec, PodTemplateSpec,
    ResourceRequirements, SeccompProfile, SecurityContext,
};
use k8s_openapi::api::networking::v1::{
    IPBlock, NetworkPolicy as K8sNetworkPolicy, NetworkPolicyEgressRule, NetworkPolicyPeer,
    NetworkPolicyPort, NetworkPolicySpec,
};
// Used in unit tests to assert on the empty-ingress-rule slice type.
#[cfg(test)]
use k8s_openapi::api::networking::v1::NetworkPolicyIngressRule;
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::Client;
use kube::api::{Api, AttachParams, DeleteParams, ListParams, LogParams, PostParams};
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::backend::{ExecOutput, Handle, RuntimeBackend, SnapshotInfo, StatsSample};
use crate::proto::{
    IsolationClass, LogLine, NetworkPolicyClass, RestoreRequest, RuntimeEvent, RuntimeExited,
    ScheduleRequest, SnapshotRequest,
};

// ---------------------------------------------------------------------------
// PodMetrics: partial JSON shape for the metrics.k8s.io/v1beta1 API.
// We only need cpu/memory from the first container; we don't need to
// reproduce the full schema (the raw request approach gives us a serde_json
// Value that we parse into this struct).
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Debug)]
struct PodMetrics {
    containers: Vec<ContainerMetrics>,
}

#[derive(serde::Deserialize, Debug)]
struct ContainerMetrics {
    usage: ContainerUsage,
}

/// Resource usage reported by metrics-server.
/// Both fields are Kubernetes quantity strings (e.g. "250m" cpu, "64Mi" memory).
#[derive(serde::Deserialize, Debug)]
struct ContainerUsage {
    cpu: String,
    memory: String,
}

/// RuntimeClass configuration for the K8s backend.
///
/// Each field is the Kubernetes `runtimeClassName` string for the corresponding
/// isolation tier. `None` means the corresponding RuntimeClass is not installed
/// on this cluster.
#[derive(Clone, Debug, Default)]
pub struct RuntimeClassConfig {
    /// `runtimeClassName` for gVisor (UNTRUSTED, STANDARD, DEVCONTAINER).
    /// Sourced from `LANTERN_RUNTIMECLASS_GVISOR`.
    pub gvisor: Option<String>,
    /// `runtimeClassName` for Kata microVM (HOSTILE).
    /// Sourced from `LANTERN_RUNTIMECLASS_KATA`.
    pub kata: Option<String>,
    /// `runtimeClassName` for Wasm pods. Sourced from `LANTERN_RUNTIMECLASS_WASM`.
    pub wasm: Option<String>,
    /// When true, STANDARD/UNSPECIFIED/DEVCONTAINER workloads are allowed to
    /// run on bare runc even when gVisor is not configured.
    /// Sourced from `LANTERN_ALLOW_RUNC_STANDARD`. Default **false** (fail-closed).
    pub allow_runc_standard: bool,
    /// Node label value required for UNTRUSTED pods (`lantern.dev/runtimeclass: <value>`).
    /// Prevents an UNTRUSTED pod from scheduling onto a node that lacks gVisor even when
    /// the RuntimeClass object exists in the API but the node handler is absent.
    /// Sourced from `LANTERN_NODE_LABEL_GVISOR`. Default: `"gvisor"`.
    pub node_label_gvisor: Option<String>,
    /// Node label value required for HOSTILE pods (`lantern.dev/runtimeclass: <value>`).
    /// Same defense-in-depth as `node_label_gvisor` but for Kata.
    /// Sourced from `LANTERN_NODE_LABEL_KATA`. Default: `"kata"`.
    pub node_label_kata: Option<String>,
}

/// Kubernetes Job backend for trusted workloads.
///
/// Creates K8s Jobs in tenant-scoped namespaces. Each job runs the agent runner
/// image as a single pod with resource limits, env vars, and service account
/// bindings for minimal RBAC.
pub struct K8sBackend {
    client: Client,
    agent_image: String,
    /// Hardened RuntimeClass names configured on this cluster.
    pub(crate) runtime_classes: RuntimeClassConfig,
}

impl K8sBackend {
    pub async fn new(agent_image: String) -> Result<Self> {
        Self::new_with_runtime_classes(agent_image, RuntimeClassConfig::default()).await
    }

    /// Construct with explicit RuntimeClass configuration. Used in tests and
    /// by the main startup path to inject the names from `Config`.
    pub async fn new_with_runtime_classes(
        agent_image: String,
        runtime_classes: RuntimeClassConfig,
    ) -> Result<Self> {
        let client = Client::try_default()
            .await
            .context("failed to create K8s client (is KUBECONFIG set?)")?;

        tracing::info!("connected to Kubernetes cluster");

        Ok(Self {
            client,
            agent_image,
            runtime_classes,
        })
    }

    /// Derive the tenant namespace from the authenticated `req.tenant_id` field.
    ///
    /// This MUST NOT fall back to `req.env["LANTERN_TENANT_ID"]` — the env map
    /// is caller-supplied and could be used to smuggle a victim tenant's id.
    /// An empty `tenant_id` indicates a bug upstream (the spawn gate in
    /// `spawn_to_schedule` rejects empty values before reaching here), so we
    /// return `Err` rather than silently using a shared "default" namespace.
    fn namespace_for(req: &ScheduleRequest) -> Result<String> {
        if req.tenant_id.is_empty() {
            anyhow::bail!(
                "BUG: ScheduleRequest.tenant_id is empty — namespace derivation refused \
                 to avoid cross-tenant namespace escape; the spawn gate should have \
                 rejected this request before it reached the K8s backend"
            );
        }
        // Constrain the shape before interpolating into a namespace name. The
        // value's origin is already trusted (authenticated control-plane), but a
        // non-DNS-1123 tenant_id would otherwise produce an opaque late failure
        // at jobs.create. Reject anything outside [a-z0-9-] / >53 chars early
        // and clearly.
        //
        // FIX 7(a): The `lantern-t-` prefix is 10 chars; K8s name limit is 63.
        //   Max allowed tenant_id length = 63 - 10 = 53.
        // FIX 7(b): DNS-1123 requires the first and last character to be
        //   alphanumeric (no leading/trailing dashes).
        const PREFIX_LEN: usize = "lantern-t-".len(); // 10
        const MAX_TENANT_ID_LEN: usize = 63 - PREFIX_LEN; // 53

        let id = req.tenant_id.as_bytes();
        let invalid = req.tenant_id.len() > MAX_TENANT_ID_LEN
            || !id
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
            || id.first().map(|b| *b == b'-').unwrap_or(false)
            || id.last().map(|b| *b == b'-').unwrap_or(false);

        if invalid {
            anyhow::bail!(
                "ScheduleRequest.tenant_id {:?} is not a valid DNS-1123 label \
                 ([a-z0-9][a-z0-9-]*[a-z0-9], ≤{MAX_TENANT_ID_LEN} chars, no leading/trailing \
                 dash); refusing to derive a namespace from it",
                req.tenant_id
            );
        }
        Ok(format!("lantern-t-{}", req.tenant_id))
    }

    /// Parse timeout string (e.g., "300s", "5m") to seconds for the active deadline.
    fn parse_timeout_seconds(timeout: &str) -> Option<i64> {
        let timeout = timeout.trim();
        if timeout.ends_with('s') {
            timeout.trim_end_matches('s').parse::<i64>().ok()
        } else if timeout.ends_with('m') {
            timeout
                .trim_end_matches('m')
                .parse::<i64>()
                .ok()
                .map(|m| m * 60)
        } else if timeout.ends_with('h') {
            timeout
                .trim_end_matches('h')
                .parse::<i64>()
                .ok()
                .map(|h| h * 3600)
        } else {
            timeout.parse::<i64>().ok()
        }
    }

    /// Build the K8s Job spec for a schedule request. Thin wrapper over the
    /// pure [`build_job`] free function so the live `schedule` path reads
    /// straight-line while the manifest generation stays unit-testable.
    fn build_job(&self, req: &ScheduleRequest, job_name: &str, namespace: &str) -> Result<Job> {
        build_job(
            req,
            &self.agent_image,
            job_name,
            namespace,
            &self.runtime_classes,
        )
    }

    /// Wait for the job's pod to be scheduled and running (or failed).
    async fn wait_for_pod(&self, namespace: &str, job_name: &str) -> Result<String> {
        wait_for_pod_impl(&self.client, namespace, job_name).await
    }

    /// Resolve a `handle_id` of the form `"namespace/job_name"` to
    /// `(namespace, job_name, pod_name)`.  Looks up the pod via the job label.
    async fn resolve_pod(&self, handle_id: &str) -> Result<(String, String, String)> {
        let (namespace, job_name) = handle_id
            .split_once('/')
            .context("invalid handle_id: expected namespace/job_name")?;

        let pods: Api<Pod> = Api::namespaced(self.client.clone(), namespace);
        let label_selector = format!("job-name={job_name}");
        let list = pods
            .list(&ListParams::default().labels(&label_selector))
            .await
            .context("list pods for job")?;

        let pod_name = list
            .items
            .first()
            .and_then(|p| p.metadata.name.as_deref())
            .context("no pod found for job")?
            .to_string();

        Ok((namespace.to_string(), job_name.to_string(), pod_name))
    }
}

/// Map an `IsolationClass` to the pod `runtimeClassName` per ADR-0009.
///
/// Returns `(Option<String>, bool)` where the second element signals that the
/// caller should emit a `tracing::warn!` when STANDARD/DEVCONTAINER degrade to
/// runc because gVisor is not configured AND `allow_runc_standard` is set.
/// The warn flag is NOT set for TRUSTED (runc is its canonical substrate).
///
/// Callers that receive `None` for UNTRUSTED or HOSTILE must refuse the
/// request (fail-closed) — this function itself does not enforce that; the
/// enforcement is in [`k8s_satisfies_isolation`].  STANDARD/UNSPECIFIED/
/// DEVCONTAINER with no gVisor and no `allow_runc_standard` are also refused
/// by [`k8s_satisfies_isolation`]; they should never reach here in that state.
fn isolation_to_runtime_class(
    class: IsolationClass,
    cfg: &RuntimeClassConfig,
) -> (Option<String>, bool) {
    match class {
        // TRUSTED → bare runc. Deliberate; no warn needed.
        IsolationClass::Trusted => (None, false),

        // STANDARD/UNSPECIFIED → gVisor if available, else runc.
        // Runc is only reached when `allow_runc_standard` (gate enforced in
        // `k8s_satisfies_isolation`); caller emits warn in that case.
        IsolationClass::Standard | IsolationClass::Unspecified => match &cfg.gvisor {
            Some(name) => (Some(name.clone()), false),
            None => (None, true), // degraded to runc; caller warns
        },

        // UNTRUSTED → gVisor required. Caller must refuse when None.
        IsolationClass::Untrusted => (cfg.gvisor.clone(), false),

        // HOSTILE → Kata required. Caller must refuse when None.
        IsolationClass::Hostile => (cfg.kata.clone(), false),

        // WASM → use the wasm RuntimeClass if configured, else None.
        // None is only reachable when `allow_runc_standard` (gate enforced).
        IsolationClass::Wasm => (cfg.wasm.clone(), false),

        // DEVCONTAINER → gVisor if available, else runc with a warning.
        // Runc only reachable when `allow_runc_standard`.
        IsolationClass::Devcontainer => match &cfg.gvisor {
            Some(name) => (Some(name.clone()), false),
            None => (None, true),
        },
    }
}

/// Pure K8s Job manifest builder. Takes the agent image explicitly so it needs
/// no `K8sBackend`/`Client` — fully unit-testable without a live cluster.
///
/// # Errors
///
/// Returns `Err` if `req.isolation_class` is `Untrusted` or `Hostile` and the
/// required hardened RuntimeClass is not configured in `runtime_classes`. This
/// is a second line of defense: `K8sBackend::satisfies_isolation` is the primary
/// gate in `choose_backend`, but `build_job` also refuses so that a future caller
/// that bypasses the gate (e.g. warm-pool plumbing) cannot accidentally emit a
/// bare runc pod for a hard isolation class.
fn build_job(
    req: &ScheduleRequest,
    agent_image: &str,
    job_name: &str,
    namespace: &str,
    runtime_classes: &RuntimeClassConfig,
) -> Result<Job> {
    let mut env_vars: Vec<EnvVar> = vec![
        EnvVar {
            name: "LANTERN_RUN_ID".to_string(),
            value: Some(req.run_id.clone()),
            ..Default::default()
        },
        EnvVar {
            name: "LANTERN_BUNDLE_URI".to_string(),
            value: Some(req.bundle_uri.clone()),
            ..Default::default()
        },
        EnvVar {
            name: "LANTERN_INPUT".to_string(),
            value: Some(serde_json::to_string(&req.input).unwrap_or_default()),
            ..Default::default()
        },
    ];

    for (k, v) in &req.env {
        env_vars.push(EnvVar {
            name: k.clone(),
            value: Some(v.clone()),
            ..Default::default()
        });
    }

    // Secret refs become env vars pointing to vault references.
    for secret in &req.secrets {
        env_vars.push(EnvVar {
            name: secret.env_var.clone(),
            value: Some(format!("lantern.secret/{}", secret.vault_ref)),
            ..Default::default()
        });
    }

    let mut resource_requests = BTreeMap::new();
    let mut resource_limits = BTreeMap::new();

    if !req.limits.cpu.is_empty() {
        resource_requests.insert("cpu".to_string(), Quantity(req.limits.cpu.clone()));
        resource_limits.insert("cpu".to_string(), Quantity(req.limits.cpu.clone()));
    }
    if !req.limits.memory.is_empty() {
        resource_requests.insert("memory".to_string(), Quantity(req.limits.memory.clone()));
        resource_limits.insert("memory".to_string(), Quantity(req.limits.memory.clone()));
    }
    if !req.limits.gpu.is_empty() {
        resource_limits.insert(
            "nvidia.com/gpu".to_string(),
            Quantity(req.limits.gpu.clone()),
        );
    }

    let active_deadline = K8sBackend::parse_timeout_seconds(&req.limits.timeout);

    // FIX 3: honour req.image when provided and non-digest, mirroring Docker/Kata.
    // A bare digest (starts with "sha256:") is the bundle digest, not an image
    // override — fall back to agent_image in that case.
    let img = if req.image.is_empty() || req.image.starts_with("sha256:") {
        agent_image
    } else {
        req.image.as_str()
    };

    let container = Container {
        name: "agent-runner".to_string(),
        image: Some(img.to_string()),
        env: Some(env_vars),
        resources: Some(ResourceRequirements {
            requests: Some(resource_requests),
            limits: Some(resource_limits),
            ..Default::default()
        }),
        security_context: Some(container_security_context()),
        ports: Some(vec![ContainerPort {
            container_port: 8080,
            name: Some("agent".to_string()),
            ..Default::default()
        }]),
        ..Default::default()
    };

    let labels = job_labels(req);

    // Resolve the runtimeClassName from the isolation class. The warn flag
    // fires when STANDARD/DEVCONTAINER gracefully degrades to runc.
    let (runtime_class_name, should_warn) =
        isolation_to_runtime_class(req.isolation_class, runtime_classes);

    // Fail-closed second gate: defense-in-depth behind `k8s_satisfies_isolation`.
    // Any future code path that calls `build_job` directly (e.g. warm-pool
    // plumbing) cannot silently produce an under-isolated pod.
    match req.isolation_class {
        IsolationClass::Untrusted if runtime_class_name.is_none() => {
            bail!(
                "UNTRUSTED workload requires the gVisor RuntimeClass but \
                 LANTERN_RUNTIMECLASS_GVISOR is not configured (or is empty); \
                 refusing to emit a bare runc pod"
            );
        }
        IsolationClass::Hostile if runtime_class_name.is_none() => {
            bail!(
                "HOSTILE workload requires the Kata RuntimeClass but \
                 LANTERN_RUNTIMECLASS_KATA is not configured (or is empty); \
                 refusing to emit a bare runc pod"
            );
        }
        IsolationClass::Standard | IsolationClass::Unspecified | IsolationClass::Devcontainer
            if runtime_class_name.is_none() && !runtime_classes.allow_runc_standard =>
        {
            bail!(
                "{:?} workload requires gVisor (LANTERN_RUNTIMECLASS_GVISOR) or the \
                 LANTERN_ALLOW_RUNC_STANDARD=1 opt-in to run on bare runc; \
                 refusing to emit an under-isolated pod",
                req.isolation_class
            );
        }
        IsolationClass::Wasm
            if runtime_class_name.is_none() && !runtime_classes.allow_runc_standard =>
        {
            bail!(
                "WASM workload requires the Wasm RuntimeClass (LANTERN_RUNTIMECLASS_WASM) \
                 or the LANTERN_ALLOW_RUNC_STANDARD=1 opt-in; \
                 refusing to emit a bare runc pod"
            );
        }
        _ => {}
    }

    if should_warn {
        // FIX 6: message correctly covers all classes that can reach runc.
        tracing::warn!(
            isolation_class = ?req.isolation_class,
            "LANTERN_RUNTIMECLASS_GVISOR not configured; degrading to runc (bare shared-kernel). \
             STANDARD/DEVCONTAINER workloads tolerate this (LANTERN_ALLOW_RUNC_STANDARD=1 set) \
             but gVisor is strongly recommended.",
        );
    }

    Ok(Job {
        metadata: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta {
            name: Some(job_name.to_string()),
            namespace: Some(namespace.to_string()),
            labels: Some(labels.clone()),
            ..Default::default()
        },
        spec: Some(JobSpec {
            active_deadline_seconds: active_deadline,
            backoff_limit: Some(0), // No retries; the workflow engine handles retries.
            template: PodTemplateSpec {
                metadata: Some(k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta {
                    labels: Some(labels),
                    ..Default::default()
                }),
                spec: Some(PodSpec {
                    containers: vec![container],
                    restart_policy: Some("Never".to_string()),
                    service_account_name: Some("lantern-agent-runner".to_string()),
                    automount_service_account_token: Some(false),
                    security_context: Some(pod_security_context()),
                    runtime_class_name,
                    // Explicit host-namespace denial: defence-in-depth against
                    // mis-configured admission webhooks that might forget to
                    // enforce these.  K8s defaults are already false but being
                    // explicit makes the intent auditable in the manifest.
                    host_network: Some(false),
                    host_pid: Some(false),
                    host_ipc: Some(false),
                    // ClusterFirst ensures DNS works correctly even with the
                    // default-deny egress NetworkPolicy (port 53 is allowed).
                    dns_policy: Some("ClusterFirst".to_string()),
                    // Node affinity for hardened isolation classes: prevent a
                    // pod that requires gVisor/Kata from scheduling onto a node
                    // that merely references the RuntimeClass by name but does
                    // not actually have the handler installed.
                    affinity: node_affinity_for_isolation(req.isolation_class, runtime_classes),
                    ..Default::default()
                }),
            },
            ..Default::default()
        }),
        ..Default::default()
    })
}

/// Wait for the job's pod to be scheduled and running (or failed).
async fn wait_for_pod_impl(client: &Client, namespace: &str, job_name: &str) -> Result<String> {
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client.clone(), namespace);

    let label_selector = format!("job-name={job_name}");

    // Poll for up to 120 seconds for the pod to appear and start.
    for _ in 0..120 {
        let list = pods
            .list(&ListParams::default().labels(&label_selector))
            .await
            .context("failed to list pods for job")?;

        if let Some(pod) = list.items.first() {
            let pod_name = pod
                .metadata
                .name
                .as_deref()
                .unwrap_or("unknown")
                .to_string();

            if let Some(status) = &pod.status
                && let Some(phase) = &status.phase
            {
                match phase.as_str() {
                    "Running" | "Succeeded" | "Failed" => {
                        return Ok(pod_name);
                    }
                    _ => {}
                }
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }

    bail!("timed out waiting for pod to start for job {job_name}")
}

/// Pure capability check for the K8s backend — extracted so it can be unit-tested
/// without constructing a live `K8sBackend` (which requires a valid `kube::Client`).
///
/// Fail-closed by default:
/// - UNTRUSTED: requires gVisor.
/// - HOSTILE: requires Kata.
/// - STANDARD/UNSPECIFIED/DEVCONTAINER: requires gVisor OR `allow_runc_standard`.
/// - WASM: requires wasm RuntimeClass OR `allow_runc_standard`.
/// - TRUSTED: always accepted (runc is its canonical substrate).
pub(crate) fn k8s_satisfies_isolation(cfg: &RuntimeClassConfig, class: IsolationClass) -> bool {
    match class {
        IsolationClass::Untrusted => cfg.gvisor.is_some(),
        IsolationClass::Hostile => cfg.kata.is_some(),
        IsolationClass::Standard | IsolationClass::Unspecified | IsolationClass::Devcontainer => {
            cfg.gvisor.is_some() || cfg.allow_runc_standard
        }
        IsolationClass::Wasm => cfg.wasm.is_some() || cfg.allow_runc_standard,
        // TRUSTED → bare runc is its canonical substrate; always accepted.
        IsolationClass::Trusted => true,
    }
}

#[async_trait]
impl RuntimeBackend for K8sBackend {
    async fn schedule(&self, req: &ScheduleRequest) -> Result<Handle> {
        let start = Instant::now();
        let namespace = Self::namespace_for(req)?;
        let job_name = format!(
            "lantern-run-{}-{}",
            &req.run_id[..8.min(req.run_id.len())],
            &Uuid::new_v4().to_string()[..8]
        );

        tracing::info!(
            job_name = %job_name,
            namespace = %namespace,
            run_id = %req.run_id,
            "creating K8s job"
        );

        // Emit the default-deny-egress NetworkPolicy BEFORE the Job so the
        // pod never runs without its egress fence in place (fail-closed).
        // NETWORK_OPEN intentionally emits no policy (trusted/wasm only).
        let policy_created = if let Some(policy) = build_network_policy(req, &job_name, &namespace)
        {
            let policies: Api<K8sNetworkPolicy> = Api::namespaced(self.client.clone(), &namespace);
            policies
                .create(&PostParams::default(), &policy)
                .await
                .context("failed to create K8s NetworkPolicy (egress fence)")?;
            tracing::info!(
                job_name = %job_name,
                namespace = %namespace,
                "created default-deny-egress NetworkPolicy"
            );
            true
        } else {
            false
        };

        // Helper: best-effort delete the egress NetworkPolicy on error paths.
        // Mirrors the cleanup in `cancel`; ignores NotFound (policy may not
        // have been created or was already removed).
        let cleanup_policy = |client: Client, ns: String, jn: String| async move {
            let policies: Api<K8sNetworkPolicy> = Api::namespaced(client, &ns);
            if let Err(e) = policies
                .delete(&network_policy_name(&jn), &DeleteParams::default())
                .await
            {
                tracing::debug!(
                    error = %e,
                    job_name = %jn,
                    "best-effort cleanup: NetworkPolicy already absent or delete failed"
                );
            }
        };

        let jobs: Api<Job> = Api::namespaced(self.client.clone(), &namespace);
        let job = match self.build_job(req, &job_name, &namespace) {
            Ok(j) => j,
            Err(e) => {
                if policy_created {
                    cleanup_policy(self.client.clone(), namespace.clone(), job_name.clone()).await;
                }
                return Err(e);
            }
        };

        if let Err(e) = jobs.create(&PostParams::default(), &job).await {
            if policy_created {
                cleanup_policy(self.client.clone(), namespace.clone(), job_name.clone()).await;
            }
            return Err(e).context("failed to create K8s job");
        }

        // Wait for the pod to start running.
        let pod_name = match self.wait_for_pod(&namespace, &job_name).await {
            Ok(name) => name,
            Err(e) => {
                if policy_created {
                    cleanup_policy(self.client.clone(), namespace.clone(), job_name.clone()).await;
                }
                return Err(e);
            }
        };

        let cold_start_ms = start.elapsed().as_secs_f64() * 1000.0;

        tracing::info!(
            job_name = %job_name,
            pod_name = %pod_name,
            cold_start_ms = cold_start_ms,
            "K8s job scheduled and pod running"
        );

        // Use "namespace/job_name" as the handle ID so we can find it later.
        Ok(Handle {
            id: format!("{namespace}/{job_name}"),
            node_name: pod_name,
            cold_start_ms,
        })
    }

    async fn cancel(&self, handle_id: &str, reason: &str) -> Result<()> {
        let (namespace, job_name) = handle_id
            .split_once('/')
            .context("invalid handle_id format, expected namespace/job_name")?;

        tracing::info!(
            job_name = job_name,
            namespace = namespace,
            reason = reason,
            "cancelling K8s job"
        );

        let jobs: Api<Job> = Api::namespaced(self.client.clone(), namespace);

        let dp = DeleteParams {
            propagation_policy: Some(kube::api::PropagationPolicy::Foreground),
            ..Default::default()
        };

        jobs.delete(job_name, &dp)
            .await
            .context("failed to delete K8s job")?;

        // Best-effort teardown of the egress NetworkPolicy. The pod is already
        // gone; a lingering policy is harmless (it selects nothing) but we clean
        // it up to avoid namespace clutter. A missing policy is not an error
        // (NETWORK_OPEN jobs never create one).
        let policies: Api<K8sNetworkPolicy> = Api::namespaced(self.client.clone(), namespace);
        if let Err(e) = policies
            .delete(&network_policy_name(job_name), &DeleteParams::default())
            .await
        {
            tracing::debug!(error = %e, job_name = job_name, "no egress NetworkPolicy to delete");
        }

        tracing::info!(job_name = job_name, "K8s job deleted");
        Ok(())
    }

    async fn stream(&self, handle_id: &str) -> Result<BoxStream<'static, RuntimeEvent>> {
        let (namespace, job_name) = handle_id
            .split_once('/')
            .context("invalid handle_id format, expected namespace/job_name")?;

        // Find the pod for this job.
        let pods: Api<k8s_openapi::api::core::v1::Pod> =
            Api::namespaced(self.client.clone(), namespace);

        let label_selector = format!("job-name={job_name}");
        let list = pods
            .list(&ListParams::default().labels(&label_selector))
            .await
            .context("failed to list pods for job")?;

        let pod_name = list
            .items
            .first()
            .and_then(|p| p.metadata.name.as_deref())
            .context("no pod found for job")?
            .to_string();

        let log_params = LogParams {
            follow: true,
            timestamps: true,
            ..Default::default()
        };

        let log_stream = pods
            .log_stream(&pod_name, &log_params)
            .await
            .context("failed to open log stream")?;

        let (tx, rx) = tokio::sync::mpsc::channel::<RuntimeEvent>(256);
        let client = self.client.clone();
        let ns = namespace.to_string();
        let jn = job_name.to_string();

        tokio::spawn(async move {
            let mut lines_stream = log_stream.lines();

            while let Some(result) = lines_stream.next().await {
                match result {
                    Ok(line) => {
                        let event = parse_event_line(&line);
                        if tx.send(event).await.is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "K8s log stream error");
                        break;
                    }
                }
            }

            // Check job completion status.
            let jobs: Api<Job> = Api::namespaced(client, &ns);
            let exit_code = match jobs.get(&jn).await {
                Ok(job) => {
                    let status = job.status.as_ref();
                    if status.and_then(|s| s.succeeded).unwrap_or(0) > 0 {
                        0
                    } else {
                        1
                    }
                }
                Err(_) => -1,
            };

            let _ = tx
                .send(RuntimeEvent::Exited(RuntimeExited {
                    exit_code,
                    error: if exit_code != 0 {
                        format!("job exited with code {exit_code}")
                    } else {
                        String::new()
                    },
                }))
                .await;
        });

        Ok(Box::pin(ReceiverStream::new(rx)))
    }

    async fn snapshot(&self, _req: &SnapshotRequest) -> Result<SnapshotInfo> {
        bail!("snapshot is not supported for the K8s Job backend")
    }

    async fn restore(&self, _snapshot_uri: &str, _req: &RestoreRequest) -> Result<Handle> {
        bail!("restore is not supported for the K8s Job backend")
    }

    fn name(&self) -> &'static str {
        "k8s"
    }

    /// K8s can satisfy isolation via RuntimeClass tiering.
    ///
    /// - TRUSTED / STANDARD / UNSPECIFIED / WASM / DEVCONTAINER: always accepted
    ///   (STANDARD/DEVCONTAINER may degrade to runc when gVisor is unset, which
    ///   is allowed — a warning is emitted in `build_job`).
    /// - UNTRUSTED: only when the gVisor RuntimeClass is configured. Fail-closed
    ///   otherwise — a shared-kernel pod is NOT an acceptable substitute.
    /// - HOSTILE: only when the Kata RuntimeClass is configured. Fail-closed.
    fn satisfies_isolation(&self, class: IsolationClass) -> bool {
        k8s_satisfies_isolation(&self.runtime_classes, class)
    }

    /// Execute a one-shot command in the running pod for this job handle.
    ///
    /// Uses the kube `ws` feature (`Api::exec` / `AttachedProcess`) to attach
    /// to the pod's `agent-runner` container.  Collects stdout, stderr, and the
    /// exit code once the process completes.
    ///
    /// Requires the `ws` feature on the `kube` crate (added to Cargo.toml).
    async fn exec_command(
        &self,
        handle_id: &str,
        command: &str,
        argv: &[String],
    ) -> Result<ExecOutput> {
        let (namespace, _job_name, pod_name) = self.resolve_pod(handle_id).await?;

        let pods: Api<Pod> = Api::namespaced(self.client.clone(), &namespace);

        let mut cmd = vec![command.to_string()];
        cmd.extend_from_slice(argv);
        let cmd_refs: Vec<&str> = cmd.iter().map(String::as_str).collect();

        tracing::debug!(
            pod = %pod_name,
            namespace = %namespace,
            command = ?cmd_refs,
            "k8s exec_command"
        );

        let mut proc = pods
            .exec(
                &pod_name,
                cmd_refs,
                &AttachParams {
                    container: Some("agent-runner".to_string()),
                    stdout: true,
                    stderr: true,
                    stdin: false,
                    tty: false,
                    ..Default::default()
                },
            )
            .await
            .context("failed to exec into pod")?;

        // Collect stdout.
        let stdout_bytes = if let Some(stdout_stream) = proc.stdout() {
            let mut buf = Vec::new();
            let mut reader = tokio_util::io::ReaderStream::new(stdout_stream);
            while let Some(chunk) = reader.try_next().await? {
                buf.extend_from_slice(&chunk);
            }
            buf
        } else {
            vec![]
        };

        // Collect stderr.
        let stderr_bytes = if let Some(stderr_stream) = proc.stderr() {
            let mut buf = Vec::new();
            let mut reader = tokio_util::io::ReaderStream::new(stderr_stream);
            while let Some(chunk) = reader.try_next().await? {
                buf.extend_from_slice(&chunk);
            }
            buf
        } else {
            vec![]
        };

        // Wait for the process to finish and get the exit code.
        // take_status() returns Option<impl Future<Output = Option<Status>>>.
        // The inner Option<Status> is None if the channel was dropped before
        // the process sent its exit status.
        let exit_code = match proc.take_status() {
            None => -1,
            Some(status_fut) => {
                match status_fut.await {
                    Some(s) => {
                        // status field is "Success" for exit_code == 0;
                        // otherwise `code` carries the numeric exit code.
                        if s.status.as_deref() == Some("Success") {
                            0i32
                        } else {
                            s.code.unwrap_or(-1)
                        }
                    }
                    None => -1,
                }
            }
        };

        Ok(ExecOutput {
            stdout: stdout_bytes,
            stderr: stderr_bytes,
            exit_code,
        })
    }

    /// Return a resource-usage sample for this pod by querying the
    /// Kubernetes metrics-server API.
    ///
    /// Endpoint: `GET /apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods/{name}`
    ///
    /// If the metrics-server is not installed, the API server returns 404 /
    /// 503 with a message indicating the group is unavailable; we surface a
    /// clear "metrics.k8s.io unavailable" error in that case rather than an
    /// opaque transport error.
    async fn stats_sample(&self, handle_id: &str) -> Result<StatsSample> {
        let (namespace, _job_name, pod_name) = self.resolve_pod(handle_id).await?;

        // Build the raw request for the pod metrics resource.
        // `client.request::<T>` accepts `Request<Vec<u8>>` and deserializes
        // the response body into T — the cleanest path for non-standard API
        // groups (metrics.k8s.io) that don't have k8s-openapi generated types.
        let url = format!("/apis/metrics.k8s.io/v1beta1/namespaces/{namespace}/pods/{pod_name}");

        let req = http::Request::builder()
            .method(http::Method::GET)
            .uri(&url)
            .body(vec![])
            .context("build metrics request")?;

        let pod_metrics: PodMetrics = self.client.request(req).await.map_err(|e| {
            // Detect "group not found" style errors that indicate the
            // metrics-server is not installed on this cluster.
            let msg = e.to_string();
            if msg.contains("not found")
                || msg.contains("no matches for kind")
                || msg.contains("metrics.k8s.io")
                || msg.contains("ServiceUnavailable")
            {
                anyhow::anyhow!(
                    "metrics.k8s.io unavailable: metrics-server is not installed \
                         on this cluster (error: {msg})"
                )
            } else {
                anyhow::anyhow!("metrics API request failed: {msg}")
            }
        })?;

        // Sum usage across all containers in the pod.
        let mut vcpu_ms: i64 = 0;
        let mut memory_bytes: i64 = 0;

        for container in &pod_metrics.containers {
            vcpu_ms += parse_cpu_quantity_to_vcpu_ms(&container.usage.cpu);
            memory_bytes += parse_memory_quantity_to_bytes(&container.usage.memory);
        }

        Ok(StatsSample {
            vcpu_ms_used: vcpu_ms,
            memory_bytes,
            network_bytes_in: 0,  // not available from metrics-server
            network_bytes_out: 0, // not available from metrics-server
        })
    }
}

// ---------------------------------------------------------------------------
// Pure manifest generation (audit M4: prod-grade isolation for the K8s Job
// backend). These functions take only plain inputs and return k8s-openapi
// objects, so they are fully unit-testable WITHOUT a live cluster. Everything
// that needs the cluster (create/delete/list) stays in the async impl above,
// fail-closed behind the backend's availability gate in `service.rs`.
// ---------------------------------------------------------------------------

/// Label key whose value uniquely identifies a single run's pod. Used both on
/// the Job's pod template and as the NetworkPolicy `podSelector` so the egress
/// fence applies to exactly this run's pod and nothing else in the namespace.
const RUN_ID_LABEL: &str = "lantern.dev/run-id";

/// Stable name for a Job's egress NetworkPolicy. Derived from the job name so
/// `schedule` (create) and `cancel` (delete) agree without extra state.
fn network_policy_name(job_name: &str) -> String {
    format!("{job_name}-egress")
}

/// Build the standard label set for a run's Job + pod template.
fn job_labels(req: &ScheduleRequest) -> BTreeMap<String, String> {
    let mut labels = BTreeMap::new();
    labels.insert(
        "app.kubernetes.io/name".to_string(),
        "lantern-agent-runner".to_string(),
    );
    labels.insert(
        "app.kubernetes.io/managed-by".to_string(),
        "lantern-runtime-manager".to_string(),
    );
    labels.insert(RUN_ID_LABEL.to_string(), req.run_id.clone());
    labels.insert(
        "lantern.dev/isolation-class".to_string(),
        format!("{:?}", req.isolation_class).to_lowercase(),
    );
    labels
}

/// Container-level securityContext: hostile-workload hardening.
///
/// Drops ALL Linux capabilities, forbids privilege escalation, pins a non-root
/// UID, and makes the root filesystem read-only. This is the per-container half;
/// see [`pod_security_context`] for the pod-level seccomp profile.
// LINUX-ONLY: capability drop + non-root enforcement are Linux container
// semantics; meaningless on non-Linux nodes (which we never schedule onto).
fn container_security_context() -> SecurityContext {
    SecurityContext {
        read_only_root_filesystem: Some(true),
        run_as_non_root: Some(true),
        run_as_user: Some(1000),
        allow_privilege_escalation: Some(false),
        privileged: Some(false),
        capabilities: Some(Capabilities {
            drop: Some(vec!["ALL".to_string()]),
            add: None,
        }),
        ..Default::default()
    }
}

/// Pod-level securityContext: seccomp `RuntimeDefault` + non-root enforcement.
///
/// The seccomp profile filters the syscall surface to the container runtime's
/// vetted default set — the single highest-leverage kernel-attack-surface
/// reduction available without bare-metal KVM.
// LINUX-ONLY: seccomp is a Linux kernel feature.
fn pod_security_context() -> PodSecurityContext {
    PodSecurityContext {
        run_as_non_root: Some(true),
        seccomp_profile: Some(SeccompProfile {
            type_: "RuntimeDefault".to_string(),
            localhost_profile: None,
        }),
        ..Default::default()
    }
}

/// Build a `requiredDuringSchedulingIgnoredDuringExecution` node affinity that
/// restricts an UNTRUSTED or HOSTILE pod to nodes bearing the label
/// `lantern.dev/runtimeclass=<value>`.
///
/// This is a second line of defence behind the RuntimeClass mechanism: it
/// prevents the scheduler from placing the pod on a node that holds the
/// RuntimeClass object in the API but does NOT actually have the handler
/// installed — which would cause the pod to fail at kubelet-pull time rather
/// than at scheduling time.
///
/// Returns `None` for TRUSTED / STANDARD / WASM / DEVCONTAINER / UNSPECIFIED
/// unless a label value is explicitly configured for those tiers (none are by
/// default).
///
/// # Node label convention
///
/// Cluster operators must label their hardened nodes with:
///
/// ```text
/// kubectl label node <node> lantern.dev/runtimeclass=gvisor
/// kubectl label node <node> lantern.dev/runtimeclass=kata
/// ```
///
/// The label key is `lantern.dev/runtimeclass`; the value comes from
/// [`RuntimeClassConfig::node_label_gvisor`] / [`RuntimeClassConfig::node_label_kata`]
/// (defaults: `"gvisor"` / `"kata"`).
fn node_affinity_for_isolation(
    class: IsolationClass,
    cfg: &RuntimeClassConfig,
) -> Option<Affinity> {
    const NODE_LABEL_KEY: &str = "lantern.dev/runtimeclass";

    let label_value: &str = match class {
        IsolationClass::Untrusted => {
            // Use configured value or fall back to "gvisor". We only emit the
            // affinity when the gVisor RuntimeClass is actually configured
            // (otherwise the fail-closed gate in build_job already refused the
            // request before we reach here).
            cfg.gvisor.as_deref()?; // bail if gVisor not configured
            cfg.node_label_gvisor
                .as_deref()
                .unwrap_or("gvisor")
        }
        IsolationClass::Hostile => {
            cfg.kata.as_deref()?; // bail if Kata not configured
            cfg.node_label_kata
                .as_deref()
                .unwrap_or("kata")
        }
        // TRUSTED / STANDARD / UNSPECIFIED / WASM / DEVCONTAINER: no node
        // affinity requirement by default.  Operators may add custom affinity
        // via admission webhooks or OPA if needed; that is out of scope here.
        _ => return None,
    };

    let requirement = NodeSelectorRequirement {
        key: NODE_LABEL_KEY.to_string(),
        operator: "In".to_string(),
        values: Some(vec![label_value.to_string()]),
    };
    let term = NodeSelectorTerm {
        match_expressions: Some(vec![requirement]),
        match_fields: None,
    };
    let node_selector = NodeSelector {
        node_selector_terms: vec![term],
    };
    Some(Affinity {
        node_affinity: Some(NodeAffinity {
            required_during_scheduling_ignored_during_execution: Some(node_selector),
            preferred_during_scheduling_ignored_during_execution: None,
        }),
        pod_affinity: None,
        pod_anti_affinity: None,
    })
}

/// True when `pattern` is a CIDR block (vs. a domain). Only CIDR patterns can
/// be expressed as NetworkPolicy `ipBlock` peers; domains are enforced in-VM by
/// the harness against the same allowlist.
fn is_cidr(pattern: &str) -> bool {
    match pattern.split_once('/') {
        Some((addr, prefix)) => {
            prefix.parse::<u8>().is_ok() && (addr.parse::<std::net::IpAddr>().is_ok())
        }
        None => false,
    }
}

/// The DNS-allow egress rule every fenced pod gets: UDP+TCP to port 53 so name
/// resolution works (and the harness can resolve allowlisted domains). Without
/// this, a default-deny policy would break DNS and the pod couldn't even fail
/// cleanly.
fn dns_egress_rule() -> NetworkPolicyEgressRule {
    NetworkPolicyEgressRule {
        to: None, // any peer, but only on port 53 — i.e. cluster DNS
        ports: Some(vec![
            NetworkPolicyPort {
                protocol: Some("UDP".to_string()),
                port: Some(IntOrString::Int(53)),
                end_port: None,
            },
            NetworkPolicyPort {
                protocol: Some("TCP".to_string()),
                port: Some(IntOrString::Int(53)),
                end_port: None,
            },
        ]),
    }
}

/// Build the default-deny-egress NetworkPolicy for a run's pod, or `None` when
/// the network class is `Open` (trusted/wasm only — no fence emitted).
///
/// Semantics:
/// - `policyTypes: [Egress]` with a `podSelector` matching exactly this run's
///   pod → default-deny all egress for that pod.
/// - Always allow DNS (port 53) so name resolution works.
/// - For `AllowlistDomain`/`TenantVpc`, additionally allow egress to each CIDR
///   in `egress_rules` as an `ipBlock` peer. Domain patterns are NOT expressible
///   as K8s peers; they stay enforced in-VM by the harness.
/// - `None` class → DNS only (no other egress).
fn build_network_policy(
    req: &ScheduleRequest,
    job_name: &str,
    namespace: &str,
) -> Option<K8sNetworkPolicy> {
    if matches!(req.network_policy, NetworkPolicyClass::Open) {
        return None;
    }

    let mut egress = vec![dns_egress_rule()];

    if matches!(
        req.network_policy,
        NetworkPolicyClass::AllowlistDomain | NetworkPolicyClass::TenantVpc
    ) {
        let cidr_peers: Vec<NetworkPolicyPeer> = req
            .egress_rules
            .iter()
            .filter(|r| is_cidr(&r.pattern))
            .map(|r| NetworkPolicyPeer {
                ip_block: Some(IPBlock {
                    cidr: r.pattern.clone(),
                    except: None,
                }),
                namespace_selector: None,
                pod_selector: None,
            })
            .collect();

        if !cidr_peers.is_empty() {
            egress.push(NetworkPolicyEgressRule {
                to: Some(cidr_peers),
                ports: None, // ports/methods enforced in-VM by the harness
            });
        }
    }

    let mut selector_labels = BTreeMap::new();
    selector_labels.insert(RUN_ID_LABEL.to_string(), req.run_id.clone());

    Some(K8sNetworkPolicy {
        metadata: ObjectMeta {
            name: Some(network_policy_name(job_name)),
            namespace: Some(namespace.to_string()),
            labels: Some(job_labels(req)),
            ..Default::default()
        },
        spec: Some(NetworkPolicySpec {
            pod_selector: LabelSelector {
                match_labels: Some(selector_labels),
                match_expressions: None,
            },
            // Both Ingress AND Egress in policyTypes with an empty ingress rule
            // list → default-deny ALL inbound traffic to the pod.  The existing
            // egress allow-rules (DNS carve-out + CIDR allowlist) are unchanged.
            // Rationale: agent pods must never be reachable from inside the
            // cluster; lateral movement from a compromised pod is blocked here.
            policy_types: Some(vec!["Ingress".to_string(), "Egress".to_string()]),
            egress: Some(egress),
            // Explicit empty list → deny-all ingress (K8s spec §4.3.1).
            // `None` would mean "not selected by this policy" (no-op for ingress).
            ingress: Some(vec![]),
        }),
    })
}

// ---------------------------------------------------------------------------
// Quantity parsers for metrics-server responses (pure, unit-testable)
// ---------------------------------------------------------------------------

/// Parse a Kubernetes CPU quantity string (from metrics-server) to
/// vcpu-milliseconds.  The metrics-server reports instantaneous CPU usage in
/// nanocores (e.g. `"250000000n"` = 250 millicores = 250 ms/s).
///
/// Supported suffixes: `n` (nanocores), `m` (millicores), none (whole cores).
/// Returns `0` for empty / unrecognised inputs.
fn parse_cpu_quantity_to_vcpu_ms(cpu: &str) -> i64 {
    if cpu.is_empty() {
        return 0;
    }
    if let Some(n_str) = cpu.strip_suffix('n') {
        // nanocores → vcpu-ms: 1 vcpu = 1_000_000_000 ns/s = 1_000 ms/s
        // nanocores ÷ 1_000_000 ≈ vcpu-ms (per second, which is what the
        // metrics-server "usage" snapshot represents).
        n_str.parse::<i64>().unwrap_or(0) / 1_000_000
    } else if let Some(m_str) = cpu.strip_suffix('m') {
        // millicores → vcpu-ms (1 millicore = 1 ms of 1 vCPU per second)
        m_str.parse::<i64>().unwrap_or(0)
    } else {
        // whole cores
        cpu.parse::<i64>().unwrap_or(0) * 1_000
    }
}

/// Parse a Kubernetes memory quantity string (from metrics-server) to bytes.
///
/// Supported suffixes: `Ki`, `Mi`, `Gi`, `K`, `M`, `G`, none (bytes).
/// Returns `0` for empty / unrecognised inputs.
fn parse_memory_quantity_to_bytes(mem: &str) -> i64 {
    if mem.is_empty() {
        return 0;
    }
    if let Some(s) = mem.strip_suffix("Ki") {
        s.parse::<i64>().unwrap_or(0) * 1_024
    } else if let Some(s) = mem.strip_suffix("Mi") {
        s.parse::<i64>().unwrap_or(0) * 1_024 * 1_024
    } else if let Some(s) = mem.strip_suffix("Gi") {
        s.parse::<i64>().unwrap_or(0) * 1_024 * 1_024 * 1_024
    } else if let Some(s) = mem.strip_suffix('K') {
        s.parse::<i64>().unwrap_or(0) * 1_000
    } else if let Some(s) = mem.strip_suffix('M') {
        s.parse::<i64>().unwrap_or(0) * 1_000_000
    } else if let Some(s) = mem.strip_suffix('G') {
        s.parse::<i64>().unwrap_or(0) * 1_000_000_000
    } else {
        mem.parse::<i64>().unwrap_or(0)
    }
}

/// Parse a container log line, looking for structured Lantern events.
fn parse_event_line(line: &str) -> RuntimeEvent {
    const EVENT_PREFIX: &str = "__LANTERN_EVENT__:";

    if let Some(json_str) = line.strip_prefix(EVENT_PREFIX) {
        match serde_json::from_str::<RuntimeEvent>(json_str.trim()) {
            Ok(event) => return event,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "failed to parse structured event from K8s logs"
                );
            }
        }
    }

    RuntimeEvent::Log(LogLine {
        level: "info".to_string(),
        message: line.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::{EgressRule, IsolationClass, ResourceLimits};
    use std::collections::HashMap;

    fn req_with(network: NetworkPolicyClass, egress: Vec<EgressRule>) -> ScheduleRequest {
        ScheduleRequest {
            run_id: "run-abc12345-def".to_string(),
            tenant_id: "acme".to_string(),
            bundle_uri: "sha256:deadbeef".to_string(),
            bundle_digest: vec![],
            isolation_class: IsolationClass::Untrusted,
            limits: ResourceLimits::default(),
            env: HashMap::new(),
            secrets: vec![],
            input: serde_json::Value::Null,
            command: vec![],
            args: vec![],
            image: "python:3.11-slim".to_string(),
            network_policy: network,
            egress_rules: egress,
        }
    }

    fn egress(pattern: &str) -> EgressRule {
        EgressRule {
            pattern: pattern.to_string(),
            http_methods: vec![],
            rate_bps: 0,
        }
    }

    // -- container securityContext -----------------------------------------

    #[test]
    fn container_security_context_drops_all_caps_and_hardens() {
        let sc = container_security_context();
        assert_eq!(sc.read_only_root_filesystem, Some(true));
        assert_eq!(sc.run_as_non_root, Some(true));
        assert_eq!(sc.allow_privilege_escalation, Some(false));
        assert_eq!(sc.privileged, Some(false));
        let caps = sc.capabilities.expect("capabilities set");
        assert_eq!(caps.drop, Some(vec!["ALL".to_string()]));
        assert!(caps.add.is_none(), "must not add any capability back");
    }

    // -- pod securityContext (seccomp) -------------------------------------

    #[test]
    fn pod_security_context_uses_seccomp_runtime_default() {
        let psc = pod_security_context();
        assert_eq!(psc.run_as_non_root, Some(true));
        let seccomp = psc.seccomp_profile.expect("seccomp profile set");
        assert_eq!(seccomp.type_, "RuntimeDefault");
        assert!(seccomp.localhost_profile.is_none());
    }

    // -- whole-Job assembly carries the hardened contexts ------------------

    #[test]
    fn build_job_wires_hardened_security_contexts_and_no_token() {
        // The pure `build_job` free fn needs no Client, so we assert on the
        // ACTUAL produced Job (not just the helper outputs).
        // req_with uses IsolationClass::Untrusted, so we must supply gVisor config
        // or build_job returns Err (the new fail-closed second gate).
        let req = req_with(NetworkPolicyClass::AllowlistDomain, vec![]);
        let job = build_job(
            &req,
            "ghcr.io/lantern/runner:v1",
            "job-1",
            "lantern-t-acme",
            &RuntimeClassConfig {
                gvisor: Some("gvisor".to_string()),
                kata: None,
                wasm: None,
                allow_runc_standard: false,
                ..Default::default()
            },
        )
        .expect("build_job should succeed when gVisor is configured for UNTRUSTED");

        let pod_spec = job
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
            .expect("pod spec");

        // No retries — the workflow engine owns retry semantics.
        assert_eq!(job.spec.as_ref().unwrap().backoff_limit, Some(0));

        // Service account token must NOT be auto-mounted.
        assert_eq!(pod_spec.automount_service_account_token, Some(false));
        assert_eq!(pod_spec.restart_policy.as_deref(), Some("Never"));

        // Pod-level seccomp RuntimeDefault.
        let psc = pod_spec
            .security_context
            .as_ref()
            .expect("pod securityContext");
        assert_eq!(
            psc.seccomp_profile.as_ref().map(|p| p.type_.as_str()),
            Some("RuntimeDefault")
        );
        assert_eq!(psc.run_as_non_root, Some(true));

        // Container-level hardening.
        let container = &pod_spec.containers[0];
        // req_with sets req.image = "python:3.11-slim", so FIX 3 picks that over
        // the agent_image argument.
        assert_eq!(container.image.as_deref(), Some("python:3.11-slim"));
        let csc = container
            .security_context
            .as_ref()
            .expect("container securityContext");
        assert_eq!(csc.read_only_root_filesystem, Some(true));
        assert_eq!(csc.run_as_non_root, Some(true));
        assert_eq!(csc.allow_privilege_escalation, Some(false));
        assert_eq!(csc.privileged, Some(false));
        assert_eq!(
            csc.capabilities.as_ref().and_then(|c| c.drop.clone()),
            Some(vec!["ALL".to_string()])
        );

        // Pod template carries the run-id selector label so the NetworkPolicy
        // podSelector matches exactly this pod.
        let tmpl_labels = job
            .spec
            .as_ref()
            .unwrap()
            .template
            .metadata
            .as_ref()
            .and_then(|m| m.labels.as_ref())
            .expect("template labels");
        assert_eq!(
            tmpl_labels.get(RUN_ID_LABEL),
            Some(&"run-abc12345-def".to_string())
        );
    }

    // -- NetworkPolicy generation ------------------------------------------

    #[test]
    fn network_policy_is_default_deny_egress_with_dns() {
        let req = req_with(NetworkPolicyClass::AllowlistDomain, vec![]);
        let np = build_network_policy(&req, "lantern-run-abc-001", "lantern-t-acme")
            .expect("allowlist class must emit a policy");

        let meta = &np.metadata;
        assert_eq!(meta.name.as_deref(), Some("lantern-run-abc-001-egress"));
        assert_eq!(meta.namespace.as_deref(), Some("lantern-t-acme"));

        let spec = np.spec.expect("spec");
        // Both Ingress and Egress selected → default-deny all inbound.
        assert_eq!(
            spec.policy_types,
            Some(vec!["Ingress".to_string(), "Egress".to_string()])
        );
        // Empty ingress rule list = deny-all inbound (K8s spec §4.3.1).
        assert_eq!(
            spec.ingress.as_deref(),
            Some(&[] as &[NetworkPolicyIngressRule]),
            "empty ingress list must be present to deny all inbound traffic"
        );

        // Pod selector targets exactly this run's pod.
        assert_eq!(
            spec.pod_selector
                .match_labels
                .as_ref()
                .and_then(|m| m.get(RUN_ID_LABEL)),
            Some(&"run-abc12345-def".to_string())
        );

        // DNS must be allowed (UDP+TCP 53) so default-deny doesn't break resolution.
        let egress = spec.egress.expect("egress rules");
        let dns = &egress[0];
        let ports = dns.ports.as_ref().expect("dns ports");
        let port_protos: Vec<(&str, &IntOrString)> = ports
            .iter()
            .map(|p| {
                (
                    p.protocol.as_deref().unwrap_or(""),
                    p.port.as_ref().unwrap(),
                )
            })
            .collect();
        assert!(port_protos.contains(&("UDP", &IntOrString::Int(53))));
        assert!(port_protos.contains(&("TCP", &IntOrString::Int(53))));
        assert!(dns.to.is_none(), "DNS rule allows any peer on port 53");
    }

    #[test]
    fn network_policy_allowlists_cidr_peers_only() {
        let req = req_with(
            NetworkPolicyClass::AllowlistDomain,
            vec![
                egress("10.0.0.0/8"),
                egress("*.openai.com"), // domain — not expressible as ipBlock
                egress("192.168.1.0/24"),
            ],
        );
        let np = build_network_policy(&req, "job-x", "ns").expect("policy");
        let egress_rules = np.spec.unwrap().egress.unwrap();

        // rule[0] = DNS, rule[1] = CIDR allow.
        assert_eq!(egress_rules.len(), 2);
        let peers = egress_rules[1].to.as_ref().expect("cidr peers");
        let cidrs: Vec<String> = peers
            .iter()
            .filter_map(|p| p.ip_block.as_ref().map(|b| b.cidr.clone()))
            .collect();
        assert_eq!(cidrs, vec!["10.0.0.0/8", "192.168.1.0/24"]);
    }

    #[test]
    fn network_policy_none_class_is_dns_only() {
        let req = req_with(NetworkPolicyClass::None, vec![egress("10.0.0.0/8")]);
        let np = build_network_policy(&req, "job-y", "ns").expect("policy");
        let egress_rules = np.spec.unwrap().egress.unwrap();
        // Only the DNS rule — no CIDR allow even though one was supplied.
        assert_eq!(egress_rules.len(), 1);
        assert!(egress_rules[0].to.is_none());
    }

    #[test]
    fn network_policy_open_class_emits_nothing() {
        let req = req_with(NetworkPolicyClass::Open, vec![egress("10.0.0.0/8")]);
        assert!(
            build_network_policy(&req, "job-z", "ns").is_none(),
            "NETWORK_OPEN must not emit a fence"
        );
    }

    #[test]
    fn network_policy_unspecified_defaults_to_fenced_dns_only() {
        // Fail-closed: an unspecified class still gets a default-deny fence.
        let req = req_with(NetworkPolicyClass::Unspecified, vec![egress("10.0.0.0/8")]);
        let np = build_network_policy(&req, "job-u", "ns").expect("must fence by default");
        let egress_rules = np.spec.unwrap().egress.unwrap();
        assert_eq!(
            egress_rules.len(),
            1,
            "unspecified => DNS-only, no CIDR allow"
        );
    }

    // -----------------------------------------------------------------------
    // Task 1: ingress default-deny is present in every non-Open NetworkPolicy
    // -----------------------------------------------------------------------

    #[test]
    fn network_policy_denies_all_ingress() {
        // Any non-Open policy must carry Ingress in policyTypes AND an empty
        // ingress rule list — the two together are what K8s interprets as
        // "deny all inbound" (K8s spec §4.3.1).
        for (class, label) in [
            (NetworkPolicyClass::None, "None"),
            (NetworkPolicyClass::AllowlistDomain, "AllowlistDomain"),
            (NetworkPolicyClass::TenantVpc, "TenantVpc"),
            (NetworkPolicyClass::Unspecified, "Unspecified"),
        ] {
            let req = req_with(class, vec![]);
            let np = build_network_policy(&req, "job-ingress-test", "ns")
                .unwrap_or_else(|| panic!("{label} must emit a policy"));
            let spec = np.spec.expect("spec");

            let types = spec.policy_types.as_deref().unwrap_or_default();
            assert!(
                types.contains(&"Ingress".to_string()),
                "{label}: Ingress must be in policyTypes (found: {types:?})"
            );
            let ingress_rules = spec.ingress.as_deref().unwrap_or(&[]);
            assert!(
                ingress_rules.is_empty(),
                "{label}: ingress rule list must be empty for deny-all (found {n} rules)",
                n = ingress_rules.len()
            );
        }
    }

    // -----------------------------------------------------------------------
    // Task 2: host-namespace fields are explicitly set to false + dnsPolicy
    // -----------------------------------------------------------------------

    #[test]
    fn build_job_sets_host_namespace_fields_and_dns_policy() {
        let req = make_req(IsolationClass::Trusted);
        let job = build_job(
            &req,
            "img",
            "job-host-ns",
            "ns",
            &RuntimeClassConfig::default(),
        )
        .expect("TRUSTED build_job must succeed");

        let pod_spec = job
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
            .expect("pod spec");

        assert_eq!(
            pod_spec.host_network,
            Some(false),
            "hostNetwork must be explicitly false"
        );
        assert_eq!(
            pod_spec.host_pid,
            Some(false),
            "hostPID must be explicitly false"
        );
        assert_eq!(
            pod_spec.host_ipc,
            Some(false),
            "hostIPC must be explicitly false"
        );
        assert_eq!(
            pod_spec.dns_policy.as_deref(),
            Some("ClusterFirst"),
            "dnsPolicy must be ClusterFirst"
        );
    }

    // -----------------------------------------------------------------------
    // Task 3: node affinity for hardened isolation classes
    // -----------------------------------------------------------------------

    fn affinity_label_value(job: &Job) -> Option<String> {
        job.spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
            .and_then(|ps| ps.affinity.as_ref())
            .and_then(|a| a.node_affinity.as_ref())
            .and_then(|na| na.required_during_scheduling_ignored_during_execution.as_ref())
            .and_then(|ns| ns.node_selector_terms.first())
            .and_then(|t| t.match_expressions.as_ref())
            .and_then(|exprs| exprs.first())
            .and_then(|req| req.values.as_ref())
            .and_then(|vals| vals.first())
            .cloned()
    }

    fn affinity_label_key(job: &Job) -> Option<String> {
        job.spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
            .and_then(|ps| ps.affinity.as_ref())
            .and_then(|a| a.node_affinity.as_ref())
            .and_then(|na| na.required_during_scheduling_ignored_during_execution.as_ref())
            .and_then(|ns| ns.node_selector_terms.first())
            .and_then(|t| t.match_expressions.as_ref())
            .and_then(|exprs| exprs.first())
            .map(|req| req.key.clone())
    }

    #[test]
    fn build_job_untrusted_gets_gvisor_node_affinity() {
        let req = make_req(IsolationClass::Untrusted);
        let job = build_job(
            &req,
            "img",
            "job-untrusted-affinity",
            "ns",
            &RuntimeClassConfig {
                gvisor: Some("gvisor".to_string()),
                ..Default::default()
            },
        )
        .expect("should succeed with gVisor configured");

        assert_eq!(
            affinity_label_key(&job).as_deref(),
            Some("lantern.dev/runtimeclass"),
            "node affinity key must be lantern.dev/runtimeclass"
        );
        assert_eq!(
            affinity_label_value(&job).as_deref(),
            Some("gvisor"),
            "UNTRUSTED must require gvisor node label"
        );
    }

    #[test]
    fn build_job_hostile_gets_kata_node_affinity() {
        let req = make_req(IsolationClass::Hostile);
        let job = build_job(
            &req,
            "img",
            "job-hostile-affinity",
            "ns",
            &RuntimeClassConfig {
                kata: Some("kata-qemu".to_string()),
                ..Default::default()
            },
        )
        .expect("should succeed with Kata configured");

        assert_eq!(
            affinity_label_key(&job).as_deref(),
            Some("lantern.dev/runtimeclass"),
            "node affinity key must be lantern.dev/runtimeclass"
        );
        assert_eq!(
            affinity_label_value(&job).as_deref(),
            Some("kata"),
            "HOSTILE must require kata node label"
        );
    }

    #[test]
    fn build_job_untrusted_respects_custom_node_label() {
        let req = make_req(IsolationClass::Untrusted);
        let job = build_job(
            &req,
            "img",
            "job-untrusted-custom-label",
            "ns",
            &RuntimeClassConfig {
                gvisor: Some("gvisor".to_string()),
                node_label_gvisor: Some("gvisor-v2".to_string()),
                ..Default::default()
            },
        )
        .expect("should succeed with gVisor configured");

        assert_eq!(
            affinity_label_value(&job).as_deref(),
            Some("gvisor-v2"),
            "custom node_label_gvisor must be used"
        );
    }

    #[test]
    fn build_job_trusted_has_no_node_affinity() {
        let req = make_req(IsolationClass::Trusted);
        let job = build_job(
            &req,
            "img",
            "job-trusted-no-affinity",
            "ns",
            &RuntimeClassConfig {
                gvisor: Some("gvisor".to_string()),
                kata: Some("kata-qemu".to_string()),
                ..Default::default()
            },
        )
        .expect("TRUSTED build_job must succeed");

        let pod_spec = job
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
            .expect("pod spec");
        assert!(
            pod_spec.affinity.is_none(),
            "TRUSTED must not have node affinity constraints"
        );
    }

    #[test]
    fn build_job_standard_has_no_node_affinity() {
        let req = make_req(IsolationClass::Standard);
        let job = build_job(
            &req,
            "img",
            "job-standard-no-affinity",
            "ns",
            &RuntimeClassConfig {
                gvisor: Some("gvisor".to_string()),
                ..Default::default()
            },
        )
        .expect("STANDARD with gVisor must succeed");

        let pod_spec = job
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
            .expect("pod spec");
        assert!(
            pod_spec.affinity.is_none(),
            "STANDARD must not have mandatory node affinity constraints"
        );
    }

    #[test]
    fn cidr_detection() {
        assert!(is_cidr("10.0.0.0/8"));
        assert!(is_cidr("192.168.1.0/24"));
        assert!(is_cidr("2001:db8::/32"));
        assert!(!is_cidr("*.openai.com"));
        assert!(!is_cidr("openai.com"));
        assert!(!is_cidr("10.0.0.0")); // no prefix
        assert!(!is_cidr("10.0.0.0/notaprefix"));
    }

    #[test]
    fn network_policy_name_is_stable_and_job_derived() {
        assert_eq!(
            network_policy_name("lantern-run-abc-001"),
            "lantern-run-abc-001-egress"
        );
    }

    // -----------------------------------------------------------------------
    // CPU / memory quantity parsing (unit-testable without a cluster)
    // -----------------------------------------------------------------------

    #[test]
    fn parse_cpu_nanocores() {
        // 250_000_000 n = 250 millicores = 250 ms of a vCPU per second
        assert_eq!(parse_cpu_quantity_to_vcpu_ms("250000000n"), 250);
    }

    #[test]
    fn parse_cpu_millicores() {
        assert_eq!(parse_cpu_quantity_to_vcpu_ms("500m"), 500);
        assert_eq!(parse_cpu_quantity_to_vcpu_ms("1000m"), 1000);
    }

    #[test]
    fn parse_cpu_whole_cores() {
        assert_eq!(parse_cpu_quantity_to_vcpu_ms("2"), 2_000);
    }

    #[test]
    fn parse_cpu_empty_returns_zero() {
        assert_eq!(parse_cpu_quantity_to_vcpu_ms(""), 0);
    }

    #[test]
    fn parse_memory_kibibytes() {
        assert_eq!(parse_memory_quantity_to_bytes("64Ki"), 64 * 1_024);
    }

    #[test]
    fn parse_memory_mebibytes() {
        assert_eq!(parse_memory_quantity_to_bytes("128Mi"), 128 * 1_024 * 1_024);
    }

    #[test]
    fn parse_memory_gibibytes() {
        assert_eq!(
            parse_memory_quantity_to_bytes("2Gi"),
            2 * 1_024 * 1_024 * 1_024
        );
    }

    #[test]
    fn parse_memory_plain_bytes() {
        assert_eq!(parse_memory_quantity_to_bytes("1073741824"), 1_073_741_824);
    }

    #[test]
    fn parse_memory_empty_returns_zero() {
        assert_eq!(parse_memory_quantity_to_bytes(""), 0);
    }

    /// Verify that a well-formed PodMetrics JSON blob (inline fixture)
    /// round-trips through `serde_json::from_str::<PodMetrics>` and
    /// produces the expected cpu/memory values after quantity parsing.
    #[test]
    fn pod_metrics_json_parses_correctly() {
        let raw = r#"{
            "kind": "PodMetrics",
            "apiVersion": "metrics.k8s.io/v1beta1",
            "metadata": { "name": "my-pod", "namespace": "default" },
            "containers": [
                { "name": "agent-runner", "usage": { "cpu": "500m", "memory": "64Mi" } }
            ]
        }"#;

        let pm: PodMetrics = serde_json::from_str(raw).expect("parse PodMetrics");
        assert_eq!(pm.containers.len(), 1);
        let cpu_ms = parse_cpu_quantity_to_vcpu_ms(&pm.containers[0].usage.cpu);
        let mem = parse_memory_quantity_to_bytes(&pm.containers[0].usage.memory);
        assert_eq!(cpu_ms, 500);
        assert_eq!(mem, 64 * 1_024 * 1_024);
    }

    /// handle_id parsing: the pure split_once logic that resolve_pod uses.
    #[test]
    fn handle_id_split_namespace_and_job() {
        let handle_id = "lantern-t-dev/lantern-run-abcd1234-ef012345";
        let (ns, job) = handle_id
            .split_once('/')
            .expect("should split on first slash");
        assert_eq!(ns, "lantern-t-dev");
        assert_eq!(job, "lantern-run-abcd1234-ef012345");
    }

    #[test]
    fn handle_id_missing_slash_fails_split() {
        assert!(
            "no-slash-here".split_once('/').is_none(),
            "handle_id without slash must be caught as invalid"
        );
    }

    // -----------------------------------------------------------------------
    // ADR-0009 RuntimeClass mapping — security-focused unit tests
    // -----------------------------------------------------------------------

    fn make_req(isolation: IsolationClass) -> ScheduleRequest {
        ScheduleRequest {
            run_id: "run-test-0001".to_string(),
            tenant_id: "test-tenant".to_string(),
            bundle_uri: "sha256:abc".to_string(),
            bundle_digest: vec![],
            isolation_class: isolation,
            limits: crate::proto::ResourceLimits::default(),
            env: HashMap::new(),
            secrets: vec![],
            input: serde_json::Value::Null,
            command: vec![],
            args: vec![],
            image: "python:3.11-slim".to_string(),
            network_policy: NetworkPolicyClass::None,
            egress_rules: vec![],
        }
    }

    fn pod_runtime_class(job: &Job) -> Option<&str> {
        job.spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
            .and_then(|ps| ps.runtime_class_name.as_deref())
    }

    // TRUSTED → None (runc; no RuntimeClass field set).
    #[test]
    fn build_job_trusted_uses_runc() {
        let req = make_req(IsolationClass::Trusted);
        let job = build_job(
            &req,
            "img",
            "job-trusted",
            "ns",
            &RuntimeClassConfig {
                gvisor: Some("gvisor".to_string()),
                kata: Some("kata-qemu".to_string()),
                wasm: None,
                allow_runc_standard: false,
                ..Default::default()
            },
        )
        .expect("TRUSTED should always succeed");
        assert_eq!(
            pod_runtime_class(&job),
            None,
            "TRUSTED must use runc (no runtimeClassName)"
        );
    }

    // UNTRUSTED + gVisor configured → runtimeClassName = "gvisor".
    #[test]
    fn build_job_untrusted_uses_gvisor_when_configured() {
        let req = make_req(IsolationClass::Untrusted);
        let job = build_job(
            &req,
            "img",
            "job-untrusted",
            "ns",
            &RuntimeClassConfig {
                gvisor: Some("gvisor".to_string()),
                kata: Some("kata-qemu".to_string()),
                wasm: None,
                allow_runc_standard: false,
                ..Default::default()
            },
        )
        .expect("UNTRUSTED should succeed when gVisor is configured");
        assert_eq!(
            pod_runtime_class(&job),
            Some("gvisor"),
            "UNTRUSTED must set runtimeClassName=gvisor"
        );
    }

    // HOSTILE + Kata configured → runtimeClassName = "kata-qemu".
    #[test]
    fn build_job_hostile_uses_kata_when_configured() {
        let req = make_req(IsolationClass::Hostile);
        let job = build_job(
            &req,
            "img",
            "job-hostile",
            "ns",
            &RuntimeClassConfig {
                gvisor: Some("gvisor".to_string()),
                kata: Some("kata-qemu".to_string()),
                wasm: None,
                allow_runc_standard: false,
                ..Default::default()
            },
        )
        .expect("HOSTILE should succeed when Kata is configured");
        assert_eq!(
            pod_runtime_class(&job),
            Some("kata-qemu"),
            "HOSTILE must set runtimeClassName=kata-qemu"
        );
    }

    // STANDARD without gVisor → fails without allow_runc_standard (new fail-closed default).
    #[test]
    fn build_job_standard_without_gvisor_is_err_without_opt_in() {
        let req = make_req(IsolationClass::Standard);
        let result = build_job(
            &req,
            "img",
            "job-standard-no-gv",
            "ns",
            &RuntimeClassConfig::default(), // no gVisor, allow_runc_standard=false
        );
        let err = result.expect_err(
            "STANDARD without gVisor and without allow_runc_standard must fail (fail-closed)",
        );
        let msg = err.to_string();
        assert!(
            msg.contains("LANTERN_ALLOW_RUNC_STANDARD")
                || msg.contains("LANTERN_RUNTIMECLASS_GVISOR"),
            "error must name the relevant config vars: {msg}"
        );
    }

    // STANDARD without gVisor but WITH allow_runc_standard → runc degradation allowed.
    #[test]
    fn build_job_standard_degrades_to_runc_with_opt_in() {
        let req = make_req(IsolationClass::Standard);
        let job = build_job(
            &req,
            "img",
            "job-standard-runc-opt-in",
            "ns",
            &RuntimeClassConfig {
                allow_runc_standard: true,
                ..Default::default()
            },
        )
        .expect("STANDARD with allow_runc_standard must succeed (runc degradation)");
        assert_eq!(
            pod_runtime_class(&job),
            None,
            "STANDARD with allow_runc_standard degrades to runc (no runtimeClassName)"
        );
    }

    // STANDARD with gVisor → runtimeClassName set.
    #[test]
    fn build_job_standard_uses_gvisor_when_configured() {
        let req = make_req(IsolationClass::Standard);
        let job = build_job(
            &req,
            "img",
            "job-standard-gv",
            "ns",
            &RuntimeClassConfig {
                gvisor: Some("gvisor".to_string()),
                kata: None,
                wasm: None,
                allow_runc_standard: false,
                ..Default::default()
            },
        )
        .expect("STANDARD with gVisor should succeed");
        assert_eq!(pod_runtime_class(&job), Some("gvisor"));
    }

    // -----------------------------------------------------------------------
    // New: fail-closed second gate — build_job errors for hard classes without
    // the required RuntimeClass, even if choose_backend was bypassed.
    // -----------------------------------------------------------------------

    // UNTRUSTED without gVisor → build_job returns Err (not a silent runc pod).
    #[test]
    fn build_job_untrusted_without_gvisor_is_err() {
        let req = make_req(IsolationClass::Untrusted);
        let result = build_job(
            &req,
            "img",
            "job-untrusted-no-gv",
            "ns",
            &RuntimeClassConfig::default(), // gVisor unset
        );
        let err = result.expect_err(
            "UNTRUSTED with no gVisor config must fail — a bare runc pod is never acceptable",
        );
        let msg = err.to_string();
        assert!(
            msg.contains("UNTRUSTED"),
            "error message must name the isolation class: {msg}"
        );
        assert!(
            msg.contains("LANTERN_RUNTIMECLASS_GVISOR"),
            "error message must name the config var: {msg}"
        );
    }

    // HOSTILE without Kata → build_job returns Err.
    #[test]
    fn build_job_hostile_without_kata_is_err() {
        let req = make_req(IsolationClass::Hostile);
        let result = build_job(
            &req,
            "img",
            "job-hostile-no-kata",
            "ns",
            &RuntimeClassConfig::default(), // Kata unset
        );
        let err = result.expect_err(
            "HOSTILE with no Kata config must fail — a bare runc pod is never acceptable",
        );
        let msg = err.to_string();
        assert!(
            msg.contains("HOSTILE"),
            "error message must name the isolation class: {msg}"
        );
        assert!(
            msg.contains("LANTERN_RUNTIMECLASS_KATA"),
            "error message must name the config var: {msg}"
        );
    }

    // -----------------------------------------------------------------------
    // satisfies_isolation tests — use `k8s_satisfies_isolation` (the pure
    // helper) so we don't need to construct a live `kube::Client`.
    // -----------------------------------------------------------------------

    // UNTRUSTED refused when gVisor not configured (fail-closed — the most
    // important security assertion in this file).
    #[test]
    fn k8s_backend_refuses_untrusted_without_gvisor() {
        assert!(
            !k8s_satisfies_isolation(&RuntimeClassConfig::default(), IsolationClass::Untrusted),
            "UNTRUSTED must be refused when gVisor RuntimeClass is not configured"
        );
    }

    // HOSTILE refused when Kata not configured (fail-closed).
    #[test]
    fn k8s_backend_refuses_hostile_without_kata() {
        assert!(
            !k8s_satisfies_isolation(&RuntimeClassConfig::default(), IsolationClass::Hostile),
            "HOSTILE must be refused when Kata RuntimeClass is not configured"
        );
    }

    // UNTRUSTED accepted when gVisor IS configured.
    #[test]
    fn k8s_backend_accepts_untrusted_with_gvisor() {
        let cfg = RuntimeClassConfig {
            gvisor: Some("gvisor".to_string()),
            kata: None,
            wasm: None,
            allow_runc_standard: false,
            ..Default::default()
        };
        assert!(
            k8s_satisfies_isolation(&cfg, IsolationClass::Untrusted),
            "UNTRUSTED must be accepted when gVisor is configured"
        );
    }

    // HOSTILE accepted when Kata IS configured.
    #[test]
    fn k8s_backend_accepts_hostile_with_kata() {
        let cfg = RuntimeClassConfig {
            gvisor: None,
            kata: Some("kata-qemu".to_string()),
            wasm: None,
            allow_runc_standard: false,
            ..Default::default()
        };
        assert!(
            k8s_satisfies_isolation(&cfg, IsolationClass::Hostile),
            "HOSTILE must be accepted when Kata is configured"
        );
    }

    // -----------------------------------------------------------------------
    // namespace_for: authenticated tenant_id field drives namespace derivation
    // -----------------------------------------------------------------------

    /// namespace_for derives the K8s namespace from req.tenant_id (authenticated
    /// field), NOT from req.env["LANTERN_TENANT_ID"] (caller-supplied).
    #[test]
    fn namespace_for_uses_authenticated_tenant_id_field() {
        let mut req = make_req(IsolationClass::Trusted);
        req.tenant_id = "acme-corp".to_string();
        // Even if env carries a different value, tenant_id field wins.
        req.env
            .insert("LANTERN_TENANT_ID".to_string(), "attacker".to_string());

        let ns = K8sBackend::namespace_for(&req).expect("non-empty tenant_id should succeed");
        assert_eq!(ns, "lantern-t-acme-corp");
        assert_ne!(ns, "lantern-t-attacker", "env value must be ignored");
    }

    /// namespace_for returns Err when tenant_id is empty — the upstream spawn
    /// gate should have rejected this, but defense-in-depth here too.
    #[test]
    fn namespace_for_rejects_empty_tenant_id() {
        let mut req = make_req(IsolationClass::Trusted);
        req.tenant_id = String::new();
        // Even with an env value, empty tenant_id is refused.
        req.env.insert(
            "LANTERN_TENANT_ID".to_string(),
            "should-not-be-used".to_string(),
        );

        let err = K8sBackend::namespace_for(&req)
            .expect_err("empty tenant_id must be refused (fail-closed)");
        assert!(
            err.to_string().contains("tenant_id is empty"),
            "error must mention empty tenant_id: {err}"
        );
    }

    // STANDARD on empty config (no gVisor, no opt-in) → refused (fail-closed).
    #[test]
    fn k8s_backend_refuses_standard_without_gvisor_and_without_opt_in() {
        let cfg = RuntimeClassConfig::default(); // allow_runc_standard=false
        assert!(
            !k8s_satisfies_isolation(&cfg, IsolationClass::Standard),
            "STANDARD must be refused when gVisor is absent and allow_runc_standard is false"
        );
        assert!(
            !k8s_satisfies_isolation(&cfg, IsolationClass::Unspecified),
            "UNSPECIFIED must be refused when gVisor is absent and allow_runc_standard is false"
        );
        assert!(
            !k8s_satisfies_isolation(&cfg, IsolationClass::Devcontainer),
            "DEVCONTAINER must be refused when gVisor is absent and allow_runc_standard is false"
        );
        assert!(
            !k8s_satisfies_isolation(&cfg, IsolationClass::Wasm),
            "WASM must be refused when wasm class is absent and allow_runc_standard is false"
        );
        // TRUSTED is always fine on runc.
        assert!(
            k8s_satisfies_isolation(&cfg, IsolationClass::Trusted),
            "TRUSTED must always be accepted on K8s"
        );
    }

    // STANDARD with allow_runc_standard opt-in → accepted.
    #[test]
    fn k8s_backend_accepts_standard_with_opt_in() {
        let cfg = RuntimeClassConfig {
            allow_runc_standard: true,
            ..Default::default()
        };
        assert!(
            k8s_satisfies_isolation(&cfg, IsolationClass::Standard),
            "STANDARD must be accepted when allow_runc_standard=true"
        );
        assert!(
            k8s_satisfies_isolation(&cfg, IsolationClass::Devcontainer),
            "DEVCONTAINER must be accepted when allow_runc_standard=true"
        );
        assert!(
            k8s_satisfies_isolation(&cfg, IsolationClass::Wasm),
            "WASM must be accepted when allow_runc_standard=true"
        );
    }

    // STANDARD with gVisor configured → accepted (no opt-in needed).
    #[test]
    fn k8s_backend_accepts_standard_with_gvisor() {
        let cfg = RuntimeClassConfig {
            gvisor: Some("gvisor".to_string()),
            ..Default::default()
        };
        assert!(
            k8s_satisfies_isolation(&cfg, IsolationClass::Standard),
            "STANDARD must be accepted when gVisor is configured"
        );
    }

    // WASM without wasm class and without opt-in → refused.
    #[test]
    fn k8s_backend_refuses_wasm_without_class_and_without_opt_in() {
        let cfg = RuntimeClassConfig::default();
        assert!(
            !k8s_satisfies_isolation(&cfg, IsolationClass::Wasm),
            "WASM must be refused when wasm class is absent and allow_runc_standard is false"
        );
    }

    // WASM with wasm class → accepted.
    #[test]
    fn k8s_backend_accepts_wasm_with_class() {
        let cfg = RuntimeClassConfig {
            wasm: Some("wasmtime".to_string()),
            ..Default::default()
        };
        assert!(
            k8s_satisfies_isolation(&cfg, IsolationClass::Wasm),
            "WASM must be accepted when wasm RuntimeClass is configured"
        );
    }

    // -----------------------------------------------------------------------
    // FIX 3: build_job honours req.image when non-empty and not a digest.
    // -----------------------------------------------------------------------

    #[test]
    fn build_job_uses_req_image_when_provided() {
        let mut req = make_req(IsolationClass::Trusted);
        req.image = "python:3.11-slim".to_string();
        let job = build_job(
            &req,
            "agent-image:v1",
            "job-img-override",
            "ns",
            &RuntimeClassConfig::default(),
        )
        .expect("TRUSTED build_job must succeed");
        let image = job
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
            .and_then(|ps| ps.containers.first())
            .and_then(|c| c.image.as_deref())
            .expect("container image must be set");
        assert_eq!(
            image, "python:3.11-slim",
            "req.image must override agent_image"
        );
    }

    #[test]
    fn build_job_falls_back_to_agent_image_when_req_image_empty() {
        let mut req = make_req(IsolationClass::Trusted);
        req.image = String::new();
        let job = build_job(
            &req,
            "agent-image:v1",
            "job-img-fallback",
            "ns",
            &RuntimeClassConfig::default(),
        )
        .expect("TRUSTED build_job must succeed");
        let image = job
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
            .and_then(|ps| ps.containers.first())
            .and_then(|c| c.image.as_deref())
            .expect("container image must be set");
        assert_eq!(
            image, "agent-image:v1",
            "empty req.image must fall back to agent_image"
        );
    }

    #[test]
    fn build_job_falls_back_to_agent_image_for_digest_req_image() {
        let mut req = make_req(IsolationClass::Trusted);
        req.image = "sha256:deadbeefdeadbeef".to_string();
        let job = build_job(
            &req,
            "agent-image:v1",
            "job-img-digest",
            "ns",
            &RuntimeClassConfig::default(),
        )
        .expect("TRUSTED build_job must succeed");
        let image = job
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
            .and_then(|ps| ps.containers.first())
            .and_then(|c| c.image.as_deref())
            .expect("container image must be set");
        assert_eq!(
            image, "agent-image:v1",
            "sha256: prefixed req.image is a bundle digest, not an image override"
        );
    }

    // -----------------------------------------------------------------------
    // FIX 7: namespace_for length bound and DNS-1123 boundary checks.
    // -----------------------------------------------------------------------

    // A 54-char tenant_id (prefix 10 + 54 = 64, over K8s 63 limit) is refused.
    #[test]
    fn namespace_for_rejects_tenant_id_over_53_chars() {
        let mut req = make_req(IsolationClass::Trusted);
        // 54 lowercase letters — 10 + 54 = 64 chars total, exceeds K8s 63 limit.
        req.tenant_id = "a".repeat(54);
        let err = K8sBackend::namespace_for(&req)
            .expect_err("tenant_id >53 chars must be refused (would produce >63-char namespace)");
        let msg = err.to_string();
        assert!(
            msg.contains("DNS-1123"),
            "error must mention DNS-1123: {msg}"
        );
    }

    // A 53-char tenant_id is exactly at the boundary and should be accepted.
    #[test]
    fn namespace_for_accepts_tenant_id_at_53_chars() {
        let mut req = make_req(IsolationClass::Trusted);
        req.tenant_id = "a".repeat(53);
        let ns = K8sBackend::namespace_for(&req)
            .expect("53-char tenant_id must be accepted (10+53=63 chars namespace)");
        assert_eq!(ns.len(), 63);
    }

    // A tenant_id with a trailing dash is refused (DNS-1123 boundary).
    #[test]
    fn namespace_for_rejects_trailing_dash() {
        let mut req = make_req(IsolationClass::Trusted);
        req.tenant_id = "acme-".to_string();
        let err =
            K8sBackend::namespace_for(&req).expect_err("trailing dash must be refused (DNS-1123)");
        let msg = err.to_string();
        assert!(
            msg.contains("DNS-1123"),
            "error must mention DNS-1123: {msg}"
        );
    }

    // A tenant_id with a leading dash is refused.
    #[test]
    fn namespace_for_rejects_leading_dash() {
        let mut req = make_req(IsolationClass::Trusted);
        req.tenant_id = "-acme".to_string();
        let err =
            K8sBackend::namespace_for(&req).expect_err("leading dash must be refused (DNS-1123)");
        let msg = err.to_string();
        assert!(
            msg.contains("DNS-1123"),
            "error must mention DNS-1123: {msg}"
        );
    }

    // A normal UUID-style tenant_id passes.
    #[test]
    fn namespace_for_accepts_uuid_style_tenant_id() {
        let mut req = make_req(IsolationClass::Trusted);
        req.tenant_id = "00000000-0000-0000-0000-000000000001".to_string();
        // UUIDs use hex + dashes; no uppercase, no trailing/leading dash.
        // BUT UUID contains uppercase in standard form — use lowercase version.
        // Standard UUID is lowercase hex, so this passes [a-z0-9-].
        let ns = K8sBackend::namespace_for(&req)
            .expect("UUID-style lowercase tenant_id must be accepted");
        assert_eq!(ns, "lantern-t-00000000-0000-0000-0000-000000000001");
    }
}
