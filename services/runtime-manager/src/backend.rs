use anyhow::Result;
use async_trait::async_trait;
use futures::stream::BoxStream;

use crate::proto::{RestoreRequest, RuntimeEvent, ScheduleRequest, SnapshotRequest};

/// A handle to a running sandbox instance.
#[derive(Clone, Debug)]
pub struct Handle {
    /// Unique identifier for this handle (container ID, pod name, or VM ID).
    pub id: String,
    /// The node or host where the sandbox is running.
    pub node_name: String,
    /// Time in milliseconds to start the sandbox (cold start latency).
    pub cold_start_ms: f64,
}

/// Information returned after creating a snapshot.
#[derive(Clone, Debug)]
pub struct SnapshotInfo {
    /// URI where the snapshot is stored (e.g., Docker image tag, S3 path).
    pub snapshot_uri: String,
    /// Size of the snapshot in bytes.
    pub size_bytes: i64,
}

/// Trait that each runtime backend must implement.
///
/// Backends translate high-level scheduling operations into concrete
/// infrastructure calls (Docker, K8s, Firecracker).
#[async_trait]
pub trait RuntimeBackend: Send + Sync {
    /// Schedule a new sandbox for the given run.
    async fn schedule(&self, req: &ScheduleRequest) -> Result<Handle>;

    /// Cancel a running sandbox, with a reason for auditing.
    async fn cancel(&self, handle_id: &str, reason: &str) -> Result<()>;

    /// Stream runtime events from the sandbox.
    /// Returns a `'static` stream so it can be moved into spawned tasks.
    async fn stream(&self, handle_id: &str) -> Result<BoxStream<'static, RuntimeEvent>>;

    /// Create a snapshot of the sandbox's current state.
    async fn snapshot(&self, req: &SnapshotRequest) -> Result<SnapshotInfo>;

    /// Restore a sandbox from a previously-created snapshot.
    async fn restore(&self, snapshot_uri: &str, req: &RestoreRequest) -> Result<Handle>;

    /// Return a human-readable name for this backend.
    fn name(&self) -> &'static str;
}
