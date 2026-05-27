use std::time::Instant;

use anyhow::Result;
use async_trait::async_trait;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::backend::{Handle, RuntimeBackend, SnapshotInfo};
use crate::proto::{
    LogLine, RestoreRequest, RuntimeEvent, RuntimeExited, ScheduleRequest, SnapshotRequest,
};

// ---------------------------------------------------------------------------
// Firecracker API types (matching the Firecracker REST API)
// ---------------------------------------------------------------------------

/// Boot source configuration for the microVM.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BootSource {
    pub kernel_image_path: String,
    pub boot_args: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initrd_path: Option<String>,
}

/// Block device (drive) configuration.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Drive {
    pub drive_id: String,
    pub path_on_host: String,
    pub is_root_device: bool,
    pub is_read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partuuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limiter: Option<RateLimiter>,
}

/// Rate limiter for I/O operations.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RateLimiter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bandwidth: Option<TokenBucket>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ops: Option<TokenBucket>,
}

/// Token bucket for rate limiting.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TokenBucket {
    pub size: u64,
    pub one_time_burst: u64,
    pub refill_time: u64,
}

/// Machine configuration for the microVM.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MachineConfig {
    pub vcpu_count: u32,
    pub mem_size_mib: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smt: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_dirty_pages: Option<bool>,
}

/// Network interface configuration.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NetworkInterface {
    pub iface_id: String,
    pub guest_mac: String,
    pub host_dev_name: String,
}

/// Vsock device configuration for host-guest communication.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VsockDevice {
    pub vsock_id: String,
    pub guest_cid: u32,
    pub uds_path: String,
}

/// Parameters for creating a snapshot.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SnapshotCreateParams {
    pub snapshot_type: String, // "Full" or "Diff"
    pub snapshot_path: String,
    pub mem_file_path: String,
}

/// Parameters for loading (restoring) a snapshot.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SnapshotLoadParams {
    pub snapshot_path: String,
    pub mem_backend: MemBackend,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_diff_snapshots: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_vm: Option<bool>,
}

/// Memory backend for snapshot loading.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MemBackend {
    pub backend_type: String, // "File"
    pub backend_path: String,
}

/// Action to start/stop the VM.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InstanceAction {
    pub action_type: String, // "InstanceStart", "FlushMetrics", "SendCtrlAltDel"
}

// ---------------------------------------------------------------------------
// Firecracker Backend
// ---------------------------------------------------------------------------

/// Firecracker microVM backend for untrusted and hostile workloads.
///
/// This backend is structured with real Firecracker API types and patterns.
/// All API calls go through the Firecracker REST API served over a Unix socket.
/// For the spike, the socket path is configurable but calls log the intended
/// action and return mock handles.
pub struct FirecrackerBackend {
    /// Path to the Firecracker API socket.
    socket_path: String,
    /// HTTP client for talking to the Firecracker API over Unix socket.
    http_client: reqwest::Client,
    /// Path to the Linux kernel image for microVMs.
    kernel_image_path: String,
    /// Path to the root filesystem image.
    rootfs_path: String,
    /// Default vCPU count.
    default_vcpu: u32,
    /// Default memory in MiB.
    default_mem_mib: u32,
}

impl FirecrackerBackend {
    pub fn new(socket_path: String) -> Self {
        Self {
            socket_path,
            http_client: reqwest::Client::new(),
            kernel_image_path: "/opt/lantern/vmlinux".to_string(),
            rootfs_path: "/opt/lantern/rootfs.ext4".to_string(),
            default_vcpu: 2,
            default_mem_mib: 512,
        }
    }

    /// Base URL for the Firecracker API (Unix socket, accessed via reqwest).
    fn api_url(&self) -> String {
        // In production, we'd use a Unix socket transport.
        // For the spike, we use a placeholder HTTP URL.
        format!(
            "http://localhost/firecracker/{}",
            self.socket_path.replace('/', "_")
        )
    }

