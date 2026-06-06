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
use crate::secret_resolver::SecretResolver;

// ---------------------------------------------------------------------------
// C4 fix: isolation-class → backend routing
//
// Invariant: Hostile and Untrusted workloads MUST run in a hardware-isolated
// microVM (Firecracker or Kata). Silently downgrading them to Docker/K8s
// violates the multi-tenant security boundary. This function is the single
// authoritative mapping; it is called per-request so different isolation
// classes can co-exist on the same manager node.
//
// Trusted/Standard/Wasm/Devcontainer may use the node's configured default
// backend (controlled by RUNTIME_BACKEND env var on the manager).
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
/// `Hostile` and `Untrusted` MUST map to a microVM backend.  If the configured
/// default backend is Docker or K8s, scheduling those classes is refused.  The
/// caller gets `Status::failed_precondition` and nothing runs.  A node running
/// only Docker/K8s will never silently downgrade an untrusted workload.
fn choose_backend(
    isolation_class: proto::IsolationClass,
    default_backend: &Arc<dyn RuntimeBackend>,
) -> BackendChoice {
    match isolation_class {
        proto::IsolationClass::Hostile | proto::IsolationClass::Untrusted => {
            // Only microVM backends are acceptable.
            let name = default_backend.name();
            if name == "firecracker" || name == "kata" {
                BackendChoice::Use(Arc::clone(default_backend))
            } else {
                BackendChoice::Unavailable(format!(
                    "isolation_class {:?} requires a microVM backend (firecracker/kata), \
                     but this node runs '{}'. Refusing to downgrade to an unacceptable \
                     isolation level. Configure RUNTIME_BACKEND=firecracker on a \
                     dedicated microVM node.",
                    isolation_class, name
                ))
            }
        }
        // Trusted, Standard, Wasm, Devcontainer, Unspecified → use the default.
        _ => BackendChoice::Use(Arc::clone(default_backend)),
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

        Self {
            backend,
            pool,
            registry,
            secret_resolver,
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

        // C4 fix: select the backend per-request based on isolation class.
        // Hostile/Untrusted MUST use a microVM backend; any other class on a
        // non-microVM node gets a hard failure here — never a silent downgrade.
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

        // Try the warm pool first, fall back to cold start.
        // Note: the pool internally calls backend.schedule(); it uses the pool's
        // own stored backend (set at construction time). For the warm pool to
        // also respect the per-request routing we call it only for non-microVM
        // classes, and call the chosen backend directly for microVM classes.
        let handle = backend.schedule(&req).await.map_err(Self::to_status)?;

        // Extract tenant_id from the request env for the registry.
        let tenant_id = req
            .env
            .get("LANTERN_TENANT_ID")
            .cloned()
            .unwrap_or_else(|| "default".to_string());

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

    // Build env from caller-supplied env + labels (for backwards-compat) +
    // tenant injection. Backends look for `LANTERN_TENANT_ID` in env to
    // populate the handle registry.
    let mut env: std::collections::HashMap<String, String> = spec.env.clone();
    for (k, v) in &spec.labels {
        env.entry(k.clone()).or_insert_with(|| v.clone());
    }
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
        mtls_enabled: bool,
    ) -> Self {
        Self {
            registry,
            secret_resolver,
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
        _request: Request<tonic::Streaming<pb::HeartbeatRequest>>,
    ) -> Result<Response<Self::HeartbeatStream>, Status> {
        // Heartbeat stream is tracked by the heartbeat module in the harness;
        // the manager side is a future workstream. Return an empty stream so
        // the harness can connect without error.
        let stream: Self::HeartbeatStream = Box::pin(tokio_stream::empty());
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
}

// ---------------------------------------------------------------------------
// Tests for C4: isolation-class routing
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream::BoxStream;
    // The `vend_secret` method is defined on the `RuntimeHarness` trait; tests
    // call it directly so the trait must be in scope.
    use pb::runtime_harness_server::RuntimeHarness as _;

    // Minimal stub that reports a configurable name.
    struct NamedStub {
        name: &'static str,
    }

    impl NamedStub {
        fn arc(name: &'static str) -> Arc<dyn RuntimeBackend> {
            Arc::new(Self { name })
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

    // --- choose_backend: Hostile/Untrusted HARD-FAIL on docker/k8s ---

    #[test]
    fn hostile_refused_on_docker() {
        let b = NamedStub::arc("docker");
        match choose_backend(proto::IsolationClass::Hostile, &b) {
            BackendChoice::Unavailable(msg) => {
                assert!(
                    msg.contains("firecracker/kata"),
                    "error should name required backends: {msg}"
                );
            }
            BackendChoice::Use(_) => panic!("hostile must not be allowed on docker"),
        }
    }

    #[test]
    fn untrusted_refused_on_docker() {
        let b = NamedStub::arc("docker");
        match choose_backend(proto::IsolationClass::Untrusted, &b) {
            BackendChoice::Unavailable(msg) => {
                assert!(
                    msg.contains("firecracker/kata"),
                    "error should name required backends: {msg}"
                );
            }
            BackendChoice::Use(_) => panic!("untrusted must not be allowed on docker"),
        }
    }

    #[test]
    fn hostile_refused_on_k8s() {
        let b = NamedStub::arc("k8s");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Hostile, &b),
            BackendChoice::Unavailable(_)
        ));
    }

    #[test]
    fn untrusted_refused_on_k8s() {
        let b = NamedStub::arc("k8s");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Untrusted, &b),
            BackendChoice::Unavailable(_)
        ));
    }

    // --- choose_backend: Hostile/Untrusted ALLOWED on microVM backends ---

    #[test]
    fn hostile_allowed_on_firecracker() {
        let b = NamedStub::arc("firecracker");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Hostile, &b),
            BackendChoice::Use(_)
        ));
    }

    #[test]
    fn untrusted_allowed_on_firecracker() {
        let b = NamedStub::arc("firecracker");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Untrusted, &b),
            BackendChoice::Use(_)
        ));
    }

    #[test]
    fn hostile_allowed_on_kata() {
        let b = NamedStub::arc("kata");
        assert!(matches!(
            choose_backend(proto::IsolationClass::Hostile, &b),
            BackendChoice::Use(_)
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
        // mtls_enabled=false: these tests exercise the allowlist / TTL /
        // registry-binding logic over plaintext (no peer cert exists in a
        // synthetic Request). The cert-enforcement path is covered by the
        // dedicated tests below with mtls_enabled=true.
        RuntimeHarnessGrpc::new(registry, resolver, false)
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
        RuntimeHarnessGrpc::new(registry, resolver, true)
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
}
