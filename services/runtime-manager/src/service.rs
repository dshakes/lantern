use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use dashmap::DashMap;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

use crate::backend::RuntimeBackend;
use crate::handle_registry::{HandleInfo, HandleRegistry};
use crate::pool::{PoolConfig, WarmPool};
use crate::proto;
use crate::proto::pb;
use crate::secret_resolver::SecretResolver;
use crate::snapshot_store::SnapshotStore;

// ---------------------------------------------------------------------------
// Heartbeat cache
//
// The in-VM harness sends `HeartbeatRequest` messages over the bidirectional
// `RuntimeHarness::Heartbeat` stream.  Each message carries a `ResourceUsage`
// snapshot.  We cache the last-seen usage per `vm_id` so the stats dispatch
// layer can serve resource metrics for backends (Firecracker) that cannot be
// polled directly from the manager host.
//
// An entry is considered stale when it has not been refreshed within
// `HEARTBEAT_STALE_SECS`.  Stale entries are not evicted automatically (the
// harness reconnects after a socket reset); the stats path surfaces a clear
// "stale" error rather than returning silent zeroes.
// ---------------------------------------------------------------------------

/// Maximum age (seconds) before a cached heartbeat entry is considered stale.
pub const HEARTBEAT_STALE_SECS: u64 = 30;

/// Shared heartbeat cache: `vm_id → (last ResourceUsage, time of last update)`.
pub type HeartbeatCache = Arc<DashMap<String, (pb::ResourceUsage, Instant)>>;

// ---------------------------------------------------------------------------
// Harness dial-back addresses
//
// The manager cannot reach into a Firecracker guest through the backend (no
// host-side exec channel — the jailer owns the VM process). Instead, the
// in-guest harness serves `RuntimeHarness.Exec` on its tap address, and the
// manager learns that address from the PEER of the harness's Heartbeat
// stream. This map caches `vm_id → guest IP`; the exec dispatch dials
// `http://<guest_ip>:<LANTERN_HARNESS_EXEC_PORT>` and forwards the stream.
// ---------------------------------------------------------------------------

/// Shared harness dial-back map: `vm_id → guest IP` (from the Heartbeat peer).
pub type HarnessAddrs = Arc<DashMap<String, std::net::IpAddr>>;

/// Port the in-guest harness exec server listens on. Must match the
/// harness's `LANTERN_HARNESS_EXEC_ADDR` (default `0.0.0.0:50056`).
const DEFAULT_HARNESS_EXEC_PORT: u16 = 50056;