    /// PUT request to the Firecracker API.
    async fn api_put<T: Serialize>(&self, path: &str, body: &T) -> Result<()> {
        let url = format!("{}{}", self.api_url(), path);

        tracing::info!(
            url = %url,
            body = %serde_json::to_string_pretty(body).unwrap_or_default(),
            "Firecracker API PUT (stub)"
        );

        // In production, this would make a real HTTP PUT over the Unix socket:
        // self.http_client
        //     .put(&url)
        //     .json(body)
        //     .send()
        //     .await
        //     .context("Firecracker API call failed")?
        //     .error_for_status()
        //     .context("Firecracker API returned error")?;

        Ok(())
    }

    /// Parse CPU/memory limits from the schedule request into Firecracker config.
    fn machine_config_from_limits(&self, req: &ScheduleRequest) -> MachineConfig {
        let vcpu_count = if !req.limits.cpu.is_empty() {
            let cpu = &req.limits.cpu;
            if cpu.ends_with('m') {
                // Millicores: round up to at least 1 vCPU.
                let millis: u32 = cpu.trim_end_matches('m').parse().unwrap_or(1000);
                (millis / 1000).max(1)
            } else {
                cpu.parse::<u32>().unwrap_or(self.default_vcpu)
            }
        } else {
            self.default_vcpu
        };

        let mem_size_mib = if !req.limits.memory.is_empty() {
            let mem = &req.limits.memory;
            if mem.ends_with("Gi") {
                mem.trim_end_matches("Gi")
                    .parse::<u32>()
                    .unwrap_or(self.default_mem_mib / 1024)
                    * 1024
            } else if mem.ends_with("Mi") {
                mem.trim_end_matches("Mi")
                    .parse::<u32>()
                    .unwrap_or(self.default_mem_mib)
            } else {
                self.default_mem_mib
            }
        } else {
            self.default_mem_mib
        };

        MachineConfig {
            vcpu_count,
            mem_size_mib,
            smt: Some(false),
            track_dirty_pages: Some(true), // Required for diff snapshots.
        }
    }
}

#[async_trait]
impl RuntimeBackend for FirecrackerBackend {
    async fn schedule(&self, req: &ScheduleRequest) -> Result<Handle> {
        let start = Instant::now();
        let vm_id = Uuid::new_v4().to_string();

        tracing::info!(
            vm_id = %vm_id,
            run_id = %req.run_id,
            isolation_class = ?req.isolation_class,
            "creating Firecracker microVM"
        );

        // Step 1: Configure machine.
        let machine_config = self.machine_config_from_limits(req);
        self.api_put("/machine-config", &machine_config).await?;

        // Step 2: Set boot source.
        let boot_source = BootSource {
            kernel_image_path: self.kernel_image_path.clone(),
            boot_args: format!(
                "console=ttyS0 reboot=k panic=1 pci=off lantern.run_id={}",
                req.run_id
            ),
            initrd_path: None,
        };
        self.api_put("/boot-source", &boot_source).await?;

        // Step 3: Set root filesystem drive.
        let rootfs_drive = Drive {
            drive_id: "rootfs".to_string(),
            path_on_host: self.rootfs_path.clone(),
            is_root_device: true,
            is_read_only: false,
            partuuid: None,
            rate_limiter: None,
        };
        self.api_put("/drives/rootfs", &rootfs_drive).await?;

        // Step 4: Configure vsock for host-guest communication.
        let vsock = VsockDevice {
            vsock_id: "lantern-vsock".to_string(),
            guest_cid: 3,
            uds_path: format!("/tmp/lantern-vsock-{vm_id}.sock"),
        };
        self.api_put("/vsock", &vsock).await?;

        // Step 5: Start the microVM.
        let action = InstanceAction {
            action_type: "InstanceStart".to_string(),
        };
        self.api_put("/actions", &action).await?;

        let cold_start_ms = start.elapsed().as_secs_f64() * 1000.0;

        tracing::info!(
            vm_id = %vm_id,
            run_id = %req.run_id,
            cold_start_ms = cold_start_ms,
            vcpus = machine_config.vcpu_count,
            mem_mib = machine_config.mem_size_mib,
            "Firecracker microVM created (stub)"
        );

        Ok(Handle {
            id: vm_id,
            node_name: "firecracker-local".to_string(),
            cold_start_ms,
        })
    }

