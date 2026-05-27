use std::pin::Pin;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

use crate::backend::RuntimeBackend;
use crate::handle_registry::{HandleInfo, HandleRegistry};
use crate::pool::{PoolConfig, WarmPool};
use crate::proto;
use crate::proto::pb;

/// gRPC service implementation for RuntimeManagerService.
///
/// Routes requests to the appropriate backend based on isolation class,
/// manages the warm pool and handle registry.
#[derive(Clone)]
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

        let info = self.backend.snapshot(&req).await.map_err(Self::to_status)?;

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

// ---------------------------------------------------------------------------
// Generated gRPC trait — wire-level entry points.
//
// This is the surface tonic actually serves. Each method translates the
// over-the-wire proto message into the internal `proto::ScheduleRequest`
// / `proto::RuntimeCancelRequest` shape and delegates to the handlers
// above. Streaming methods bridge the backend's `BoxStream<RuntimeEvent>`
// into a `tokio_stream::wrappers::ReceiverStream` of `pb::LogLine`.
// ---------------------------------------------------------------------------

/// Translate a wire `SpawnRequest` into the internal `ScheduleRequest` the
/// backends + warm pool consume. The wire `AgentSpec` carries an
/// `image_digest` + `tenant_id` + `run_id`; we synthesize `bundle_uri` from
/// the digest, copy labels into env, and surface secrets verbatim.
// `Status` is ~176 bytes by design (tonic uses it everywhere); a one-shot
// adapter helper isn't going to gain anything from boxing it.
#[allow(clippy::result_large_err)]
fn spawn_to_schedule(req: &pb::SpawnRequest) -> Result<proto::ScheduleRequest, Status> {
    let spec = req
        .spec
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("spawn request missing spec"))?;

    let isolation = proto::IsolationClass::from_i32(spec.isolation);

    let limits = spec
        .limits
        .as_ref()
        .map(|l| proto::ResourceLimits {
            cpu: l.vcpu.clone(),
            memory: l.memory.clone(),
            gpu: l.gpu.clone(),
            timeout: l
                .timeout
                .as_ref()
                .map(|d| format!("{}s", d.seconds))
                .unwrap_or_else(|| "300s".to_string()),
            max_steps: l.max_steps,
            max_tokens: l.max_tokens,
            max_cost_usd: l.max_cost_usd,
            scratch_size: l.scratch_size.clone(),
        })
        .unwrap_or_default();

    // Build env from labels + tenant injection. Backends look for
    // `LANTERN_TENANT_ID` in env to populate the handle registry.
    let mut env: std::collections::HashMap<String, String> = spec.labels.clone();
    if !spec.tenant_id.is_empty() {
        env.insert("LANTERN_TENANT_ID".to_string(), spec.tenant_id.clone());
    }
    if !spec.agent_version_id.is_empty() {
        env.insert(
            "LANTERN_AGENT_VERSION_ID".to_string(),
            spec.agent_version_id.clone(),
        );
    }

    let secrets = spec
        .secrets
        .iter()
        .map(|s| proto::SecretRef {
            alias: s.env_name.clone(),
            vault_ref: s.secret_uri.clone(),
            env_var: s.env_name.clone(),
        })
        .collect();

    // Use raw digest bytes when possible; otherwise the string digest serves
    // as a stable pool key.
    let bundle_digest = spec.image_digest.as_bytes().to_vec();

    Ok(proto::ScheduleRequest {
        run_id: spec.run_id.clone(),
        bundle_uri: spec.image_digest.clone(),
        bundle_digest,
        isolation_class: isolation,
        limits,
        env,
        secrets,
        input: serde_json::Value::Null,
    })
}

#[tonic::async_trait]
impl pb::runtime_manager_server::RuntimeManager for RuntimeManagerGrpc {
    async fn spawn(
        &self,
        request: Request<pb::SpawnRequest>,
    ) -> Result<Response<pb::SpawnResponse>, Status> {
        let req = request.into_inner();
        let pre_handle = req.handle.clone();
        let from_snapshot = req
            .spec
            .as_ref()
            .map(|s| !s.restore_snapshot_id.is_empty())
            .unwrap_or(false);

        let internal = spawn_to_schedule(&req)?;
        let resp = self.schedule(Request::new(internal)).await?.into_inner();

        let cold_start_ms = resp.cold_start_ms;
        let boot_seconds = (cold_start_ms / 1000.0).floor() as i64;
        let boot_nanos = ((cold_start_ms - (boot_seconds as f64 * 1000.0)) * 1_000_000.0) as i32;

        // Honor a scheduler-pre-allocated handle if one was supplied;
        // otherwise mint a wire VmHandle from the cold-start result.
        let vm_handle = match pre_handle {
            Some(h) if !h.vm_id.is_empty() => h,
            _ => pb::VmHandle {
                vm_id: resp.handle_id,
                node: resp.node_name,
                availability_zone: String::new(),
                created_at: None,
            },
        };

        Ok(Response::new(pb::SpawnResponse {
            handle: Some(vm_handle),
            boot_duration: Some(prost_types::Duration {
                seconds: boot_seconds,
                nanos: boot_nanos,
            }),
            from_snapshot,
        }))
    }

