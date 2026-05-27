use std::collections::HashMap;
use std::time::Instant;

use anyhow::{Context, Result};
use async_trait::async_trait;
use bollard::container::{
    Config as ContainerConfig, CreateContainerOptions, LogOutput, LogsOptions,
    RemoveContainerOptions, StartContainerOptions, StopContainerOptions,
};
use bollard::image::CommitContainerOptions;
use bollard::Docker;
use futures::stream::BoxStream;
use futures::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::backend::{Handle, RuntimeBackend, SnapshotInfo};
use crate::proto::{
    LogLine, RestoreRequest, RuntimeEvent, RuntimeExited, ScheduleRequest, SnapshotRequest,
};

/// Docker runtime backend for local development.
///
/// Uses the bollard crate to communicate with the Docker daemon via Unix socket.
/// Containers run the agent runner image with environment variables that provide
/// run configuration.
pub struct DockerBackend {
    client: Docker,
    agent_image: String,
}

impl DockerBackend {
    pub fn new(socket_path: &str, agent_image: String) -> Result<Self> {
        let client = Docker::connect_with_unix(socket_path, 120, bollard::API_DEFAULT_VERSION)
            .context("failed to connect to Docker daemon")?;

        tracing::info!(socket = socket_path, "connected to Docker daemon");

        Ok(Self {
            client,
            agent_image,
        })
    }

    /// Ensure the image is available locally, pulling it if missing.
    /// Pass `None` to fall back to the manager's default `agent_image`.
    async fn ensure_image(&self, image_override: Option<&str>) -> Result<String> {
        use bollard::image::CreateImageOptions;
        use futures::TryStreamExt;

        let image = image_override
            .filter(|s| !s.is_empty())
            .unwrap_or(self.agent_image.as_str())
            .to_string();

        // Already pulled?
        if self.client.inspect_image(&image).await.is_ok() {
            return Ok(image);
        }

        tracing::info!(image = %image, "pulling image");

        let options = CreateImageOptions {
            from_image: image.clone(),
            ..Default::default()
        };

        self.client
            .create_image(Some(options), None, None)
            .try_collect::<Vec<_>>()
            .await
            .with_context(|| format!("failed to pull image {image}"))?;

        tracing::info!(image = %image, "image pulled");
        Ok(image)
    }

    /// Build the environment variable list for the container.
    fn build_env(req: &ScheduleRequest) -> Vec<String> {
        let mut env: Vec<String> = vec![
            format!("LANTERN_RUN_ID={}", req.run_id),
            format!("LANTERN_BUNDLE_URI={}", req.bundle_uri),
            format!(
                "LANTERN_INPUT={}",
                serde_json::to_string(&req.input).unwrap_or_default()
            ),
        ];

        for (k, v) in &req.env {
            env.push(format!("{k}={v}"));
        }

        // Secret refs are passed as env vars pointing to the vault reference.
        // The agent runner resolves them at execution time.
        for secret in &req.secrets {
            env.push(format!(
                "{}=lantern.secret/{}",
                secret.env_var, secret.vault_ref
            ));
        }

        env
    }

    /// Parse memory limit string (e.g., "512Mi") to bytes for Docker API.
    fn parse_memory_bytes(memory: &str) -> Option<i64> {
        let memory = memory.trim();
        if memory.ends_with("Gi") {
            memory
                .trim_end_matches("Gi")
                .parse::<i64>()
                .ok()
                .map(|v| v * 1024 * 1024 * 1024)
        } else if memory.ends_with("Mi") {
            memory
                .trim_end_matches("Mi")
                .parse::<i64>()
                .ok()
                .map(|v| v * 1024 * 1024)
        } else if memory.ends_with("Ki") {
            memory
                .trim_end_matches("Ki")
                .parse::<i64>()
                .ok()
                .map(|v| v * 1024)
        } else {
            memory.parse::<i64>().ok()
        }
    }

    /// Parse CPU limit string (e.g., "1", "0.5", "500m") to nano CPUs for Docker API.
    fn parse_nano_cpus(cpu: &str) -> Option<i64> {
        let cpu = cpu.trim();
        if cpu.ends_with('m') {
            // Millicores: "500m" → 500_000_000 nano CPUs
            cpu.trim_end_matches('m')
                .parse::<i64>()
                .ok()
                .map(|v| v * 1_000_000)
        } else {
            // Whole or fractional cores: "1" → 1_000_000_000, "0.5" → 500_000_000
            cpu.parse::<f64>()
                .ok()
                .map(|v| (v * 1_000_000_000.0) as i64)
        }
    }

