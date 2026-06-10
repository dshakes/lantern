use std::collections::HashMap;
use std::time::Instant;

use anyhow::{Context, Result};
use async_trait::async_trait;
use bollard::Docker;
use bollard::container::{
    Config as ContainerConfig, CreateContainerOptions, LogOutput, LogsOptions,
    RemoveContainerOptions, StartContainerOptions, StatsOptions, StopContainerOptions,
};
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::image::CommitContainerOptions;
use futures::StreamExt;
use futures::stream::BoxStream;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::backend::{ExecOutput, Handle, RuntimeBackend, SnapshotInfo, StatsSample};
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

    /// Return a reference to the underlying bollard `Docker` client.
    ///
    /// Exposed for the `KataBackend` newtype so it can reuse the same
    /// daemon connection for the create/start pair with a custom runtime.
    pub fn client_ref(&self) -> &Docker {
        &self.client
    }

    /// Return the default agent image string.
    ///
    /// Exposed for `KataBackend` so it can resolve the image reference
    /// using the same fallback logic as `DockerBackend::ensure_image`.
    pub fn agent_image(&self) -> &str {
        &self.agent_image
    }

    /// Public wrapper around `parse_memory_bytes` for use by `KataBackend`.
    pub fn parse_memory_bytes_pub(memory: &str) -> Option<i64> {
        Self::parse_memory_bytes(memory)
    }

    /// Public wrapper around `parse_nano_cpus` for use by `KataBackend`.
    pub fn parse_nano_cpus_pub(cpu: &str) -> Option<i64> {
        Self::parse_nano_cpus(cpu)
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

    /// Build the `CreateExecOptions` for a TTY exec (`lantern vm exec -t`
    /// against a docker-backed VM). Factored out of [`Self::exec_command_tty`]
    /// so the option wiring is unit-testable without a Docker daemon.
    fn build_tty_exec_options(
        command: &str,
        argv: &[String],
        term: &str,
    ) -> CreateExecOptions<String> {
        let mut cmd: Vec<String> = Vec::with_capacity(1 + argv.len());
        cmd.push(command.to_string());
        cmd.extend(argv.iter().cloned());

        CreateExecOptions {
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            attach_stdin: Some(false),
            tty: Some(true),
            env: if term.is_empty() {
                None
            } else {
                Some(vec![format!("TERM={term}")])
            },
            cmd: Some(cmd),
            ..Default::default()
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

    /// Run a one-shot command inside a running container and collect its output.
    ///
    /// Uses the Docker exec API (create + start) rather than shelling out to
    /// `docker exec`, matching the bollard pattern already used in this module.
    /// The exec runs non-interactively (no TTY) so stdout and stderr are
    /// multiplexed in the standard Docker framing.  After the stream drains,
    /// `inspect_exec` fetches the exit code.
    async fn exec_command(
        &self,
        handle_id: &str,
        command: &str,
        argv: &[String],
    ) -> Result<ExecOutput> {
        // Build the full argv: [command, argv...].
        let mut cmd: Vec<&str> = vec![command];
        cmd.extend(argv.iter().map(String::as_str));

        // Step 1: create the exec instance.
        let exec = self
            .client
            .create_exec(
                handle_id,
                CreateExecOptions {
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    attach_stdin: Some(false),
                    tty: Some(false),
                    cmd: Some(cmd),
                    ..Default::default()
                },
            )
            .await
            .with_context(|| {
                format!("docker exec create failed for container {handle_id} cmd={command}")
            })?;

        let exec_id = exec.id;

        // Step 2: start the exec and collect output.
        let result = self
            .client
            .start_exec(
                &exec_id,
                Some(StartExecOptions {
                    detach: false,
                    tty: false,
                    ..Default::default()
                }),
            )
            .await
            .with_context(|| format!("docker exec start failed for exec_id={exec_id}"))?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        if let StartExecResults::Attached { mut output, .. } = result {
            while let Some(chunk) = output.next().await {
                match chunk.context("exec output stream error")? {
                    LogOutput::StdOut { message } => stdout.extend_from_slice(&message),
                    LogOutput::StdErr { message } => stderr.extend_from_slice(&message),
                    LogOutput::Console { message } => stdout.extend_from_slice(&message),
                    LogOutput::StdIn { .. } => {}
                }
            }
        }

        // Step 3: retrieve the exit code via inspect.
        let inspect = self
            .client
            .inspect_exec(&exec_id)
            .await
            .with_context(|| format!("docker exec inspect failed for exec_id={exec_id}"))?;

        let exit_code = inspect.exit_code.map(|c| c as i32).unwrap_or(-1);

        tracing::debug!(
            container_id = handle_id,
            command,
            exit_code,
            stdout_bytes = stdout.len(),
            stderr_bytes = stderr.len(),
            "exec completed"
        );

        Ok(ExecOutput {
            stdout,
            stderr,
            exit_code,
        })
    }

    /// Run a one-shot command with a TTY allocated inside a running container.
    ///
    /// With `Tty: true` the Docker daemon merges stdout and stderr into a
    /// single raw stream (PTY semantics) delivered as `LogOutput::Console`
    /// frames; everything lands in the result's `stdout`. The initial
    /// geometry is applied via the resize-exec API (best-effort — a failed
    /// resize leaves the daemon default rather than failing the exec). Stdin
    /// is not piped, matching the non-tty path.
    async fn exec_command_tty(
        &self,
        handle_id: &str,
        command: &str,
        argv: &[String],
        rows: u32,
        cols: u32,
        term: &str,
    ) -> Result<ExecOutput> {
        // Step 1: create the exec instance with a TTY.
        let exec = self
            .client
            .create_exec(handle_id, Self::build_tty_exec_options(command, argv, term))
            .await
            .with_context(|| {
                format!("docker tty exec create failed for container {handle_id} cmd={command}")
            })?;

        let exec_id = exec.id;

        // Step 2: start the exec.
        let result = self
            .client
            .start_exec(
                &exec_id,
                Some(StartExecOptions {
                    detach: false,
                    tty: true,
                    ..Default::default()
                }),
            )
            .await
            .with_context(|| format!("docker tty exec start failed for exec_id={exec_id}"))?;

        // Step 3: apply the caller's terminal geometry (0 → daemon default).
        if rows > 0 && cols > 0 {
            let resize = ResizeExecOptions {
                height: u16::try_from(rows).unwrap_or(u16::MAX),
                width: u16::try_from(cols).unwrap_or(u16::MAX),
            };
            if let Err(e) = self.client.resize_exec(&exec_id, resize).await {
                tracing::warn!(
                    exec_id = %exec_id,
                    rows,
                    cols,
                    error = %e,
                    "tty exec: resize failed; keeping daemon default geometry"
                );
            }
        }

        // Step 4: collect merged output.
        let mut stdout = Vec::new();
        if let StartExecResults::Attached { mut output, .. } = result {
            while let Some(chunk) = output.next().await {
                match chunk.context("tty exec output stream error")? {
                    LogOutput::Console { message }
                    | LogOutput::StdOut { message }
                    | LogOutput::StdErr { message } => stdout.extend_from_slice(&message),
                    LogOutput::StdIn { .. } => {}
                }
            }
        }

        // Step 5: retrieve the exit code via inspect.
        let inspect = self
            .client
            .inspect_exec(&exec_id)
            .await
            .with_context(|| format!("docker tty exec inspect failed for exec_id={exec_id}"))?;

        let exit_code = inspect.exit_code.map(|c| c as i32).unwrap_or(-1);

        tracing::debug!(
            container_id = handle_id,
            command,
            exit_code,
            stdout_bytes = stdout.len(),
            "tty exec completed"
        );

        Ok(ExecOutput {
            stdout,
            stderr: vec![],
            exit_code,
        })
    }

    /// Return a single resource-usage snapshot for a running container.
    ///
    /// Uses bollard's `stats` API with `stream=false, one_shot=true` so it
    /// fetches exactly one sample without blocking for a second delta cycle.
    /// CPU usage is expressed as vcpu·ms consumed in total (not a rate) to
    /// match the `vcpu_ms_used` field in `ResourceUsage` proto.
    async fn stats_sample(&self, handle_id: &str) -> Result<StatsSample> {
        let options = StatsOptions {
            stream: false,
            one_shot: true,
        };

        // stats() returns a Stream; we only need the first item.
        let mut stream = self.client.stats(handle_id, Some(options));

        let stats = stream
            .next()
            .await
            .ok_or_else(|| {
                anyhow::anyhow!("docker stats returned empty stream for container {handle_id}")
            })?
            .with_context(|| format!("docker stats error for container {handle_id}"))?;

        // CPU: convert nanoseconds → milliseconds.
        let cpu_ns = stats.cpu_stats.cpu_usage.total_usage;
        let vcpu_ms_used = (cpu_ns / 1_000_000) as i64;

        // Memory: prefer `usage` (current RSS); fall back to 0 when unavailable
        // (e.g. cgroup v2 on some kernels omits it).
        let memory_bytes = stats.memory_stats.usage.map(|v| v as i64).unwrap_or(0);

        // Network: sum all interfaces.
        let (network_bytes_in, network_bytes_out) = if let Some(networks) = &stats.networks {
            let rx: u64 = networks.values().map(|n| n.rx_bytes).sum();
            let tx: u64 = networks.values().map(|n| n.tx_bytes).sum();
            (rx as i64, tx as i64)
        } else if let Some(n) = &stats.network {
            (n.rx_bytes as i64, n.tx_bytes as i64)
        } else {
            (0, 0)
        };

        Ok(StatsSample {
            vcpu_ms_used,
            memory_bytes,
            network_bytes_in,
            network_bytes_out,
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    // build_tty_exec_options is pure — these tests verify the exec options
    // wiring without a Docker daemon. The live attached TTY stream is
    // daemon-runtime-only.

    #[test]
    fn tty_exec_options_allocate_a_tty() {
        let opts =
            DockerBackend::build_tty_exec_options("bash", &["-l".to_string()], "xterm-256color");

        assert_eq!(opts.tty, Some(true), "tty=true must request a PTY");
        assert_eq!(opts.attach_stdout, Some(true));
        assert_eq!(opts.attach_stderr, Some(true));
        assert_eq!(opts.attach_stdin, Some(false), "stdin is not piped");
        assert_eq!(
            opts.cmd,
            Some(vec!["bash".to_string(), "-l".to_string()]),
            "cmd must be [command, argv...]"
        );
        assert_eq!(
            opts.env,
            Some(vec!["TERM=xterm-256color".to_string()]),
            "term must be exported as TERM"
        );
    }

    #[test]
    fn tty_exec_options_omit_term_when_empty() {
        let opts = DockerBackend::build_tty_exec_options("sh", &[], "");
        assert_eq!(opts.tty, Some(true));
        assert_eq!(opts.env, None, "empty term must not export a TERM var");
        assert_eq!(opts.cmd, Some(vec!["sh".to_string()]));
    }
}
