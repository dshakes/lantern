use std::collections::BTreeMap;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use futures::stream::BoxStream;
use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::batch::v1::{Job, JobSpec};
use k8s_openapi::api::core::v1::{
    Capabilities, Container, ContainerPort, EnvVar, PodSecurityContext, PodSpec, PodTemplateSpec,
    ResourceRequirements, SeccompProfile, SecurityContext,
};
use k8s_openapi::api::networking::v1::{
    IPBlock, NetworkPolicy as K8sNetworkPolicy, NetworkPolicyEgressRule, NetworkPolicyPeer,
    NetworkPolicyPort, NetworkPolicySpec,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::Client;
use kube::api::{Api, DeleteParams, ListParams, LogParams, PostParams};
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::backend::{Handle, RuntimeBackend, SnapshotInfo};
use crate::proto::{
    LogLine, NetworkPolicyClass, RestoreRequest, RuntimeEvent, RuntimeExited, ScheduleRequest,
    SnapshotRequest,
};

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
}