    /// Parse a line of output from the container, looking for structured events.
    fn parse_line(line: &str) -> RuntimeEvent {
        const EVENT_PREFIX: &str = "__LANTERN_EVENT__:";

        if let Some(json_str) = line.strip_prefix(EVENT_PREFIX) {
            match serde_json::from_str::<RuntimeEvent>(json_str.trim()) {
                Ok(event) => return event,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        line = line,
                        "failed to parse structured event, treating as log line"
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
}

#[async_trait]
impl RuntimeBackend for DockerBackend {
    async fn schedule(&self, req: &ScheduleRequest) -> Result<Handle> {
        let start = Instant::now();

        // Caller-supplied image takes precedence over the manager default.
        // The image string can be:
        //   * a tag:  python:3.11-slim
        //   * a digest: sha256:abc...
        //   * a fully-qualified ref: ghcr.io/lantern/agent-runner@sha256:...
        // Pure-digest strings ("sha256:abc...") aren't pullable on their own —
        // we treat them as opaque pool keys and fall back to the manager
        // default image. Real prod ships with a content-addressed registry
        // that lets the digest pull directly.
        let pullable = if req.image.is_empty() || req.image.starts_with("sha256:") {
            None
        } else {
            Some(req.image.as_str())
        };
        let resolved_image = self.ensure_image(pullable).await?;

        let container_name = format!(
            "lantern-run-{}-{}",
            req.run_id,
            &Uuid::new_v4().to_string()[..8]
        );
        let env = Self::build_env(req);

        // Build host config with resource limits + network policy.
        let memory = Self::parse_memory_bytes(&req.limits.memory);
        let nano_cpus = Self::parse_nano_cpus(&req.limits.cpu);

        // Network: untrusted/hostile = no network; trusted/standard get
        // bridge by default. The harness-enforced egress allowlist sits on
        // top of bridge in the production microVM path; on a bare Docker
        // dev host we approximate with bridge / none.
        let network_mode = match req.isolation_class {
            crate::proto::IsolationClass::Untrusted | crate::proto::IsolationClass::Hostile => {
                "none"
            }
            _ => "bridge",
        };

        let host_config = bollard::models::HostConfig {
            memory,
            nano_cpus,
            network_mode: Some(network_mode.to_string()),
            // Auto-remove keeps the demo Docker host tidy. For prod where you
            // want post-mortem `docker logs`, flip this to false and let the
            // reaper handle GC. Today the manager has no reaper, so auto-rm
            // is the safer default.
            auto_remove: Some(false),
            ..Default::default()
        };

        // Honor caller-supplied entrypoint/args.
        let cmd: Option<Vec<String>> = if !req.command.is_empty() {
            let mut full = req.command.clone();
            full.extend(req.args.iter().cloned());
            Some(full)
        } else if !req.args.is_empty() {
            Some(req.args.clone())
        } else {
            None
        };

        let config = ContainerConfig {
            image: Some(resolved_image),
            env: Some(env),
            cmd,
            host_config: Some(host_config),
            labels: Some(HashMap::from([
                ("lantern.run_id".to_string(), req.run_id.clone()),
                (
                    "lantern.isolation_class".to_string(),
                    format!("{:?}", req.isolation_class),
                ),
            ])),
            ..Default::default()
        };

        let options = CreateContainerOptions {
            name: container_name.clone(),
            ..Default::default()
        };

        let created = self
            .client
            .create_container(Some(options), config)
            .await
            .context("failed to create container")?;

        self.client
            .start_container(&created.id, None::<StartContainerOptions<String>>)
            .await
            .context("failed to start container")?;

        let cold_start_ms = start.elapsed().as_secs_f64() * 1000.0;
        let hostname = gethostname();

        tracing::info!(
            container_id = %created.id,
            container_name = %container_name,
            run_id = %req.run_id,
            cold_start_ms = cold_start_ms,
            "container started"
        );

        Ok(Handle {
            id: created.id,
            node_name: hostname,
            cold_start_ms,
        })
    }

    async fn cancel(&self, handle_id: &str, reason: &str) -> Result<()> {
        tracing::info!(
            handle_id = handle_id,
            reason = reason,
            "cancelling container"
        );

        // Stop with a grace period.
        self.client
            .stop_container(handle_id, Some(StopContainerOptions { t: 10 }))
            .await
            .context("failed to stop container")?;

        // Remove the container.
        self.client
            .remove_container(
                handle_id,
                Some(RemoveContainerOptions {
                    force: true,
                    ..Default::default()
                }),
            )
            .await
            .context("failed to remove container")?;

        tracing::info!(handle_id = handle_id, "container stopped and removed");
        Ok(())
    }

    async fn stream(&self, handle_id: &str) -> Result<BoxStream<'static, RuntimeEvent>> {
        let options = LogsOptions::<String> {
            follow: true,
            stdout: true,
            stderr: true,
            timestamps: true,
            ..Default::default()
        };

        let log_stream = self.client.logs(handle_id, Some(options));

        let (tx, rx) = tokio::sync::mpsc::channel::<RuntimeEvent>(256);
        let container_id = handle_id.to_string();
        let client = self.client.clone();

        tokio::spawn(async move {
            let mut log_stream = log_stream;

            while let Some(result) = log_stream.next().await {
                match result {
                    Ok(output) => {
                        let line = match &output {
                            LogOutput::StdOut { message } => {
                                String::from_utf8_lossy(message).to_string()
                            }
                            LogOutput::StdErr { message } => {
                                String::from_utf8_lossy(message).to_string()
                            }
                            _ => continue,
                        };

                        for text_line in line.lines() {
                            let event = DockerBackend::parse_line(text_line);
                            if tx.send(event).await.is_err() {
                                return; // Receiver dropped.
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, container_id = %container_id, "log stream error");
                        break;
                    }
                }
            }

            // Container has exited; get exit code.
            let exit_code = match client.inspect_container(&container_id, None).await {
                Ok(info) => info
                    .state
                    .and_then(|s| s.exit_code)
                    .map(|c| c as i32)
                    .unwrap_or(-1),
                Err(_) => -1,
            };

            let _ = tx
                .send(RuntimeEvent::Exited(RuntimeExited {
                    exit_code,
                    error: if exit_code != 0 {
                        format!("container exited with code {exit_code}")
                    } else {
                        String::new()
                    },
                }))
                .await;
        });

        Ok(Box::pin(ReceiverStream::new(rx)))
    }

    async fn snapshot(&self, req: &SnapshotRequest) -> Result<SnapshotInfo> {
        let short_id = &Uuid::new_v4().to_string()[..8];
        let repo = "lantern-snapshot";
        let tag = short_id;

        tracing::info!(
            handle_id = %req.handle_id,
            repo = repo,
            tag = tag,
            "committing container as snapshot"
        );

        let options = CommitContainerOptions {
            container: req.handle_id.clone(),
            repo: repo.to_string(),
            tag: tag.to_string(),
            ..Default::default()
        };

        let result = self
            .client
            .commit_container(options, ContainerConfig::<String>::default())
            .await
            .context("failed to commit container")?;

        // Get the size of the created image.
        let image_ref = format!("{repo}:{tag}");
        let image_info = self.client.inspect_image(&image_ref).await.ok();

        let size_bytes = image_info.and_then(|i| i.size).unwrap_or(0);

        let result_id = result.id.as_deref().unwrap_or("unknown");

        tracing::info!(
            image_id = result_id,
            image_ref = %image_ref,
            size_bytes = size_bytes,
            "snapshot created"
        );

        Ok(SnapshotInfo {
            snapshot_uri: format!("docker://{image_ref}"),
            size_bytes,
        })
    }

    async fn restore(&self, snapshot_uri: &str, req: &RestoreRequest) -> Result<Handle> {
        let start = Instant::now();

        // Extract the image reference from the snapshot URI.
        let image_ref = snapshot_uri
            .strip_prefix("docker://")
            .unwrap_or(snapshot_uri);

        let container_name = format!(
            "lantern-restored-{}-{}",
            req.run_id,
            &Uuid::new_v4().to_string()[..8]
        );

        let mut env = vec![
            format!("LANTERN_RUN_ID={}", req.run_id),
            format!(
                "LANTERN_INPUT={}",
                serde_json::to_string(&req.input).unwrap_or_default()
            ),
        ];

        for (k, v) in &req.env {
            env.push(format!("{k}={v}"));
        }

        for secret in &req.secrets {
            env.push(format!(
                "{}=lantern.secret/{}",
                secret.env_var, secret.vault_ref
            ));
        }

        let config = ContainerConfig {
            image: Some(image_ref.to_string()),
            env: Some(env),
            ..Default::default()
        };

        let options = CreateContainerOptions {
            name: container_name.clone(),
            ..Default::default()
        };

        let created = self
            .client
            .create_container(Some(options), config)
            .await
            .context("failed to create container from snapshot")?;

        self.client
            .start_container(&created.id, None::<StartContainerOptions<String>>)
            .await
            .context("failed to start restored container")?;

        let cold_start_ms = start.elapsed().as_secs_f64() * 1000.0;

        tracing::info!(
            container_id = %created.id,
            snapshot_uri = snapshot_uri,
            restore_ms = cold_start_ms,
            "container restored from snapshot"
        );

        Ok(Handle {
            id: created.id,
            node_name: gethostname(),
            cold_start_ms,
        })
    }

    fn name(&self) -> &'static str {
        "docker"
    }
}

/// Get the hostname of the current machine.
fn gethostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = vec![0u8; 256];
        let ret = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if ret != 0 {
            return "unknown".to_string();
        }
        let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..len]).to_string()
    }

    #[cfg(not(unix))]
    {
        "localhost".to_string()
    }
}