    async fn cancel(&self, handle_id: &str, reason: &str) -> Result<()> {
        tracing::info!(
            vm_id = handle_id,
            reason = reason,
            "sending Ctrl+Alt+Del to Firecracker microVM"
        );

        let action = InstanceAction {
            action_type: "SendCtrlAltDel".to_string(),
        };
        self.api_put("/actions", &action).await?;

        tracing::info!(vm_id = handle_id, "microVM shutdown initiated");
        Ok(())
    }

    async fn stream(&self, handle_id: &str) -> Result<BoxStream<'static, RuntimeEvent>> {
        let vm_id = handle_id.to_string();
        let (tx, rx) = tokio::sync::mpsc::channel::<RuntimeEvent>(256);

        // In production, this would connect to the vsock or serial console
        // and parse structured events from the guest agent.
        tokio::spawn(async move {
            tracing::info!(vm_id = %vm_id, "streaming events from Firecracker VM (stub)");

            // Emit a log line indicating this is a stub stream.
            let _ = tx
                .send(RuntimeEvent::Log(LogLine {
                    level: "info".to_string(),
                    message: format!(
                        "Firecracker VM {vm_id} stream connected (stub — \
                         in production, this reads from vsock/serial)"
                    ),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                }))
                .await;

            // Simulate the VM running for a short time, then exiting.
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;

            let _ = tx
                .send(RuntimeEvent::Exited(RuntimeExited {
                    exit_code: 0,
                    error: String::new(),
                }))
                .await;
        });

        Ok(Box::pin(ReceiverStream::new(rx)))
    }

    async fn snapshot(&self, req: &SnapshotRequest) -> Result<SnapshotInfo> {
        let snapshot_id = Uuid::new_v4().to_string();
        let snapshot_path = format!("/tmp/lantern-snapshots/{snapshot_id}/snapshot");
        let mem_file_path = format!("/tmp/lantern-snapshots/{snapshot_id}/mem");

        tracing::info!(
            vm_id = %req.handle_id,
            snapshot_id = %snapshot_id,
            "creating Firecracker snapshot"
        );

        let params = SnapshotCreateParams {
            snapshot_type: "Full".to_string(),
            snapshot_path: snapshot_path.clone(),
            mem_file_path: mem_file_path.clone(),
        };

        self.api_put("/snapshot/create", &params).await?;

        tracing::info!(
            snapshot_id = %snapshot_id,
            snapshot_path = %snapshot_path,
            "Firecracker snapshot created (stub)"
        );

        Ok(SnapshotInfo {
            snapshot_uri: format!("fc://{snapshot_path}"),
            size_bytes: 0, // Would be actual file size in production.
        })
    }

    async fn restore(&self, snapshot_uri: &str, req: &RestoreRequest) -> Result<Handle> {
        let start = Instant::now();
        let vm_id = Uuid::new_v4().to_string();

        let snapshot_path = snapshot_uri.strip_prefix("fc://").unwrap_or(snapshot_uri);

        // Derive the mem file path from the snapshot path.
        let mem_file_path = snapshot_path.replace("/snapshot", "/mem");

        tracing::info!(
            vm_id = %vm_id,
            snapshot_path = snapshot_path,
            run_id = %req.run_id,
            "restoring Firecracker microVM from snapshot"
        );

        let params = SnapshotLoadParams {
            snapshot_path: snapshot_path.to_string(),
            mem_backend: MemBackend {
                backend_type: "File".to_string(),
                backend_path: mem_file_path,
            },
            enable_diff_snapshots: Some(true),
            resume_vm: Some(true),
        };

        self.api_put("/snapshot/load", &params).await?;

        let restore_ms = start.elapsed().as_secs_f64() * 1000.0;

        tracing::info!(
            vm_id = %vm_id,
            restore_ms = restore_ms,
            "Firecracker microVM restored from snapshot (stub)"
        );

        Ok(Handle {
            id: vm_id,
            node_name: "firecracker-local".to_string(),
            cold_start_ms: restore_ms,
        })
    }

    fn name(&self) -> &'static str {
        "firecracker"
    }
}
