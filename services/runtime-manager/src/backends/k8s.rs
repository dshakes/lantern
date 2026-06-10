use std::collections::BTreeMap;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use futures::stream::BoxStream;
use futures::{AsyncBufReadExt, StreamExt, TryStreamExt};
use k8s_openapi::api::batch::v1::{Job, JobSpec};
use k8s_openapi::api::core::v1::{
    Capabilities, Container, ContainerPort, EnvVar, Pod, PodSecurityContext, PodSpec,
    PodTemplateSpec, ResourceRequirements, SeccompProfile, SecurityContext,
};
use k8s_openapi::api::networking::v1::{
    IPBlock, NetworkPolicy as K8sNetworkPolicy, NetworkPolicyEgressRule, NetworkPolicyPeer,
    NetworkPolicyPort, NetworkPolicySpec,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::Client;
use kube::api::{Api, AttachParams, DeleteParams, ListParams, LogParams, PostParams};
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::backend::{ExecOutput, Handle, RuntimeBackend, SnapshotInfo, StatsSample};
use crate::proto::{
    LogLine, NetworkPolicyClass, RestoreRequest, RuntimeEvent, RuntimeExited, ScheduleRequest,
    SnapshotRequest,
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

/// Kubernetes Job backend for trusted workloads.
///
/// Creates K8s Jobs in tenant-scoped namespaces. Each job runs the agent runner
/// image as a single pod with resource limits, env vars, and service account
/// bindings for minimal RBAC.
pub struct K8sBackend {
    client: Client,
    agent_image: String,
}

impl K8sBackend {
    pub async fn new(agent_image: String) -> Result<Self> {
        let client = Client::try_default()
            .await
            .context("failed to create K8s client (is KUBECONFIG set?)")?;

        tracing::info!("connected to Kubernetes cluster");

        Ok(Self {
            client,
            agent_image,
        })
    }

    /// Derive the tenant namespace from a run_id.
    /// In production, tenant_id comes from gRPC metadata; for the spike, we
    /// extract it from the env or default to "default".
    fn namespace_for(req: &ScheduleRequest) -> String {
        req.env
            .get("LANTERN_TENANT_ID")
            .map(|tid| format!("lantern-t-{tid}"))
            .unwrap_or_else(|| "lantern-t-default".to_string())
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
    fn build_job(&self, req: &ScheduleRequest, job_name: &str, namespace: &str) -> Job {
        build_job(req, &self.agent_image, job_name, namespace)
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

/// Pure K8s Job manifest builder. Takes the agent image explicitly so it needs
/// no `K8sBackend`/`Client` — fully unit-testable without a live cluster.
fn build_job(req: &ScheduleRequest, agent_image: &str, job_name: &str, namespace: &str) -> Job {
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

    let container = Container {
        name: "agent-runner".to_string(),
        image: Some(agent_image.to_string()),
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

    Job {
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
                    ..Default::default()
                }),
            },
            ..Default::default()
        }),
        ..Default::default()
    }
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

#[async_trait]
impl RuntimeBackend for K8sBackend {
    async fn schedule(&self, req: &ScheduleRequest) -> Result<Handle> {
        let start = Instant::now();
        let namespace = Self::namespace_for(req);
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
        if let Some(policy) = build_network_policy(req, &job_name, &namespace) {
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
        }

        let jobs: Api<Job> = Api::namespaced(self.client.clone(), &namespace);
        let job = self.build_job(req, &job_name, &namespace);

        jobs.create(&PostParams::default(), &job)
            .await
            .context("failed to create K8s job")?;

        // Wait for the pod to start running.
        let pod_name = self.wait_for_pod(&namespace, &job_name).await?;

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
            policy_types: Some(vec!["Egress".to_string()]),
            egress: Some(egress),
            ingress: None,
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
        let req = req_with(NetworkPolicyClass::AllowlistDomain, vec![]);
        let job = build_job(&req, "ghcr.io/lantern/runner:v1", "job-1", "lantern-t-acme");

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
        assert_eq!(
            container.image.as_deref(),
            Some("ghcr.io/lantern/runner:v1")
        );
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
        // Egress-only default-deny.
        assert_eq!(spec.policy_types, Some(vec!["Egress".to_string()]));
        assert!(spec.ingress.is_none());

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
}
