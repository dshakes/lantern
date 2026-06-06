use std::collections::BTreeMap;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use futures::stream::BoxStream;
use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::batch::v1::{Job, JobSpec};
use k8s_openapi::api::core::v1::{
    Container, ContainerPort, EnvVar, PodSpec, PodTemplateSpec, ResourceRequirements,
    SecurityContext,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use kube::Client;
use kube::api::{Api, DeleteParams, ListParams, LogParams, PostParams};
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::backend::{Handle, RuntimeBackend, SnapshotInfo};
use crate::proto::{
    LogLine, RestoreRequest, RuntimeEvent, RuntimeExited, ScheduleRequest, SnapshotRequest,
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

    /// Build the K8s Job spec for a schedule request.
    fn build_job(&self, req: &ScheduleRequest, job_name: &str, namespace: &str) -> Job {
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

        let active_deadline = Self::parse_timeout_seconds(&req.limits.timeout);

        let container = Container {
            name: "agent-runner".to_string(),
            image: Some(self.agent_image.clone()),
            env: Some(env_vars),
            resources: Some(ResourceRequirements {
                requests: Some(resource_requests),
                limits: Some(resource_limits),
                ..Default::default()
            }),
            security_context: Some(SecurityContext {
                read_only_root_filesystem: Some(true),
                run_as_non_root: Some(true),
                run_as_user: Some(1000),
                allow_privilege_escalation: Some(false),
                ..Default::default()
            }),
            ports: Some(vec![ContainerPort {
                container_port: 8080,
                name: Some("agent".to_string()),
                ..Default::default()
            }]),
            ..Default::default()
        };

        let mut labels = BTreeMap::new();
        labels.insert(
            "app.kubernetes.io/name".to_string(),
            "lantern-agent-runner".to_string(),
        );
        labels.insert(
            "app.kubernetes.io/managed-by".to_string(),
            "lantern-runtime-manager".to_string(),
        );
        labels.insert("lantern.dev/run-id".to_string(), req.run_id.clone());
        labels.insert(
            "lantern.dev/isolation-class".to_string(),
            format!("{:?}", req.isolation_class).to_lowercase(),
        );

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
                        ..Default::default()
                    }),
                },
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// Wait for the job's pod to be scheduled and running (or failed).
    async fn wait_for_pod(&self, namespace: &str, job_name: &str) -> Result<String> {
        let pods: Api<k8s_openapi::api::core::v1::Pod> =
            Api::namespaced(self.client.clone(), namespace);

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