fn harness_exec_port() -> u16 {
    std::env::var("LANTERN_HARNESS_EXEC_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_HARNESS_EXEC_PORT)
}

// ---------------------------------------------------------------------------
// Isolation-class → backend routing (ADR-0009)
//
// Invariant: Hostile and Untrusted workloads MUST have hardware/kernel
// isolation. Under the default K8s substrate this is expressed as a hardened
// runtimeClassName (gVisor for Untrusted, Kata for Hostile). Each backend
// declares its capability via `RuntimeBackend::satisfies_isolation`; the
// `choose_backend` function is the single authoritative gate — it is called
// per-request and never silently downgrades a workload.
//
// Trusted/Standard/Wasm/Devcontainer may use the node's configured default
// backend (controlled by RUNTIME_BACKEND env var on the manager; default: k8s).
// ---------------------------------------------------------------------------

/// Per-request backend selection result.
enum BackendChoice {
    /// Use the provided backend directly.
    Use(Arc<dyn RuntimeBackend>),
    /// The required backend is not available on this node.
    Unavailable(String),
}

/// Map an isolation class to the correct backend, hard-failing if the node's
/// configured backend cannot satisfy the required isolation level.
///
/// # Security invariant
///
/// `Hostile` and `Untrusted` MUST have hardware/kernel isolation. Under the K8s
/// substrate that means a hardened `runtimeClassName` (gVisor for untrusted, Kata
/// for hostile). Each backend declares its capability via
/// [`RuntimeBackend::satisfies_isolation`]; if it returns `false` the request is
/// refused with `Status::failed_precondition` and nothing runs. A node whose
/// backend cannot satisfy the class will never silently downgrade the workload.
fn choose_backend(
    isolation_class: proto::IsolationClass,
    default_backend: &Arc<dyn RuntimeBackend>,
) -> BackendChoice {
    if default_backend.satisfies_isolation(isolation_class) {
        BackendChoice::Use(Arc::clone(default_backend))
    } else {
        let name = default_backend.name();
        let hint = match isolation_class {
            proto::IsolationClass::Untrusted => "UNTRUSTED requires the gVisor RuntimeClass; \
                 set LANTERN_RUNTIMECLASS_GVISOR on a node that has gVisor installed"
                .to_string(),
            proto::IsolationClass::Hostile => "HOSTILE requires the Kata RuntimeClass; \
                 set LANTERN_RUNTIMECLASS_KATA on a node that has Kata Containers installed"
                .to_string(),
            _ => format!(
                "isolation_class {:?} is not supported by the '{}' backend",
                isolation_class, name
            ),
        };
        BackendChoice::Unavailable(format!(
            "isolation_class {:?} cannot be satisfied by the '{}' backend on this node: {}.",
            isolation_class, name, hint
        ))
    }
}

/// gRPC service implementation for RuntimeManagerService.
///
/// Routes requests to the appropriate backend based on isolation class,
/// manages the warm pool and handle registry.
#[derive(Clone)]
pub struct RuntimeManagerGrpc {
    backend: Arc<dyn RuntimeBackend>,
    pool: Arc<WarmPool>,
    pub(crate) registry: Arc<HandleRegistry>,
    pub(crate) secret_resolver: Arc<dyn SecretResolver>,
    snapshot_store: Arc<SnapshotStore>,
    /// Heartbeat cache shared with `RuntimeHarnessGrpc`.  Stats for Firecracker
    /// VMs are served from here because the manager cannot poll a microVM guest
    /// directly; the in-VM harness reports usage via the Heartbeat stream.
    pub(crate) heartbeat_cache: HeartbeatCache,
    /// Harness dial-back addresses shared with `RuntimeHarnessGrpc`. Exec for
    /// Firecracker VMs is forwarded to the in-guest harness at the IP recorded
    /// from the Heartbeat stream's peer.
    pub(crate) harness_addrs: HarnessAddrs,
}

impl RuntimeManagerGrpc {
    pub fn new(
        backend: Arc<dyn RuntimeBackend>,
        pool_config: PoolConfig,
        secret_resolver: Arc<dyn SecretResolver>,
    ) -> Self {
        let pool = Arc::new(WarmPool::new(Arc::clone(&backend), pool_config));
        pool.start_reaper();

        let registry = Arc::new(HandleRegistry::new());
        let snapshot_store = Arc::new(SnapshotStore::from_env());
        let heartbeat_cache: HeartbeatCache = Arc::new(DashMap::new());
        let harness_addrs: HarnessAddrs = Arc::new(DashMap::new());

        Self {
            backend,
            pool,
            registry,
            secret_resolver,
            snapshot_store,
            heartbeat_cache,
            harness_addrs,
        }
    }

    /// Build the `RuntimeHarnessGrpc` that shares this manager's registry and
    /// heartbeat cache.  Call this after `new()` to get the paired harness
    /// service that writes into the same cache the manager reads from.
    pub fn harness_service(&self, mtls_enabled: bool) -> RuntimeHarnessGrpc {
        RuntimeHarnessGrpc::new(
            Arc::clone(&self.registry),
            Arc::clone(&self.secret_resolver),
            Arc::clone(&self.heartbeat_cache),
            Arc::clone(&self.harness_addrs),
            mtls_enabled,
        )
    }

    pub fn with_snapshot_store(mut self, store: SnapshotStore) -> Self {
        self.snapshot_store = Arc::new(store);
        self
    }

    /// Map an anyhow error to a tonic Status.
    fn to_status(e: anyhow::Error) -> Status {
        // `{:#}` renders the full anyhow source chain (top context + every
        // `.context()` cause), not just the outermost message — otherwise a
        // wrapped failure like "failed to boot microVM" hides the real cause
        // (e.g. the `ip tuntap add` stderr). The Status message carries the
        // chain too so a gRPC client sees the actual reason.
        tracing::error!(error = format!("{e:#}"), "runtime manager error");
        Status::internal(format!("{e:#}"))
    }

    /// Decide where an exec for `vm_id` goes.
    ///
    /// Firecracker VMs cannot be exec'd through the backend (the manager has
    /// no host-side channel into the guest), so they route to the in-guest
    /// harness at the address learned from its Heartbeat peer. A firecracker
    /// VM whose harness has never connected yields `FAILED_PRECONDITION`.
    /// Every other backend keeps the existing `backend.exec_command` path.
    // `Status` is ~176 bytes by design (tonic uses it everywhere); a one-shot
    // routing helper isn't going to gain anything from boxing it.
    #[allow(clippy::result_large_err)]
    fn route_exec(&self, vm_id: &str) -> Result<ExecRoute, Status> {
        let info = self
            .registry
            .get(vm_id)
            .ok_or_else(|| Status::not_found(format!("vm {vm_id} not found")))?;

        if info.backend != "firecracker" {
            return Ok(ExecRoute::Backend {
                handle_id: info.handle_id,
            });
        }

        let guest_ip = self
            .harness_addrs
            .get(vm_id)
            .map(|entry| *entry.value())
            .ok_or_else(|| {
                Status::failed_precondition(format!(
                    "harness not connected for vm '{vm_id}': no heartbeat-derived guest \
                     address yet — exec into a firecracker guest requires the in-VM \
                     harness to have opened its Heartbeat stream"
                ))
            })?;

        // SocketAddr Display brackets IPv6 correctly for the URI.
        let sock = std::net::SocketAddr::new(guest_ip, harness_exec_port());
        Ok(ExecRoute::Harness {
            endpoint: format!("http://{sock}"),
        })
    }
}

/// Where an exec request is dispatched (see [`RuntimeManagerGrpc::route_exec`]).
#[derive(Debug)]
enum ExecRoute {
    /// Run through the backend's host-side exec channel (docker/kata/k8s/...).
    Backend { handle_id: String },
    /// Forward the stream to the in-guest harness exec server (firecracker).
    Harness { endpoint: String },
}

impl RuntimeManagerGrpc {
    /// Forward an exec to the in-guest harness exec server and relay its
    /// response frames back to the caller.
    ///
    /// The first frame is forwarded verbatim — including the `tty`,
    /// `term_rows`/`term_cols`, and `term` fields. For interactive execs
    /// (`first.tty == true`) the caller's remaining frames (stdin bytes) are
    /// relayed to the guest too via `caller_stream`; for one-shot execs
    /// `caller_stream` is `None` and the request stream half-closes after
    /// the first frame, exactly as before (stdin is not piped, mirroring the
    /// docker backend path; the harness drains any extra frames on its side
    /// too). The hop is plaintext over the VM's host-local tap link; mTLS
    /// for this listener rides on the per-VM cert provisioning tracked in
    /// `tls.rs`.
    fn exec_via_harness(
        first: pb::ExecRequest,
        caller_stream: Option<tonic::Streaming<pb::ExecRequest>>,
        endpoint: String,
    ) -> Pin<Box<dyn tokio_stream::Stream<Item = Result<pb::ExecResponse, Status>> + Send + 'static>>
    {
        tracing::info!(
            vm_id = %first.vm_id,
            endpoint = %endpoint,
            command = %first.command,
            argv = ?first.argv,
            tty = first.tty,
            "exec: forwarding to in-guest harness"
        );

        let (tx, rx) = mpsc::channel::<Result<pb::ExecResponse, Status>>(64);

        // Outbound request stream toward the harness: the first frame, then
        // — interactive only — every stdin frame the caller sends. Dropping
        // `req_tx` half-closes the stream toward the guest.
        let (req_tx, req_rx) = mpsc::channel::<pb::ExecRequest>(64);
        tokio::spawn(async move {
            if req_tx.send(first).await.is_err() {
                return;
            }
            let Some(mut caller_stream) = caller_stream else {
                return; // one-shot: half-close after the first frame
            };
            while let Ok(Some(frame)) = caller_stream.message().await {
                if req_tx.send(frame).await.is_err() {
                    // Harness side hung up; stop relaying.
                    break;
                }
            }
        });

        tokio::spawn(async move {
            let mut client =
                match pb::runtime_harness_client::RuntimeHarnessClient::connect(endpoint.clone())
                    .await
                {
                    Ok(client) => client,
                    Err(e) => {
                        let _ = tx
                            .send(Err(Status::unavailable(format!(
                                "exec: cannot reach in-guest harness at {endpoint}: {e}"
                            ))))
                            .await;
                        return;
                    }
                };

            let mut inbound = match client.exec(ReceiverStream::new(req_rx)).await {
                Ok(resp) => resp.into_inner(),
                Err(status) => {
                    let _ = tx.send(Err(status)).await;
                    return;
                }
            };

            loop {
                match inbound.message().await {
                    Ok(Some(frame)) => {
                        if tx.send(Ok(frame)).await.is_err() {
                            // Caller hung up; stop relaying.
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(status) => {
                        let _ = tx.send(Err(status)).await;
                        break;
                    }
                }
            }
        });

        Box::pin(ReceiverStream::new(rx))
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

        // Select the backend per-request based on isolation class (ADR-0009).
        // Hostile/Untrusted MUST have hardware/kernel isolation; if the backend
        // cannot satisfy the class, refuse here — never a silent downgrade.
        let backend = match choose_backend(req.isolation_class, &self.backend) {
            BackendChoice::Use(b) => b,
            BackendChoice::Unavailable(reason) => {
                tracing::error!(
                    run_id = %req.run_id,
                    isolation_class = ?req.isolation_class,
                    configured_backend = self.backend.name(),
                    reason = %reason,
                    "SECURITY: refusing to schedule — required backend unavailable"
                );
                return Err(Status::failed_precondition(reason));
            }
        };

        tracing::info!(
            run_id = %req.run_id,
            isolation_class = ?req.isolation_class,
            backend = backend.name(),
            "scheduling run"
        );

        // Cold-start: call the chosen backend directly. The warm pool is not
        // consulted here because pool.acquire() uses the pool's own backend
        // (set at construction time) and does not go through `choose_backend`,
        // meaning it would bypass the isolation gate. If warm-pool support is
        // added in the future it must propagate the post-gate `backend` arc,
        // not the pool's stored backend, to preserve the security invariant.
        let handle = backend.schedule(&req).await.map_err(Self::to_status)?;

        // Use the authenticated tenant_id field — never the env map. The env
        // map is caller-supplied; reading it here would re-introduce the same
        // namespace-escape the spawn gate above was designed to close.
        let tenant_id = req.tenant_id.clone();

        // Register the handle. `declared_secret_uris` is sourced from the
        // manager's own spawn record (via `req.secrets`) — never from
        // anything the harness can assert later.
        let declared_secret_uris: Vec<String> =
            req.secrets.iter().map(|s| s.vault_ref.clone()).collect();

        self.registry.register(HandleInfo {
            handle_id: handle.id.clone(),
            run_id: req.run_id.clone(),
            tenant_id,
            backend: backend.name().to_string(),
            isolation_class: req.isolation_class,
            created_at: chrono::Utc::now(),
            resource_limits: req.limits.clone(),
            node_name: handle.node_name.clone(),
            declared_secret_uris,
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

    /// Create a snapshot of a running sandbox and persist it through the store.
    ///
    /// Only Firecracker and Kata backends support snapshotting; all others
    /// return `Status::unimplemented` so callers can distinguish "backend
    /// doesn't support this" from a real failure.
    pub async fn snapshot(
        &self,
        request: Request<proto::SnapshotRequest>,
    ) -> Result<Response<proto::SnapshotResponse>, Status> {
        let req = request.into_inner();

        // Fail fast with a clear error for backends that cannot snapshot.
        let backend_name = self.backend.name();
        if backend_name != "firecracker" && backend_name != "kata" {
            return Err(Status::unimplemented(format!(
                "snapshot is not supported by the '{}' backend; \
                 only firecracker and kata backends support persistent snapshots",
                backend_name
            )));
        }

        tracing::info!(handle_id = %req.handle_id, backend = backend_name, "creating snapshot");

        // Invoke the backend.  On Linux + Firecracker the files are written to
        // /run/lantern/snapshots/<vm_id>/{snapshot,mem}.  We don't need the
        // SnapshotInfo returned here (uri + size are derived from the store
        // after persisting the artifacts), but we must propagate any error.
        let _backend_info = self.backend.snapshot(&req).await.map_err(Self::to_status)?;

        // Persist through the store.  The snapshot_uri from the backend is a
        // path like `fc:///run/lantern/snapshots/<vm_id>/snapshot`; the actual
        // files are already written to disk by the Firecracker backend.
        // We read them back and hand the bytes to the store so the store owns
        // the canonical copy under SNAPSHOT_DIR and can enforce retention.
        //
        // Derive the agent_version_id from the handle registry (the handle
        // was registered with LANTERN_AGENT_VERSION_ID in the env map at
        // spawn time).  HandleInfo doesn't carry a dedicated agent_version_id
        // field today; fall back to "unknown" when absent.
        let agent_version_id = self
            .registry
            .get(&req.handle_id)
            .map(|_h| "unknown".to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let vm_id = req.handle_id.clone();

        // Build artifact map from the files the backend produced.
        // Firecracker puts snapshot + mem under /run/lantern/snapshots/<vm_id>/.
        let snapshot_base = format!("/run/lantern/snapshots/{vm_id}");
        let artifact_paths = vec![
            format!("{snapshot_base}/snapshot"),
            format!("{snapshot_base}/mem"),
        ];

        let mut artifacts = crate::snapshot_store::ArtifactMap::new();
        for path in &artifact_paths {
            match tokio::fs::read(path).await {
                Ok(bytes) => {
                    let name = std::path::Path::new(path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(path)
                        .to_string();
                    artifacts.push((name, bytes));
                }
                Err(e) => {
                    tracing::warn!(
                        path = %path,
                        error = %e,
                        "snapshot: artifact file not readable; storing empty bytes"
                    );
                    let name = std::path::Path::new(path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(path)
                        .to_string();
                    artifacts.push((name, vec![]));
                }
            }
        }

        let meta = self
            .snapshot_store
            .put(&agent_version_id, &vm_id, artifacts)
            .await
            .map_err(|e| {
                tracing::error!(
                    vm_id = %vm_id,
                    error = %e,
                    "snapshot_store: put failed"
                );
                Status::internal(format!("snapshot store error: {e}"))
            })?;

        tracing::info!(
            snapshot_id = %meta.id,
            sha256 = %meta.sha256,
            size_bytes = meta.size_bytes,
            vm_id = %vm_id,
            "snapshot persisted to store"
        );

        Ok(Response::new(proto::SnapshotResponse {
            snapshot_uri: format!("store://{}", meta.id),
            size_bytes: meta.size_bytes as i64,
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

        // Fail closed: an untenanted restore is refused. The caller is
        // responsible for populating `tenant_id` from the authenticated JWT
        // before constructing a RestoreRequest.
        if req.tenant_id.is_empty() {
            return Err(Status::invalid_argument(
                "RestoreRequest.tenant_id is required; refusing to restore an untenanted workload",
            ));
        }

        let handle = self
            .backend
            .restore(&req.snapshot_uri, &req)
            .await
            .map_err(Self::to_status)?;

        // Use the authenticated tenant_id field — never the env map.
        let tenant_id = req.tenant_id.clone();

        // Register the restored handle. Secrets from a restore use the
        // declared list carried in the RestoreRequest.
        let declared_secret_uris: Vec<String> =
            req.secrets.iter().map(|s| s.vault_ref.clone()).collect();

        self.registry.register(HandleInfo {
            handle_id: handle.id.clone(),
            run_id: req.run_id.clone(),
            tenant_id,
            backend: self.backend.name().to_string(),
            isolation_class: proto::IsolationClass::Unspecified,
            created_at: chrono::Utc::now(),
            resource_limits: proto::ResourceLimits::default(),
            node_name: handle.node_name.clone(),
            declared_secret_uris,
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
// into a `tokio_stream::wrappers::ReceiverStream` of `pb::RuntimeLogLine`.
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

    // Security invariant (multi-tenant isolation, ADR-0007):
    // `spec.tenant_id` is the authenticated value set by the control-plane
    // from the JWT. Reject empty values fail-closed so an untenanted workload
    // can never land in any real namespace.
    if spec.tenant_id.is_empty() {
        return Err(Status::invalid_argument(
            "spec.tenant_id is required; refusing to schedule an untenanted workload",
        ));
    }

    // Build env from caller-supplied env + labels (for backwards-compat).
    // Strip any caller-supplied `LANTERN_TENANT_ID` first — the caller cannot
    // be trusted to set this correctly and a shadowed value would let an
    // attacker route the pod into a victim's namespace. Re-inject the
    // authenticated value so the workload still sees its own tenant id.
    let mut env: std::collections::HashMap<String, String> = spec.env.clone();
    for (k, v) in &spec.labels {
        env.entry(k.clone()).or_insert_with(|| v.clone());
    }
    // Strip then re-inject — order matters: strip first so a caller-supplied
    // value can never win even if it was present in the labels too.
    env.remove("LANTERN_TENANT_ID");
    env.insert("LANTERN_TENANT_ID".to_string(), spec.tenant_id.clone());
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
        tenant_id: spec.tenant_id.clone(),
        bundle_uri: spec.image_digest.clone(),
        bundle_digest,
        isolation_class: isolation,
        limits,
        env,
        secrets,
        input: serde_json::Value::Null,
        command: spec.command.clone(),
        args: spec.args.clone(),
        image: spec.image_digest.clone(),
        network_policy: proto::NetworkPolicyClass::from_i32(spec.network),
        egress_rules: spec
            .egress_rules
            .iter()
            .map(|r| proto::EgressRule {
                pattern: r.pattern.clone(),
                http_methods: r.http_methods.clone(),
                rate_bps: r.rate_bps,
            })
            .collect(),
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
        // When the scheduler pre-allocated a wire vm_id, rekey the registry
        // so subsequent Stop/Logs/Exec by wire id resolve to the backend
        // handle. Without this, the registry only knows the docker
        // container id and Stop(vm-uuid) silently no-ops.
        let backend_handle_id = resp.handle_id.clone();
        let vm_handle = match pre_handle {
            Some(h) if !h.vm_id.is_empty() => {
                self.registry.rekey(&backend_handle_id, &h.vm_id);
                h
            }
            _ => pb::VmHandle {
                vm_id: backend_handle_id,
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

        // Resolve the wire vm_id (issued by the scheduler) to the backend
        // handle id (docker container id / firecracker socket / pod name).
        // The registry was rekeyed to use the wire vm_id as the lookup key
        // in spawn(), and HandleInfo.handle_id still carries the backend id.
        let backend_handle = self
            .registry
            .get(&req.vm_id)
            .map(|h| h.handle_id)
            .unwrap_or_else(|| req.vm_id.clone());

        let internal = proto::RuntimeCancelRequest {
            handle_id: backend_handle,
            reason: req.reason,
            grace_period_seconds: grace_seconds,
        };

        match self.cancel(Request::new(internal)).await {
            Ok(_) => {
                // Cancel deregisters under the backend id; also drop the
                // wire-id alias so subsequent lookups 404.
                self.registry.deregister(&req.vm_id);
                Ok(Response::new(pb::StopResponse {
                    ok: true,
                    detail: format!("vm {} stopped", req.vm_id),
                }))
            }
            Err(status) => Ok(Response::new(pb::StopResponse {
                ok: false,
                detail: status.message().to_string(),
            })),
        }
    }

    type LogsStream = Pin<
        Box<dyn tokio_stream::Stream<Item = Result<pb::RuntimeLogLine, Status>> + Send + 'static>,
    >;

    async fn logs(
        &self,
        request: Request<pb::LogsRequest>,
    ) -> Result<Response<Self::LogsStream>, Status> {
        let req = request.into_inner();

        // Resolve wire vm_id → backend handle (docker container id).
        let info = self
            .registry
            .get(&req.vm_id)
            .ok_or_else(|| Status::not_found(format!("vm {} not found", req.vm_id)))?;

        let mut event_stream = self
            .backend
            .stream(&info.handle_id)
            .await
            .map_err(Self::to_status)?;

        let (tx, rx) = mpsc::channel::<Result<pb::RuntimeLogLine, Status>>(256);
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
                    proto::RuntimeEvent::Log(l) => pb::RuntimeLogLine {
                        vm_id: vm_id.clone(),
                        at: None,
                        stream: l.level.clone(),
                        text: l.message,
                        attrs: std::collections::HashMap::from([
                            ("level".to_string(), l.level),
                            ("ts".to_string(), l.timestamp),
                        ]),
                    },
                    proto::RuntimeEvent::Exited(e) => pb::RuntimeLogLine {
                        vm_id: vm_id.clone(),
                        at: None,
                        stream: "harness".to_string(),
                        text: format!("exited code={} error={}", e.exit_code, e.error),
                        attrs: std::collections::HashMap::from([
                            ("event".to_string(), "exited".to_string()),
                            ("exit_code".to_string(), e.exit_code.to_string()),
                        ]),
                    },
                    other => pb::RuntimeLogLine {
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
        request: Request<tonic::Streaming<pb::ExecRequest>>,
    ) -> Result<Response<Self::ExecStream>, Status> {
        let mut stream = request.into_inner();

        // The first message MUST carry vm_id and command; subsequent messages
        // carry stdin bytes (forwarded to the exec process via the channel).
        // We collect stdin-bearing messages eagerly while streaming output.
        let first = stream
            .message()
            .await
            .map_err(|e| Status::internal(format!("exec: stream read error: {e}")))?
            .ok_or_else(|| Status::invalid_argument("exec: empty request stream"))?;

        if first.vm_id.is_empty() {
            return Err(Status::invalid_argument("exec: vm_id is required"));
        }
        if first.command.is_empty() {
            return Err(Status::invalid_argument(
                "exec: command is required in first message",
            ));
        }

        // Resolve wire vm_id → dispatch target. Firecracker VMs forward to
        // the in-guest harness; everything else goes through the backend.
        let route = self.route_exec(&first.vm_id)?;

        let handle_id = match route {
            ExecRoute::Harness { endpoint } => {
                // Interactive execs relay the caller's stdin frames into the
                // guest; one-shot execs half-close after the first frame and
                // drain the caller's stream (unchanged behavior).
                let caller_stream = if first.tty {
                    Some(stream)
                } else {
                    tokio::spawn(async move { while let Ok(Some(_)) = stream.message().await {} });
                    None
                };
                return Ok(Response::new(Self::exec_via_harness(
                    first,
                    caller_stream,
                    endpoint,
                )));
            }
            ExecRoute::Backend { handle_id } => handle_id,
        };

        // Backend route: stdin is never piped — even with a TTY the backend
        // exec is one-shot (the PTY gives programs a terminal, not
        // interactivity). Drain the remaining frames so the client does not
        // stall on a blocked send.
        tokio::spawn(async move { while let Ok(Some(_)) = stream.message().await {} });

        let backend = Arc::clone(&self.backend);
        let command = first.command.clone();
        let argv = first.argv.clone();
        let vm_id = first.vm_id.clone();
        let tty = first.tty;
        let term_rows = first.term_rows;
        let term_cols = first.term_cols;
        let term = first.term.clone();

        tracing::info!(
            vm_id = %vm_id,
            handle_id = %handle_id,
            command = %command,
            argv = ?argv,
            tty,
            "exec: dispatching to backend"
        );

        let (tx, rx) = mpsc::channel::<Result<pb::ExecResponse, Status>>(64);

        tokio::spawn(async move {
            let result = if tty {
                backend
                    .exec_command_tty(&handle_id, &command, &argv, term_rows, term_cols, &term)
                    .await
            } else {
                backend.exec_command(&handle_id, &command, &argv).await
            };
            match result {
                Ok(output) => {
                    // Send stdout chunk.
                    if !output.stdout.is_empty() {
                        let _ = tx
                            .send(Ok(pb::ExecResponse {
                                stdout: output.stdout,
                                stderr: vec![],
                                exit_code: 0,
                                done: false,
                            }))
                            .await;
                    }
                    // Send stderr chunk.
                    if !output.stderr.is_empty() {
                        let _ = tx
                            .send(Ok(pb::ExecResponse {
                                stdout: vec![],
                                stderr: output.stderr,
                                exit_code: 0,
                                done: false,
                            }))
                            .await;
                    }
                    // Final frame: exit code + done=true.
                    let _ = tx
                        .send(Ok(pb::ExecResponse {
                            stdout: vec![],
                            stderr: vec![],
                            exit_code: output.exit_code,
                            done: true,
                        }))
                        .await;
                }
                Err(e) => {
                    let msg = e.to_string();
                    // Distinguish "backend does not support exec" from real errors.
                    let status = if msg.contains("exec not supported by") {
                        Status::unimplemented(format!(
                            "exec not yet supported for '{}' isolation backend",
                            backend.name()
                        ))
                    } else {
                        tracing::error!(
                            vm_id = %vm_id,
                            error = %e,
                            "exec: backend error"
                        );
                        Status::internal(msg)
                    };
                    let _ = tx.send(Err(status)).await;
                }
            }
        });

        let out_stream: Self::ExecStream = Box::pin(ReceiverStream::new(rx));
        Ok(Response::new(out_stream))
    }

    async fn snapshot(
        &self,
        request: Request<pb::SnapshotRequest>,
    ) -> Result<Response<pb::SnapshotResponse>, Status> {
        let req = request.into_inner();

        // Map the wire SnapshotRequest to the internal one.
        // The wire vm_id maps to handle_id; we look up the registry so the
        // backend sees the backend-side handle id (container id / socket path).
        let backend_handle = self
            .registry
            .get(&req.vm_id)
            .map(|h| h.handle_id)
            .unwrap_or_else(|| req.vm_id.clone());

        let internal = proto::SnapshotRequest {
            handle_id: backend_handle,
            bundle_digest: vec![],
            isolation_class: proto::IsolationClass::Unspecified,
        };

        let resp = self.snapshot(Request::new(internal)).await?.into_inner();

        // Map the internal SnapshotResponse to the wire SnapshotResponse.
        // snapshot_uri is "store://<id>"; extract the id.
        let snapshot_id = resp
            .snapshot_uri
            .strip_prefix("store://")
            .unwrap_or(&resp.snapshot_uri)
            .to_string();

        Ok(Response::new(pb::SnapshotResponse {
            snapshot_id,
            bytes: resp.size_bytes,
            sha256: String::new(), // populated on the scheduler side from the store meta
        }))
    }

    type StatsStream = Pin<
        Box<dyn tokio_stream::Stream<Item = Result<pb::ResourceUsage, Status>> + Send + 'static>,
    >;

    async fn stats(
        &self,
        request: Request<pb::StatsRequest>,
    ) -> Result<Response<Self::StatsStream>, Status> {
        let req = request.into_inner();

        if req.vm_id.is_empty() {
            return Err(Status::invalid_argument("stats: vm_id is required"));
        }

        // Resolve wire vm_id → backend handle_id.
        let info = self
            .registry
            .get(&req.vm_id)
            .ok_or_else(|| Status::not_found(format!("vm {} not found", req.vm_id)))?;

        // Parse the requested polling interval (default 5 s).
        let interval_secs = req
            .interval
            .as_ref()
            .map(|d| d.seconds.max(1) as u64)
            .unwrap_or(5);

        let backend = Arc::clone(&self.backend);
        let handle_id = info.handle_id.clone();
        let vm_id = req.vm_id.clone();
        // Firecracker stats are served from the heartbeat cache: the manager
        // cannot poll a microVM guest directly, but the in-VM harness reports
        // resource usage via `RuntimeHarness::Heartbeat`.
        let heartbeat_cache = Arc::clone(&self.heartbeat_cache);
        let is_firecracker = backend.name() == "firecracker";

        tracing::info!(
            vm_id = %vm_id,
            handle_id = %handle_id,
            interval_secs,
            "stats: starting polling stream"
        );

        let (tx, rx) = mpsc::channel::<Result<pb::ResourceUsage, Status>>(32);

        tokio::spawn(async move {
            loop {
                // For Firecracker VMs, serve the last heartbeat from the cache
                // rather than asking the backend (which has no guest-poll path).
                let result = if is_firecracker {
                    match heartbeat_cache.get(&vm_id) {
                        Some(entry) => {
                            let (usage, updated_at) = entry.value();
                            if updated_at.elapsed().as_secs() > HEARTBEAT_STALE_SECS {
                                Err(anyhow::anyhow!(
                                    "firecracker stats: last heartbeat from vm '{}' is stale \
                                     ({}s ago, threshold {}s); harness may have stopped reporting",
                                    vm_id,
                                    updated_at.elapsed().as_secs(),
                                    HEARTBEAT_STALE_SECS,
                                ))
                            } else {
                                Ok(crate::backend::StatsSample {
                                    vcpu_ms_used: usage.vcpu_ms_used,
                                    memory_bytes: usage.memory_bytes,
                                    network_bytes_in: usage.network_bytes_in,
                                    network_bytes_out: usage.network_bytes_out,
                                })
                            }
                        }
                        None => Err(anyhow::anyhow!(
                            "firecracker stats: no heartbeat received yet for vm '{}'; \
                             the in-VM harness reports usage via the Heartbeat stream — \
                             wait for the first heartbeat before polling stats",
                            vm_id,
                        )),
                    }
                } else {
                    backend.stats_sample(&handle_id).await
                };

                match result {
                    Ok(sample) => {
                        let usage = pb::ResourceUsage {
                            vcpu_ms_used: sample.vcpu_ms_used,
                            memory_bytes: sample.memory_bytes,
                            network_bytes_in: sample.network_bytes_in,
                            network_bytes_out: sample.network_bytes_out,
                            disk_bytes: 0,
                            cost_usd_accumulated: 0.0,
                        };
                        if tx.send(Ok(usage)).await.is_err() {
                            // Client disconnected.
                            break;
                        }
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        let status = if msg.contains("stats not supported by") {
                            Status::unimplemented(format!(
                                "stats not yet supported for '{}' isolation backend",
                                backend.name()
                            ))
                        } else if msg.contains("no heartbeat received yet")
                            || msg.contains("heartbeat") && msg.contains("stale")
                        {
                            // Firecracker-specific: heartbeat not yet / stale.
                            Status::unavailable(msg)
                        } else {
                            tracing::warn!(
                                vm_id = %vm_id,
                                error = %e,
                                "stats: sample error"
                            );
                            Status::internal(msg)
                        };
                        let _ = tx.send(Err(status)).await;
                        break;
                    }
                }

                tokio::time::sleep(tokio::time::Duration::from_secs(interval_secs)).await;
            }
        });

        let out_stream: Self::StatsStream = Box::pin(ReceiverStream::new(rx));
        Ok(Response::new(out_stream))
    }
}

// ---------------------------------------------------------------------------
// RuntimeHarness gRPC service — VendSecret + (stub) Heartbeat / Report
// ---------------------------------------------------------------------------
//
// Authentication model
// --------------------
// The harness sends its `vm_id` in every `VendSecretRequest`. The manager
// resolves that `vm_id` against its OWN handle registry — populated at
// spawn time, never modifiable by the harness. From the registry entry the
// manager reads:
//
//   • `tenant_id` and `run_id`  — authoritative identity; never taken from
//                                  anything the harness asserts.
//   • `declared_secret_uris`    — the allowlist from the `AgentSpec.secrets`
//                                  that the scheduler/control-plane set when
//                                  this VM was spawned.
//
// Any `secret_uri` not on that list is rejected with `PERMISSION_DENIED`,
// regardless of what the harness sends.
//
// The current transport is plain gRPC-over-TCP. Production hardening adds
// mTLS (manager's CA signs per-VM client certs at spawn, certificate CN is
// the `vm_id`) or vsock peer-identity checks for Firecracker VMs. That is
// documented in the ADR but not yet enforced here — see `UNVERIFIED` note
// in the implementation report.
//
// TTL cap
// -------
// The caller MAY request a TTL via the `ttl` field. The manager caps it at
// `MAX_SECRET_TTL_SECS` (300 s) regardless, and uses that same value when
// the caller doesn't specify.

const MAX_SECRET_TTL_SECS: i64 = 300;

/// Service that handles inbound harness RPCs.
///
/// `registry` is shared with `RuntimeManagerGrpc` — the same Arc. Secrets
/// are resolved via an injected `SecretResolver` so tests can stub the
/// backend without touching real credentials.
#[derive(Clone)]
pub struct RuntimeHarnessGrpc {
    registry: Arc<HandleRegistry>,
    secret_resolver: Arc<dyn SecretResolver>,
    /// Heartbeat cache shared with `RuntimeManagerGrpc`.  Each inbound
    /// `HeartbeatRequest` updates this map; the stats dispatch layer reads it
    /// for Firecracker VMs.  Entries are written per-message; the stats layer
    /// enforces the `HEARTBEAT_STALE_SECS` staleness check on read.
    heartbeat_cache: HeartbeatCache,
    /// Harness dial-back map shared with `RuntimeManagerGrpc`. The Heartbeat
    /// handler records the stream's peer IP per `vm_id`; the exec dispatch
    /// dials it to forward `lantern vm exec` into Firecracker guests.
    harness_addrs: HarnessAddrs,
    /// When true, VendSecret enforces the client-cert ↔ vm_id identity check.
    /// Mirrors whether the manager's gRPC server is serving mTLS. In dev
    /// (plaintext) the check is skipped because no peer cert exists; in
    /// production the prod gate forces mTLS on, so this is always true there.
    mtls_enabled: bool,
}

impl RuntimeHarnessGrpc {
    pub fn new(
        registry: Arc<HandleRegistry>,
        secret_resolver: Arc<dyn SecretResolver>,
        heartbeat_cache: HeartbeatCache,
        harness_addrs: HarnessAddrs,
        mtls_enabled: bool,
    ) -> Self {
        Self {
            registry,
            secret_resolver,
            heartbeat_cache,
            harness_addrs,
            mtls_enabled,
        }
    }
}

#[tonic::async_trait]
impl pb::runtime_harness_server::RuntimeHarness for RuntimeHarnessGrpc {
    type HeartbeatStream = Pin<
        Box<dyn tokio_stream::Stream<Item = Result<pb::HeartbeatAck, Status>> + Send + 'static>,
    >;

    async fn heartbeat(
        &self,
        request: Request<tonic::Streaming<pb::HeartbeatRequest>>,
    ) -> Result<Response<Self::HeartbeatStream>, Status> {
        // Capture the peer address AND peer cert BEFORE consuming the request.
        // The cert is per-connection and is only accessible on the original
        // `Request<Streaming<...>>`; after `into_inner()` it is gone.
        let peer_ip = request.remote_addr().map(|addr| addr.ip());
        // Clone the cert bytes here (cheap — it's just a Vec<u8>).
        let peer_cert_der = crate::tls::extract_peer_cert_der(&request);
        let mtls_enabled = self.mtls_enabled;
        let mut inbound = request.into_inner();
        let cache = Arc::clone(&self.heartbeat_cache);
        let registry = Arc::clone(&self.registry);
        let harness_addrs = Arc::clone(&self.harness_addrs);

        let (tx, rx) = mpsc::channel::<Result<pb::HeartbeatAck, Status>>(64);

        tokio::spawn(async move {
            loop {
                match inbound.message().await {
                    Ok(Some(hb)) => {
                        if hb.vm_id.is_empty() {
                            tracing::warn!(
                                "heartbeat: received message with empty vm_id; skipping"
                            );
                            continue;
                        }

                        // SECURITY: bind the claimed vm_id to this connection's
                        // client certificate. An attacker VM that sends
                        // HeartbeatRequest{vm_id:"vm-victim"} to poison
                        // harness_addrs["vm-victim"] (exec-hijack) is stopped
                        // here: the cert CN/SAN must match the claimed vm_id.
                        // Mirrors the identical check in `vend_secret`.
                        if mtls_enabled
                            && crate::tls::authorize_vm_cert(&hb.vm_id, peer_cert_der.as_deref())
                                .is_err()
                        {
                            tracing::warn!(
                                vm_id = %hb.vm_id,
                                "heartbeat: cert/vm_id mismatch — dropping message"
                            );
                            continue;
                        }

                        // Only accept heartbeats from VMs we actually spawned.
                        // Silently skipping keeps the stream alive so the harness
                        // isn't penalised for a racy reconnect during boot.
                        if registry.get(&hb.vm_id).is_none() {
                            tracing::debug!(
                                vm_id = %hb.vm_id,
                                "heartbeat: vm_id not registered; skipping (may be a reconnect race)"
                            );
                            // IMPORTANT: continue here — do NOT fall through to the
                            // cache/harness_addrs writes for an unregistered vm_id.
                            continue;
                        }

                        // Update the cache — vm_id is now cert-bound and registered.
                        let usage = hb.usage.unwrap_or_default();
                        tracing::debug!(
                            vm_id = %hb.vm_id,
                            vcpu_ms = usage.vcpu_ms_used,
                            mem_bytes = usage.memory_bytes,
                            worker_pid = hb.worker_pid,
                            restart_count = hb.restart_count,
                            "heartbeat received"
                        );
                        cache.insert(hb.vm_id.clone(), (usage, Instant::now()));

                        // Record the dial-back address for exec forwarding.
                        if let Some(ip) = peer_ip {
                            harness_addrs.insert(hb.vm_id.clone(), ip);
                        }

                        // Send an ack (no overrides in this implementation).
                        if tx
                            .send(Ok(pb::HeartbeatAck {
                                egress_overrides: vec![],
                                limits_override: None,
                                drain: false,
                                snapshot: false,
                            }))
                            .await
                            .is_err()
                        {
                            // Harness disconnected; stop reading.
                            break;
                        }
                    }
                    Ok(None) => {
                        // Harness closed its sending side cleanly (e.g. VM
                        // shutting down).  Close the ack stream gracefully.
                        tracing::debug!("heartbeat: inbound stream closed by harness");
                        break;
                    }
                    Err(e) => {
                        // Transport error.  Log and close; the harness will
                        // reconnect.
                        tracing::warn!(error = %e, "heartbeat: stream error; closing");
                        break;
                    }
                }
            }
        });

        let stream: Self::HeartbeatStream = Box::pin(ReceiverStream::new(rx));
        Ok(Response::new(stream))
    }

    /// Vend a short-TTL secret value for a declared secret URI.
    ///
    /// Authorization steps (all performed against the manager's own registry):
    /// 1. `vm_id` MUST be registered — unknown VMs get `NOT_FOUND`.
    /// 2. `secret_uri` MUST appear in the VM's `declared_secret_uris` —
    ///    undeclared URIs get `PERMISSION_DENIED`.
    /// 3. The resolver is called; backend errors become `INTERNAL`.
    /// 4. TTL is capped at `MAX_SECRET_TTL_SECS`.
    async fn vend_secret(
        &self,
        request: Request<pb::VendSecretRequest>,
    ) -> Result<Response<pb::VendSecretResponse>, Status> {
        // Step 0: cryptographic peer-identity check. Extract the client cert
        // from the TLS session BEFORE consuming the request, then verify its
        // CN/SAN matches the claimed vm_id. This is auth by CA-signed cert,
        // not by network topology. Fail-closed: no cert OR wrong CN → DENIED.
        //
        // The check is skipped only when mTLS is not enabled on this manager
        // (dev plaintext); production forces mTLS on via the prod gate in
        // `tls::build_server_tls_config`, so the cert is always present there.
        let peer_cert_der = crate::tls::extract_peer_cert_der(&request);

        let req = request.into_inner();

        if self.mtls_enabled
            && let Err(reason) = crate::tls::authorize_vm_cert(&req.vm_id, peer_cert_der.as_deref())
        {
            tracing::warn!(
                vm_id = %req.vm_id,
                secret_uri = %req.secret_uri,
                reason = %reason,
                "VendSecret DENIED: client-cert identity check failed"
            );
            return Err(Status::permission_denied(reason));
        }

        // Step 1: look up the VM in the manager's own registry.
        let info = self
            .registry
            .get(&req.vm_id)
            .ok_or_else(|| Status::not_found(format!("vm_id '{}' not registered", req.vm_id)))?;

        // Step 2: enforce the declared-secrets allowlist.
        if !info.declared_secret_uris.contains(&req.secret_uri) {
            tracing::warn!(
                vm_id = %req.vm_id,
                secret_uri = %req.secret_uri,
                tenant_id = %info.tenant_id,
                run_id = %info.run_id,
                "VendSecret DENIED: uri not in declared allowlist"
            );
            return Err(Status::permission_denied(format!(
                "secret_uri '{}' is not declared in the AgentSpec for vm '{}'",
                req.secret_uri, req.vm_id
            )));
        }

        // Step 3: resolve the plaintext value.
        let value = self
            .secret_resolver
            .resolve(&req.secret_uri)
            .await
            .map_err(|e| {
                tracing::error!(
                    vm_id = %req.vm_id,
                    secret_uri = %req.secret_uri,
                    error = %e,
                    "VendSecret: resolver error (value NOT logged)"
                );
                Status::internal(format!(
                    "secret resolver error for uri '{}'",
                    req.secret_uri
                ))
            })?;

        // Step 4: compute expiry — cap at MAX_SECRET_TTL_SECS.
        let requested_secs = req
            .ttl
            .as_ref()
            .map(|d| d.seconds.max(1))
            .unwrap_or(MAX_SECRET_TTL_SECS);
        let ttl_secs = requested_secs.min(MAX_SECRET_TTL_SECS);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let expires_at_unix_secs = now.as_secs() as i64 + ttl_secs;

        tracing::info!(
            vm_id = %req.vm_id,
            secret_uri = %req.secret_uri,
            tenant_id = %info.tenant_id,
            run_id = %info.run_id,
            ttl_secs,
            "VendSecret: issued (value NOT logged)"
        );

        Ok(Response::new(pb::VendSecretResponse {
            value,
            expires_at: Some(prost_types::Timestamp {
                seconds: expires_at_unix_secs,
                nanos: 0,
            }),
        }))
    }

    // `report` is client-streaming: harness sends a stream of HarnessReport,
    // manager responds with a single HarnessAck.
    async fn report(
        &self,
        _request: Request<tonic::Streaming<pb::HarnessReport>>,
    ) -> Result<Response<pb::HarnessAck>, Status> {
        // Report ingestion (logs, traces, audit) is handled by a separate
        // subsystem; returning unimplemented keeps the trait satisfied without
        // silently discarding data the harness relies on.
        Err(Status::unimplemented(
            "report: log/trace ingestion pipeline not yet wired on the manager side",
        ))
    }

    type ExecStream = Pin<
        Box<dyn tokio_stream::Stream<Item = Result<pb::ExecResponse, Status>> + Send + 'static>,
    >;

    // `RuntimeHarness.Exec` is the one RPC of this service that is SERVED by
    // the in-guest harness, not by the manager (the manager is its CLIENT —
    // see `RuntimeManagerGrpc::exec_via_harness`). The method exists on the
    // manager's copy of the service only because tonic requires the full
    // trait; calling it here is always a dispatch error.
    async fn exec(
        &self,
        _request: Request<tonic::Streaming<pb::ExecRequest>>,
    ) -> Result<Response<Self::ExecStream>, Status> {
        Err(Status::unimplemented(
            "exec is served by the in-guest harness; call RuntimeManager.Exec on the \
             manager instead — it forwards to the right guest",
        ))
    }
}

// ---------------------------------------------------------------------------
// Tests for isolation-class → backend routing (ADR-0009)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream::BoxStream;
    // The `vend_secret` method is defined on the `RuntimeHarness` trait; tests
    // call it directly so the trait must be in scope.
    use pb::runtime_harness_server::RuntimeHarness as _;

    // Minimal stub that reports a configurable name and an explicit isolation
    // capability flag. The flag drives `satisfies_isolation` so we can exercise
    // `choose_backend` without wiring actual K8s/Firecracker backends.
    struct NamedStub {
        name: &'static str,
        /// When `true`, the stub accepts UNTRUSTED and HOSTILE (microVM semantics).
        /// When `false` (default), the conservative trait default applies.
        accepts_hostile: bool,
    }

    impl NamedStub {
        fn arc(name: &'static str) -> Arc<dyn RuntimeBackend> {
            Arc::new(Self {
                name,
                accepts_hostile: false,
            })
        }

        /// Build a microVM-style stub that accepts all isolation classes.
        fn microvm(name: &'static str) -> Arc<dyn RuntimeBackend> {
            Arc::new(Self {
                name,
                accepts_hostile: true,
            })
        }
    }

    #[async_trait::async_trait]
    impl RuntimeBackend for NamedStub {
        async fn schedule(
            &self,
            req: &proto::ScheduleRequest,
        ) -> anyhow::Result<crate::backend::Handle> {
            Ok(crate::backend::Handle {
                id: format!("stub-{}", req.run_id),
                node_name: "stub-node".to_string(),
                cold_start_ms: 0.0,
            })
        }
        async fn cancel(&self, _id: &str, _reason: &str) -> anyhow::Result<()> {
            Ok(())
        }
        async fn stream(
            &self,
            _id: &str,
        ) -> anyhow::Result<BoxStream<'static, proto::RuntimeEvent>> {
            use futures::stream;
            Ok(Box::pin(stream::empty()))
        }
        async fn snapshot(
            &self,
            _req: &proto::SnapshotRequest,
        ) -> anyhow::Result<crate::backend::SnapshotInfo> {
            Ok(crate::backend::SnapshotInfo {
                snapshot_uri: "stub://".to_string(),
                size_bytes: 0,
            })
        }
        async fn restore(
            &self,
            _uri: &str,
            _req: &proto::RestoreRequest,
        ) -> anyhow::Result<crate::backend::Handle> {
            Ok(crate::backend::Handle {
                id: "stub-restored".to_string(),
                node_name: "stub-node".to_string(),
                cold_start_ms: 0.0,
            })
        }
        fn name(&self) -> &'static str {
            self.name
        }

        fn satisfies_isolation(&self, class: proto::IsolationClass) -> bool {
            if self.accepts_hostile {
                true // microVM: accept everything
            } else {
                // conservative default
                !matches!(
                    class,
                    proto::IsolationClass::Untrusted | proto::IsolationClass::Hostile
                )
            }
        }
    }

    // --- choose_backend: trusted/standard always allowed on any backend ---

    #[test]
    fn trusted_allowed_on_docker() {
        let b = NamedStub::arc("docker");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Trusted, &b),
            BackendChoice::Use(_)
        ));
    }

    #[test]
    fn standard_allowed_on_k8s() {
        let b = NamedStub::arc("k8s");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Standard, &b),
            BackendChoice::Use(_)
        ));
    }

    #[test]
    fn unspecified_allowed_on_docker() {
        let b = NamedStub::arc("docker");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Unspecified, &b),
            BackendChoice::Use(_)
        ));
    }

    // --- choose_backend: Hostile/Untrusted HARD-FAIL when backend refuses ---

    #[test]
    fn hostile_refused_on_docker() {
        let b = NamedStub::arc("docker");
        match choose_backend(proto::IsolationClass::Hostile, &b) {
            BackendChoice::Unavailable(msg) => {
                assert!(
                    msg.contains("Kata RuntimeClass"),
                    "error should name the required RuntimeClass: {msg}"
                );
                assert!(
                    msg.contains("LANTERN_RUNTIMECLASS_KATA"),
                    "error should name the config env var: {msg}"
                );
            }
            BackendChoice::Use(_) => panic!("hostile must not be allowed on a non-microVM backend"),
        }
    }

    #[test]
    fn untrusted_refused_on_docker() {
        let b = NamedStub::arc("docker");
        match choose_backend(proto::IsolationClass::Untrusted, &b) {
            BackendChoice::Unavailable(msg) => {
                assert!(
                    msg.contains("gVisor RuntimeClass"),
                    "error should name the required RuntimeClass: {msg}"
                );
                assert!(
                    msg.contains("LANTERN_RUNTIMECLASS_GVISOR"),
                    "error should name the config env var: {msg}"
                );
            }
            BackendChoice::Use(_) => {
                panic!("untrusted must not be allowed on a non-microVM backend")
            }
        }
    }

    // The `NamedStub::arc` stubs use the conservative default — UNTRUSTED/HOSTILE
    // are refused regardless of name. These tests confirm the gate is purely
    // capability-based, not name-based.
    #[test]
    fn hostile_refused_on_k8s_without_kata() {
        let b = NamedStub::arc("k8s");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Hostile, &b),
            BackendChoice::Unavailable(_)
        ));
    }

    #[test]
    fn untrusted_refused_on_k8s_without_gvisor() {
        let b = NamedStub::arc("k8s");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Untrusted, &b),
            BackendChoice::Unavailable(_)
        ));
    }

    // --- choose_backend: Hostile/Untrusted ALLOWED on microVM-capable backends ---

    #[test]
    fn hostile_allowed_on_firecracker() {
        let b = NamedStub::microvm("firecracker");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Hostile, &b),
            BackendChoice::Use(_)
        ));
    }

    #[test]
    fn untrusted_allowed_on_firecracker() {
        let b = NamedStub::microvm("firecracker");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Untrusted, &b),
            BackendChoice::Use(_)
        ));
    }

    #[test]
    fn hostile_allowed_on_kata() {
        let b = NamedStub::microvm("kata");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Hostile, &b),
            BackendChoice::Use(_)
        ));
    }

    // --- ADR-0009: K8s with gVisor/Kata configured accepts the hard classes ---

    #[test]
    fn untrusted_allowed_on_k8s_with_gvisor_stub() {
        // A stub that reports it satisfies untrusted (simulates K8s+gVisor).
        struct GvisorStub;
        #[async_trait::async_trait]
        impl RuntimeBackend for GvisorStub {
            async fn schedule(
                &self,
                req: &proto::ScheduleRequest,
            ) -> anyhow::Result<crate::backend::Handle> {
                Ok(crate::backend::Handle {
                    id: req.run_id.clone(),
                    node_name: "n".to_string(),
                    cold_start_ms: 0.0,
                })
            }
            async fn cancel(&self, _: &str, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
            async fn stream(
                &self,
                _: &str,
            ) -> anyhow::Result<BoxStream<'static, proto::RuntimeEvent>> {
                Ok(Box::pin(futures::stream::empty()))
            }
            async fn snapshot(
                &self,
                _: &proto::SnapshotRequest,
            ) -> anyhow::Result<crate::backend::SnapshotInfo> {
                anyhow::bail!("stub")
            }
            async fn restore(
                &self,
                _: &str,
                _: &proto::RestoreRequest,
            ) -> anyhow::Result<crate::backend::Handle> {
                anyhow::bail!("stub")
            }
            fn name(&self) -> &'static str {
                "k8s"
            }
            fn satisfies_isolation(&self, class: proto::IsolationClass) -> bool {
                // Simulates K8s with gVisor configured (accepts UNTRUSTED but not HOSTILE).
                !matches!(class, proto::IsolationClass::Hostile)
            }
        }
        let b: Arc<dyn RuntimeBackend> = Arc::new(GvisorStub);
        assert!(matches!(
            choose_backend(proto::IsolationClass::Untrusted, &b),
            BackendChoice::Use(_)
        ));
        // HOSTILE still refused (no Kata).
        assert!(matches!(
            choose_backend(proto::IsolationClass::Hostile, &b),
            BackendChoice::Unavailable(_)
        ));
    }

    // ---------------------------------------------------------------------------
    // VendSecret handler tests
    // ---------------------------------------------------------------------------

    use crate::handle_registry::HandleInfo;
    use crate::secret_resolver::HashMapSecretResolver;
    use std::collections::HashMap;

    /// Build a `RuntimeHarnessGrpc` with one pre-registered VM and a
    /// `HashMapSecretResolver` loaded with the given secrets.
    fn harness_service(
        vm_id: &str,
        tenant_id: &str,
        run_id: &str,
        declared_uris: Vec<&str>,
        resolver_secrets: HashMap<String, String>,
    ) -> RuntimeHarnessGrpc {
        let registry = Arc::new(HandleRegistry::new());
        registry.register(HandleInfo {
            handle_id: vm_id.to_string(),
            run_id: run_id.to_string(),
            tenant_id: tenant_id.to_string(),
            backend: "docker".to_string(),
            isolation_class: proto::IsolationClass::Standard,
            created_at: chrono::Utc::now(),
            resource_limits: proto::ResourceLimits::default(),
            node_name: "node-1".to_string(),
            declared_secret_uris: declared_uris.into_iter().map(String::from).collect(),
        });
        let resolver = Arc::new(HashMapSecretResolver::new(resolver_secrets));
        let cache: HeartbeatCache = Arc::new(DashMap::new());
        let addrs: HarnessAddrs = Arc::new(DashMap::new());
        // mtls_enabled=false: these tests exercise the allowlist / TTL /
        // registry-binding logic over plaintext (no peer cert exists in a
        // synthetic Request). The cert-enforcement path is covered by the
        // dedicated tests below with mtls_enabled=true.
        RuntimeHarnessGrpc::new(registry, resolver, cache, addrs, false)
    }

    #[tokio::test]
    async fn vend_secret_allowlisted_uri_resolves() {
        let uri = "lantern.secret://tenant/t1/key/OPENAI";
        let mut secrets = HashMap::new();
        secrets.insert(uri.to_string(), "sk-real-value".to_string());

        let svc = harness_service("vm-1", "t1", "run-1", vec![uri], secrets);
        let req = Request::new(pb::VendSecretRequest {
            vm_id: "vm-1".to_string(),
            secret_uri: uri.to_string(),
            ttl: None,
        });
        let resp = svc.vend_secret(req).await.unwrap();
        assert_eq!(resp.into_inner().value, "sk-real-value");
    }

    #[tokio::test]
    async fn vend_secret_ttl_capped_at_300s() {
        let uri = "lantern.secret://tenant/t1/key/KEY";
        let mut secrets = HashMap::new();
        secrets.insert(uri.to_string(), "v".to_string());

        let svc = harness_service("vm-ttl", "t1", "run-ttl", vec![uri], secrets);

        // Request a TTL longer than the cap.
        let req = Request::new(pb::VendSecretRequest {
            vm_id: "vm-ttl".to_string(),
            secret_uri: uri.to_string(),
            ttl: Some(prost_types::Duration {
                seconds: 9999,
                nanos: 0,
            }),
        });
        let resp = svc.vend_secret(req).await.unwrap().into_inner();
        let expires = resp.expires_at.unwrap();

        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let actual_ttl = expires.seconds - now_secs;
        assert!(
            actual_ttl <= MAX_SECRET_TTL_SECS,
            "TTL {actual_ttl}s exceeds cap of {MAX_SECRET_TTL_SECS}s"
        );
        assert!(actual_ttl > 0, "TTL must be positive, got {actual_ttl}s");
    }

    #[tokio::test]
    async fn vend_secret_undeclared_uri_rejected() {
        let declared = "lantern.secret://tenant/t1/key/ALLOWED";
        let forbidden = "lantern.secret://tenant/t1/key/FORBIDDEN";
        let mut secrets = HashMap::new();
        secrets.insert(forbidden.to_string(), "should-not-see".to_string());

        let svc = harness_service("vm-2", "t1", "run-2", vec![declared], secrets);
        let req = Request::new(pb::VendSecretRequest {
            vm_id: "vm-2".to_string(),
            secret_uri: forbidden.to_string(),
            ttl: None,
        });
        let err = svc.vend_secret(req).await.unwrap_err();
        assert_eq!(
            err.code(),
            tonic::Code::PermissionDenied,
            "expected PERMISSION_DENIED, got {err:?}"
        );
    }

    #[tokio::test]
    async fn vend_secret_unknown_vm_id_rejected() {
        let svc = harness_service(
            "registered-vm",
            "t1",
            "run-1",
            vec!["lantern.secret://tenant/t1/key/K"],
            HashMap::new(),
        );
        let req = Request::new(pb::VendSecretRequest {
            vm_id: "UNKNOWN-VM".to_string(),
            secret_uri: "lantern.secret://tenant/t1/key/K".to_string(),
            ttl: None,
        });
        let err = svc.vend_secret(req).await.unwrap_err();
        assert_eq!(
            err.code(),
            tonic::Code::NotFound,
            "expected NOT_FOUND, got {err:?}"
        );
    }

    #[tokio::test]
    async fn vend_secret_uses_registry_tenant_not_caller_asserted() {
        // The vm_id is registered under tenant "real-tenant".
        // The request doesn't carry a tenant field — the response value must
        // come from the resolver keyed on the URI, which the registry
        // (populated at spawn by the manager) has already validated belongs
        // to "real-tenant". This test confirms the manager never accepts
        // caller-asserted tenant_id.
        let uri = "lantern.secret://tenant/real-tenant/key/K";
        let mut secrets = HashMap::new();
        secrets.insert(uri.to_string(), "correct-value".to_string());

        let svc = harness_service("vm-tenant", "real-tenant", "run-x", vec![uri], secrets);
        let req = Request::new(pb::VendSecretRequest {
            vm_id: "vm-tenant".to_string(),
            secret_uri: uri.to_string(),
            ttl: None,
        });
        let resp = svc.vend_secret(req).await.unwrap();
        // If authorization was bound to registry (not request), we get the value.
        assert_eq!(resp.into_inner().value, "correct-value");
    }

    #[tokio::test]
    async fn vend_secret_resolver_not_found_returns_internal() {
        // URI is declared in the allowlist but the resolver doesn't have it —
        // simulates a misconfigured secret backend. Should return INTERNAL,
        // not leak that the value is absent.
        let uri = "lantern.secret://tenant/t1/key/MISSING_IN_BACKEND";
        let svc = harness_service(
            "vm-3",
            "t1",
            "run-3",
            vec![uri],
            HashMap::new(), // resolver has no entries
        );
        let req = Request::new(pb::VendSecretRequest {
            vm_id: "vm-3".to_string(),
            secret_uri: uri.to_string(),
            ttl: None,
        });
        let err = svc.vend_secret(req).await.unwrap_err();
        assert_eq!(
            err.code(),
            tonic::Code::Internal,
            "expected INTERNAL for resolver miss, got {err:?}"
        );
    }

    // -----------------------------------------------------------------------
    // VendSecret client-cert enforcement (mtls_enabled = true)
    // -----------------------------------------------------------------------

    /// Same as `harness_service` but with mTLS enforcement turned on.
    fn harness_service_mtls(
        vm_id: &str,
        declared_uris: Vec<&str>,
        resolver_secrets: HashMap<String, String>,
    ) -> RuntimeHarnessGrpc {
        let registry = Arc::new(HandleRegistry::new());
        registry.register(HandleInfo {
            handle_id: vm_id.to_string(),
            run_id: "run-mtls".to_string(),
            tenant_id: "t-mtls".to_string(),
            backend: "firecracker".to_string(),
            isolation_class: proto::IsolationClass::Untrusted,
            created_at: chrono::Utc::now(),
            resource_limits: proto::ResourceLimits::default(),
            node_name: "node-1".to_string(),
            declared_secret_uris: declared_uris.into_iter().map(String::from).collect(),
        });
        let resolver = Arc::new(HashMapSecretResolver::new(resolver_secrets));
        let cache: HeartbeatCache = Arc::new(DashMap::new());
        let addrs: HarnessAddrs = Arc::new(DashMap::new());
        RuntimeHarnessGrpc::new(registry, resolver, cache, addrs, true)
    }

    /// With mTLS enforced, a request carrying NO peer cert (synthetic Request,
    /// no TLS session) is rejected with PERMISSION_DENIED before the allowlist
    /// or resolver is ever consulted. This is the fail-closed property:
    /// topology (reaching the socket) is not sufficient; a CA-signed cert is.
    #[tokio::test]
    async fn vend_secret_mtls_rejects_missing_client_cert() {
        let uri = "lantern.secret://tenant/t-mtls/key/K";
        let mut secrets = HashMap::new();
        secrets.insert(uri.to_string(), "should-not-be-vended".to_string());

        let svc = harness_service_mtls("vm-mtls", vec![uri], secrets);
        let req = Request::new(pb::VendSecretRequest {
            vm_id: "vm-mtls".to_string(),
            secret_uri: uri.to_string(),
            ttl: None,
        });
        let err = svc.vend_secret(req).await.unwrap_err();
        assert_eq!(
            err.code(),
            tonic::Code::PermissionDenied,
            "expected PERMISSION_DENIED when no client cert presented, got {err:?}"
        );
    }

    // -----------------------------------------------------------------------
    // Exec + Stats — backend trait default impls and service validation
    // -----------------------------------------------------------------------

    // Build a RuntimeManagerGrpc with the given backend and one pre-registered
    // VM so we can exercise the exec/stats handler paths without a live daemon.
    fn manager_with_vm(
        backend: Arc<dyn RuntimeBackend>,
        vm_id: &str,
        handle_id: &str,
    ) -> RuntimeManagerGrpc {
        let resolver = Arc::new(HashMapSecretResolver::new(HashMap::new()));
        let svc = RuntimeManagerGrpc::new(backend, crate::pool::PoolConfig::default(), resolver);
        svc.registry.register(HandleInfo {
            handle_id: handle_id.to_string(),
            run_id: "run-exec-test".to_string(),
            tenant_id: "t-exec".to_string(),
            backend: "stub".to_string(),
            isolation_class: proto::IsolationClass::Standard,
            created_at: chrono::Utc::now(),
            resource_limits: proto::ResourceLimits::default(),
            node_name: "node-1".to_string(),
            declared_secret_uris: vec![],
        });
        // Rekey so the wire vm_id resolves to the backend handle_id.
        svc.registry.rekey(handle_id, vm_id);
        svc
    }

    // --- exec_command: default trait impl returns an error for non-Docker backends ---

    #[tokio::test]
    async fn exec_command_default_returns_error_for_stub() {
        let backend = NamedStub::arc("firecracker");
        // Call the default impl directly on the backend object.
        let result = backend.exec_command("any-handle", "ls", &[]).await;
        assert!(
            result.is_err(),
            "default exec_command should fail for non-Docker backend"
        );
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("exec not supported by"),
            "error should mention 'exec not supported by', got: {msg}"
        );
        assert!(
            msg.contains("firecracker"),
            "error should name the backend, got: {msg}"
        );
    }

    #[tokio::test]
    async fn exec_command_default_includes_handle_id_in_error() {
        let backend = NamedStub::arc("k8s");
        let result = backend
            .exec_command("my-container-id", "echo", &["hello".to_string()])
            .await;
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("my-container-id"),
            "error should include handle_id for debuggability, got: {msg}"
        );
    }

    // --- stats_sample: default trait impl returns an error for non-Docker backends ---

    #[tokio::test]
    async fn stats_sample_default_returns_error_for_stub() {
        let backend = NamedStub::arc("firecracker");
        let result = backend.stats_sample("any-handle").await;
        assert!(
            result.is_err(),
            "default stats_sample should fail for non-Docker backend"
        );
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("stats not supported by"),
            "error should mention 'stats not supported by', got: {msg}"
        );
        assert!(
            msg.contains("firecracker"),
            "error should name the backend, got: {msg}"
        );
    }

    // --- stats handler: missing vm_id rejected before touching backend ---

    #[tokio::test]
    async fn stats_handler_rejects_empty_vm_id() {
        use pb::runtime_manager_server::RuntimeManager as _;
        let svc = manager_with_vm(NamedStub::arc("stub"), "vm-1", "handle-1");
        let req = Request::new(pb::StatsRequest {
            vm_id: String::new(),
            interval: None,
        });
        let result = svc.stats(req).await;
        let err = result.err().expect("empty vm_id should yield an error");
        assert_eq!(
            err.code(),
            tonic::Code::InvalidArgument,
            "empty vm_id should yield INVALID_ARGUMENT, got {err:?}"
        );
    }

    // --- stats handler: unknown vm_id yields NOT_FOUND ---

    #[tokio::test]
    async fn stats_handler_unknown_vm_id_yields_not_found() {
        use pb::runtime_manager_server::RuntimeManager as _;
        let svc = manager_with_vm(NamedStub::arc("stub"), "vm-known", "handle-known");
        let req = Request::new(pb::StatsRequest {
            vm_id: "vm-does-not-exist".to_string(),
            interval: None,
        });
        let result = svc.stats(req).await;
        let err = result.err().expect("unknown vm_id should yield an error");
        assert_eq!(
            err.code(),
            tonic::Code::NotFound,
            "unknown vm_id should yield NOT_FOUND, got {err:?}"
        );
    }

    // --- stats handler: stub backend emits UNIMPLEMENTED on the stream ---
    //
    // The stats stream is lazy: the handler returns Ok immediately and starts
    // a background task.  The first item on the stream is what reveals the
    // backend error.  We drive the stream to completion to verify the error code.

    // A non-firecracker stub backend that returns "stats not supported by …"
    // should surface Unimplemented on the stream.
    #[tokio::test]
    async fn stats_handler_stub_backend_yields_unimplemented_on_stream() {
        use futures::StreamExt as _;
        use pb::runtime_manager_server::RuntimeManager as _;

        // Use a name that is NOT "firecracker" so the handler goes through the
        // backend.stats_sample() path (not the heartbeat-cache path).
        let svc = manager_with_vm(NamedStub::arc("stub"), "vm-stub", "handle-stub");
        let req = Request::new(pb::StatsRequest {
            vm_id: "vm-stub".to_string(),
            interval: None,
        });
        let resp = svc
            .stats(req)
            .await
            .expect("stats handler should return Ok");
        let mut stream = resp.into_inner();
        let first = stream
            .next()
            .await
            .expect("stream should yield at least one item");
        let err = first.expect_err("stub backend should yield an error item");
        assert_eq!(
            err.code(),
            tonic::Code::Unimplemented,
            "stub backend should surface UNIMPLEMENTED, got {err:?}"
        );
    }

    // A firecracker VM with no heartbeat in the cache should surface Unavailable
    // on the stats stream (harness not yet connected / no heartbeat received).
    #[tokio::test]
    async fn stats_handler_firecracker_no_heartbeat_yields_unavailable() {
        use futures::StreamExt as _;
        use pb::runtime_manager_server::RuntimeManager as _;

        let svc = manager_with_vm(NamedStub::arc("firecracker"), "vm-fc", "handle-fc");
        let req = Request::new(pb::StatsRequest {
            vm_id: "vm-fc".to_string(),
            interval: None,
        });
        let resp = svc
            .stats(req)
            .await
            .expect("stats handler should return Ok");
        let mut stream = resp.into_inner();
        let first = stream
            .next()
            .await
            .expect("stream should yield at least one item");
        let err = first.expect_err("firecracker with no heartbeat should yield an error item");
        assert_eq!(
            err.code(),
            tonic::Code::Unavailable,
            "firecracker no-heartbeat should surface UNAVAILABLE, got {err:?}"
        );
        assert!(
            err.message().contains("no heartbeat received yet"),
            "error message should mention missing heartbeat, got: {}",
            err.message()
        );
    }

    // -----------------------------------------------------------------------
    // Exec routing — firecracker forwards to the in-guest harness
    // -----------------------------------------------------------------------

    /// Like `manager_with_vm` but records the given backend name in the
    /// registry entry, which is what `route_exec` dispatches on.
    fn manager_with_backend_vm(
        backend_name: &'static str,
        vm_id: &str,
        handle_id: &str,
    ) -> RuntimeManagerGrpc {
        let resolver = Arc::new(HashMapSecretResolver::new(HashMap::new()));
        let svc = RuntimeManagerGrpc::new(
            NamedStub::arc(backend_name),
            crate::pool::PoolConfig::default(),
            resolver,
        );
        svc.registry.register(HandleInfo {
            handle_id: handle_id.to_string(),
            run_id: "run-exec-route".to_string(),
            tenant_id: "t-exec".to_string(),
            backend: backend_name.to_string(),
            isolation_class: proto::IsolationClass::Untrusted,
            created_at: chrono::Utc::now(),
            resource_limits: proto::ResourceLimits::default(),
            node_name: "node-1".to_string(),
            declared_secret_uris: vec![],
        });
        svc.registry.rekey(handle_id, vm_id);
        svc
    }

    /// A firecracker VM whose harness has never heartbeated cannot be exec'd:
    /// the dispatch must fail with FAILED_PRECONDITION, not fall through to
    /// the backend (which has no guest channel).
    #[tokio::test]
    async fn exec_route_firecracker_without_harness_is_failed_precondition() {
        let svc = manager_with_backend_vm("firecracker", "vm-fc", "handle-fc");
        let err = svc
            .route_exec("vm-fc")
            .expect_err("firecracker without harness addr must not route");
        assert_eq!(
            err.code(),
            tonic::Code::FailedPrecondition,
            "expected FAILED_PRECONDITION, got {err:?}"
        );
        assert!(
            err.message().contains("harness not connected"),
            "message should say the harness is not connected, got: {}",
            err.message()
        );
    }

    /// Once the heartbeat handler has recorded the guest peer IP, exec for a
    /// firecracker VM routes to the in-guest harness endpoint at that IP.
    #[tokio::test]
    async fn exec_route_firecracker_with_harness_addr_targets_guest() {
        let svc = manager_with_backend_vm("firecracker", "vm-fc2", "handle-fc2");
        svc.harness_addrs.insert(
            "vm-fc2".to_string(),
            "192.168.127.5"
                .parse::<std::net::IpAddr>()
                .expect("test ip"),
        );

        match svc.route_exec("vm-fc2").expect("route must resolve") {
            ExecRoute::Harness { endpoint } => {
                let expected = format!("http://192.168.127.5:{}", harness_exec_port());
                assert_eq!(endpoint, expected, "endpoint must dial the guest IP");
            }
            other => panic!("expected harness route, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // Multi-tenant namespace isolation (CVE-fix: invariant #7)
    //
    // These tests verify the three properties of the fix:
    //   (A) empty spec.tenant_id is rejected fail-closed, regardless of env.
    //   (B) caller env["LANTERN_TENANT_ID"] cannot shadow spec.tenant_id.
    //   (C) the workload env re-receives the authenticated value, not attacker.
    // -----------------------------------------------------------------------

    fn make_spawn_request(tenant_id: &str, env: HashMap<String, String>) -> pb::SpawnRequest {
        pb::SpawnRequest {
            handle: None,
            spec: Some(pb::AgentSpec {
                image_digest: "sha256:abc".to_string(),
                isolation: 1, // TRUSTED
                limits: None,
                network: 0,
                egress_rules: vec![],
                secrets: vec![],
                labels: HashMap::new(),
                preferred_regions: vec![],
                idempotent: false,
                restore_snapshot_id: String::new(),
                tenant_id: tenant_id.to_string(),
                agent_version_id: String::new(),
                run_id: "run-test".to_string(),
                command: vec![],
                args: vec![],
                env,
            }),
        }
    }

    /// (A) Empty spec.tenant_id is rejected with INVALID_ARGUMENT regardless
    /// of what the caller put in env["LANTERN_TENANT_ID"]. An untenanted
    /// workload must never be scheduled.
    #[test]
    fn spawn_to_schedule_rejects_empty_tenant_id() {
        let mut env = HashMap::new();
        env.insert("LANTERN_TENANT_ID".to_string(), "victim-tenant".to_string());

        let req = make_spawn_request("", env);
        let err = spawn_to_schedule(&req).expect_err("empty tenant_id must be rejected");
        assert_eq!(
            err.code(),
            tonic::Code::InvalidArgument,
            "expected INVALID_ARGUMENT, got {err:?}"
        );
        assert!(
            err.message().contains("tenant_id is required"),
            "message must say tenant_id is required, got: {}",
            err.message()
        );
    }

    /// (B) Caller env["LANTERN_TENANT_ID"] = "attacker" with spec.tenant_id =
    /// "legit" → the resulting ScheduleRequest must carry tenant_id = "legit"
    /// (the authenticated value wins).
    #[test]
    fn spawn_to_schedule_caller_env_cannot_shadow_spec_tenant_id() {
        let mut env = HashMap::new();
        env.insert("LANTERN_TENANT_ID".to_string(), "attacker".to_string());

        let req = make_spawn_request("legit", env);
        let sched = spawn_to_schedule(&req).expect("valid tenant_id should succeed");

        assert_eq!(
            sched.tenant_id, "legit",
            "ScheduleRequest.tenant_id must be the authenticated value, not caller env"
        );
    }

    /// (C) The workload env has LANTERN_TENANT_ID = authenticated value, NOT
    /// the attacker-supplied value (strip-then-reinject semantics).
    #[test]
    fn spawn_to_schedule_workload_env_receives_authenticated_tenant_id() {
        let mut env = HashMap::new();
        env.insert("LANTERN_TENANT_ID".to_string(), "attacker".to_string());
        // Extra env var that must pass through untouched.
        env.insert("MY_VAR".to_string(), "hello".to_string());

        let req = make_spawn_request("legit", env);
        let sched = spawn_to_schedule(&req).expect("valid tenant_id should succeed");

        assert_eq!(
            sched.env.get("LANTERN_TENANT_ID").map(String::as_str),
            Some("legit"),
            "workload env must see the authenticated tenant_id, got: {:?}",
            sched.env.get("LANTERN_TENANT_ID")
        );
        // The attacker's value must not appear anywhere in the env.
        let has_attacker_value = sched.env.values().any(|v| v == "attacker");
        assert!(
            !has_attacker_value,
            "attacker-supplied env value must have been stripped from workload env"
        );
        // Unrelated env vars pass through.
        assert_eq!(
            sched.env.get("MY_VAR").map(String::as_str),
            Some("hello"),
            "unrelated env vars must pass through unchanged"
        );
    }

    /// Non-firecracker backends keep the existing backend exec path, resolved
    /// to the backend-side handle id.
    #[tokio::test]
    async fn exec_route_docker_uses_backend_handle() {
        let svc = manager_with_backend_vm("docker", "vm-docker", "container-abc");
        match svc.route_exec("vm-docker").expect("route must resolve") {
            ExecRoute::Backend { handle_id } => {
                assert_eq!(handle_id, "container-abc");
            }
            other => panic!("expected backend route, got {other:?}"),
        }
    }

    /// Unknown vm_id is NOT_FOUND before any dispatch decision.
    #[tokio::test]
    async fn exec_route_unknown_vm_is_not_found() {
        let svc = manager_with_backend_vm("firecracker", "vm-known", "handle-known");
        let err = svc
            .route_exec("vm-unknown")
            .expect_err("unknown vm must not route");
        assert_eq!(err.code(), tonic::Code::NotFound);
    }

    // -----------------------------------------------------------------------
    // Interactive (tty) exec — wire fields + backend trait default.
    //
    // The live PTY pump (CLI ↔ manager ↔ harness) is guest/tty-runtime-only;
    // here we verify what is testable headless: the proto round-trip and the
    // fail-safe trait default.
    // -----------------------------------------------------------------------

    /// The tty/term fields must survive a prost encode/decode round trip —
    /// guards against a field-number mismatch with the Go stubs (tty=5,
    /// term_rows=6, term_cols=7, term=8).
    #[test]
    fn exec_request_tty_fields_round_trip() {
        use prost::Message as _;

        let req = pb::ExecRequest {
            vm_id: "vm-1".to_string(),
            command: "bash".to_string(),
            argv: vec!["-l".to_string()],
            stdin: vec![0x04],
            tty: true,
            term_rows: 48,
            term_cols: 160,
            term: "xterm-256color".to_string(),
        };

        let bytes = req.encode_to_vec();
        let decoded = pb::ExecRequest::decode(bytes.as_slice()).expect("decode must succeed");
        assert_eq!(decoded, req, "all fields must round-trip");
        assert!(decoded.tty);
        assert_eq!(decoded.term_rows, 48);
        assert_eq!(decoded.term_cols, 160);
        assert_eq!(decoded.term, "xterm-256color");
    }

    /// The default `exec_command_tty` must fail with a message the exec
    /// dispatch maps to UNIMPLEMENTED (it matches on "exec not supported by").
    #[tokio::test]
    async fn exec_command_tty_default_returns_error_for_stub() {
        let backend = NamedStub::arc("k8s");
        let result = backend
            .exec_command_tty("my-handle", "bash", &[], 24, 80, "xterm")
            .await;
        let msg = result
            .expect_err("default exec_command_tty should fail")
            .to_string();
        assert!(
            msg.contains("tty exec not supported by"),
            "error should mention tty exec, got: {msg}"
        );
        assert!(
            msg.contains("exec not supported by"),
            "message must keep the substring the dispatch maps to UNIMPLEMENTED, got: {msg}"
        );
        assert!(
            msg.contains("k8s") && msg.contains("my-handle"),
            "error should name backend + handle_id, got: {msg}"
        );
    }

    // -----------------------------------------------------------------------
    // FIX 1: heartbeat mTLS cert check
    //
    // The live path (cert-bound to a real TLS connection) is integration-tested
    // against a live manager socket. Here we verify the key design invariant:
    // `authorize_vm_cert` is the same function used by `vend_secret`; its
    // accept/reject semantics are already exhaustively tested in `tls.rs`. These
    // tests assert the architectural property — that the heartbeat handler
    // captures the peer cert BEFORE `into_inner()` and that the same
    // `crate::tls::authorize_vm_cert` function drives the heartbeat check.
    // -----------------------------------------------------------------------

    /// When mTLS is NOT enabled, `authorize_vm_cert` is not consulted — so even
    /// a plaintext synthetic `Request` (no peer cert) must NOT be rejected.
    /// This exercises the `mtls_enabled` gate in the heartbeat handler.
    #[test]
    fn heartbeat_mtls_disabled_skips_cert_check() {
        // `extract_peer_cert_der` returns None for a synthetic request (no TLS
        // session). With mtls_enabled=false the gate must be skipped.
        let synthetic: tonic::Request<()> = tonic::Request::new(());
        let peer_cert = crate::tls::extract_peer_cert_der(&synthetic);
        assert!(
            peer_cert.is_none(),
            "no cert on a plaintext synthetic request"
        );

        // When mtls_enabled=false the heartbeat handler would NOT call
        // `authorize_vm_cert`, so the absent cert is acceptable.
        // The inverse: when mtls_enabled=true, a None cert yields Err.
        let result = crate::tls::authorize_vm_cert("vm-any", peer_cert.as_deref());
        assert!(
            result.is_err(),
            "absent cert must be denied when authorize_vm_cert is called (mTLS enabled)"
        );
    }

    /// When mTLS IS enabled and the peer cert matches the vm_id, heartbeat
    /// messages are allowed through. Uses the same `authorize_vm_cert` the
    /// handler calls to verify the logic is shared.
    #[test]
    fn heartbeat_mtls_accept_requires_matching_cert() {
        use rustls_pemfile::certs;
        use std::io::{BufReader, Cursor};

        // Issue a cert for "vm-hb-test".
        let vm_id = "vm-hb-test";
        let ca = rcgen::generate_simple_self_signed(vec!["ca".to_string()]).expect("rcgen CA");
        let ca_cert_pem = ca.cert.pem();
        let ca_key_pem = ca.key_pair.serialize_pem();
        let issued = crate::tls::generate_vm_client_cert(vm_id, &ca_cert_pem, &ca_key_pem).unwrap();
        let der: Vec<u8> = certs(&mut BufReader::new(Cursor::new(issued.cert_pem.as_bytes())))
            .next()
            .unwrap()
            .unwrap()
            .to_vec();

        // Matching vm_id → accepted.
        assert!(
            crate::tls::authorize_vm_cert(vm_id, Some(&der)).is_ok(),
            "heartbeat cert check must accept a cert whose CN matches the vm_id"
        );

        // Different vm_id → rejected (cross-tenant exec-hijack scenario).
        assert!(
            crate::tls::authorize_vm_cert("vm-victim", Some(&der)).is_err(),
            "heartbeat cert check must reject a cert whose CN is a different vm_id"
        );
    }
}
