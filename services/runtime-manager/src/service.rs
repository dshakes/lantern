use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

use crate::backend::RuntimeBackend;
use crate::handle_registry::{HandleInfo, HandleRegistry};
use crate::pool::{PoolConfig, WarmPool};
use crate::proto;

/// gRPC service implementation for RuntimeManagerService.
///
/// Routes requests to the appropriate backend based on isolation class,
/// manages the warm pool and handle registry.
pub struct RuntimeManagerGrpc {
    backend: Arc<dyn RuntimeBackend>,
    pool: Arc<WarmPool>,
    registry: Arc<HandleRegistry>,
}

impl RuntimeManagerGrpc {
    pub fn new(backend: Arc<dyn RuntimeBackend>, pool_config: PoolConfig) -> Self {
        let pool = Arc::new(WarmPool::new(Arc::clone(&backend), pool_config));
        pool.start_reaper();

        let registry = Arc::new(HandleRegistry::new());

        Self {
            backend,
            pool,
            registry,
        }
    }

    /// Map an anyhow error to a tonic Status.
    fn to_status(e: anyhow::Error) -> Status {
        tracing::error!(error = %e, "runtime manager error");
        Status::internal(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// gRPC method implementations
// ---------------------------------------------------------------------------

impl RuntimeManagerGrpc {
    /// Schedule a new sandbox for a run.
    pub async fn schedule(
        &self,
        request: Request<proto::ScheduleRequest>,
    ) -> Result<Response<proto::ScheduleResponse>, Status> {
        let req = request.into_inner();

        tracing::info!(
            run_id = %req.run_id,
            isolation_class = ?req.isolation_class,
            backend = self.backend.name(),
            "scheduling run"
        );

        // Try the warm pool first, fall back to cold start.
        let handle = self
            .pool
            .acquire_or_cold_start(&req)
            .await
            .map_err(Self::to_status)?;

        // Extract tenant_id from the request env for the registry.
        let tenant_id = req
            .env
            .get("LANTERN_TENANT_ID")
            .cloned()
            .unwrap_or_else(|| "default".to_string());

        // Register the handle.
        self.registry.register(HandleInfo {
            handle_id: handle.id.clone(),
            run_id: req.run_id.clone(),
            tenant_id,
            backend: self.backend.name().to_string(),
            isolation_class: req.isolation_class,
            created_at: chrono::Utc::now(),
            resource_limits: req.limits.clone(),
            node_name: handle.node_name.clone(),
        });

        tracing::info!(
            handle_id = %handle.id,
            cold_start_ms = handle.cold_start_ms,
            active_handles = self.registry.len(),
            warm_pool_size = self.pool.total_warm(),
            "run scheduled"
        );

        Ok(Response::new(proto::ScheduleResponse {
            handle_id: handle.id,
            node_name: handle.node_name,
            cold_start_ms: handle.cold_start_ms,
        }))
    }

    /// Cancel a running sandbox.
    pub async fn cancel(
        &self,
        request: Request<proto::RuntimeCancelRequest>,
    ) -> Result<Response<proto::RuntimeCancelResponse>, Status> {
        let req = request.into_inner();

        tracing::info!(
            handle_id = %req.handle_id,
            reason = %req.reason,
            "cancelling run"
        );

        self.backend
            .cancel(&req.handle_id, &req.reason)
            .await
            .map_err(Self::to_status)?;

        // Deregister from the handle registry.
        self.registry.deregister(&req.handle_id);

        Ok(Response::new(proto::RuntimeCancelResponse {}))
    }

    /// Stream runtime events from a sandbox.
    pub async fn stream(
        &self,
        request: Request<proto::RuntimeStreamRequest>,
    ) -> Result<Response<ReceiverStream<Result<proto::RuntimeEvent, Status>>>, Status> {
        let req = request.into_inner();

        tracing::info!(handle_id = %req.handle_id, "opening event stream");

        // Verify the handle exists.
        if self.registry.get(&req.handle_id).is_none() {
            return Err(Status::not_found(format!(
                "handle {} not found",
                req.handle_id
            )));
        }

        let mut event_stream = self
            .backend
            .stream(&req.handle_id)
            .await
            .map_err(Self::to_status)?;

        // Bridge from the backend BoxStream to a tonic-compatible ReceiverStream.
        let (tx, rx) = mpsc::channel(256);
        let registry = Arc::clone(&self.registry);
        let handle_id = req.handle_id.clone();

        tokio::spawn(async move {
            use futures::StreamExt;

            while let Some(event) = event_stream.next().await {
                let is_exit = matches!(&event, proto::RuntimeEvent::Exited(_));

                if tx.send(Ok(event)).await.is_err() {
                    break;
                }

                if is_exit {
                    registry.deregister(&handle_id);
                    break;
                }
            }
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    /// Create a snapshot of a running sandbox.
    pub async fn snapshot(
        &self,
        request: Request<proto::SnapshotRequest>,
    ) -> Result<Response<proto::SnapshotResponse>, Status> {
        let req = request.into_inner();

        tracing::info!(handle_id = %req.handle_id, "creating snapshot");

        let info = self
            .backend
            .snapshot(&req)
            .await
            .map_err(Self::to_status)?;

        Ok(Response::new(proto::SnapshotResponse {
            snapshot_uri: info.snapshot_uri,
            size_bytes: info.size_bytes,
        }))
    }

    /// Restore a sandbox from a snapshot.
    pub async fn restore(
        &self,
        request: Request<proto::RestoreRequest>,
    ) -> Result<Response<proto::RestoreResponse>, Status> {
        let req = request.into_inner();

        tracing::info!(
            snapshot_uri = %req.snapshot_uri,
            run_id = %req.run_id,
            "restoring from snapshot"
        );

        let handle = self
            .backend
            .restore(&req.snapshot_uri, &req)
            .await
            .map_err(Self::to_status)?;

        // Extract tenant_id.
        let tenant_id = req
            .env
            .get("LANTERN_TENANT_ID")
            .cloned()
            .unwrap_or_else(|| "default".to_string());

        // Register the restored handle.
        self.registry.register(HandleInfo {
            handle_id: handle.id.clone(),
            run_id: req.run_id.clone(),
            tenant_id,
            backend: self.backend.name().to_string(),
            isolation_class: proto::IsolationClass::Unspecified,
            created_at: chrono::Utc::now(),
            resource_limits: proto::ResourceLimits::default(),
            node_name: handle.node_name.clone(),
        });

        Ok(Response::new(proto::RestoreResponse {
            handle_id: handle.id,
            restore_ms: handle.cold_start_ms,
        }))
    }
}