    async fn stop(
        &self,
        request: Request<pb::StopRequest>,
    ) -> Result<Response<pb::StopResponse>, Status> {
        let req = request.into_inner();
        let grace_seconds = req.grace.as_ref().map(|d| d.seconds as i32).unwrap_or(30);

        let internal = proto::RuntimeCancelRequest {
            handle_id: req.vm_id.clone(),
            reason: req.reason,
            grace_period_seconds: grace_seconds,
        };

        match self.cancel(Request::new(internal)).await {
            Ok(_) => Ok(Response::new(pb::StopResponse {
                ok: true,
                detail: format!("vm {} stopped", req.vm_id),
            })),
            Err(status) => Ok(Response::new(pb::StopResponse {
                ok: false,
                detail: status.message().to_string(),
            })),
        }
    }

    type LogsStream =
        Pin<Box<dyn tokio_stream::Stream<Item = Result<pb::LogLine, Status>> + Send + 'static>>;

    async fn logs(
        &self,
        request: Request<pb::LogsRequest>,
    ) -> Result<Response<Self::LogsStream>, Status> {
        let req = request.into_inner();

        if self.registry.get(&req.vm_id).is_none() {
            return Err(Status::not_found(format!("vm {} not found", req.vm_id)));
        }

        let mut event_stream = self
            .backend
            .stream(&req.vm_id)
            .await
            .map_err(Self::to_status)?;

        let (tx, rx) = mpsc::channel::<Result<pb::LogLine, Status>>(256);
        let registry = Arc::clone(&self.registry);
        let vm_id = req.vm_id.clone();

        tokio::spawn(async move {
            use futures::StreamExt;

            while let Some(event) = event_stream.next().await {
                let is_exit = matches!(&event, proto::RuntimeEvent::Exited(_));

                // Project internal events to wire-level LogLines. Non-log
                // events become structured `harness` lines so clients see
                // every state transition.
                let line = match event {
                    proto::RuntimeEvent::Log(l) => pb::LogLine {
                        vm_id: vm_id.clone(),
                        at: None,
                        stream: l.level.clone(),
                        text: l.message,
                        attrs: std::collections::HashMap::from([
                            ("level".to_string(), l.level),
                            ("ts".to_string(), l.timestamp),
                        ]),
                    },
                    proto::RuntimeEvent::Exited(e) => pb::LogLine {
                        vm_id: vm_id.clone(),
                        at: None,
                        stream: "harness".to_string(),
                        text: format!("exited code={} error={}", e.exit_code, e.error),
                        attrs: std::collections::HashMap::from([
                            ("event".to_string(), "exited".to_string()),
                            ("exit_code".to_string(), e.exit_code.to_string()),
                        ]),
                    },
                    other => pb::LogLine {
                        vm_id: vm_id.clone(),
                        at: None,
                        stream: "harness".to_string(),
                        text: format!("{other:?}"),
                        attrs: std::collections::HashMap::new(),
                    },
                };

                if tx.send(Ok(line)).await.is_err() {
                    break;
                }

                if is_exit {
                    registry.deregister(&vm_id);
                    break;
                }
            }
        });

        let stream: Self::LogsStream = Box::pin(ReceiverStream::new(rx));
        Ok(Response::new(stream))
    }

    type ExecStream = Pin<
        Box<dyn tokio_stream::Stream<Item = Result<pb::ExecResponse, Status>> + Send + 'static>,
    >;

    async fn exec(
        &self,
        _request: Request<tonic::Streaming<pb::ExecRequest>>,
    ) -> Result<Response<Self::ExecStream>, Status> {
        // Exec-into-VM debugger is a separate workstream; the backends
        // don't expose a generic exec primitive yet (Docker has one, k8s
        // does too, Firecracker requires a harness channel). Be explicit
        // rather than ship a half-built bridge.
        Err(Status::unimplemented(
            "exec: live debugger channel not yet wired through backends",
        ))
    }

    type StatsStream = Pin<
        Box<dyn tokio_stream::Stream<Item = Result<pb::ResourceUsage, Status>> + Send + 'static>,
    >;

    async fn stats(
        &self,
        _request: Request<pb::StatsRequest>,
    ) -> Result<Response<Self::StatsStream>, Status> {
        // ResourceUsage roll-up is collected by the harness via the
        // Heartbeat stream; there's no per-backend polling primitive in
        // the current trait. Returning unimplemented is more honest than
        // fabricating zero-valued samples.
        Err(Status::unimplemented(
            "stats: harness-driven usage roll-up not yet wired",
        ))
    }
}
