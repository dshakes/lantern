// Some service methods (snapshot, restore, stream) are wired but not yet
// exposed via the generated tonic trait — they're the next slice of work
// once the proto adds those RPCs. Same for unused helper fields on backends
// + warm-pool. Keep them buildable rather than gut them prematurely.
#![allow(dead_code)]

mod backend;
mod backends;
mod config;
mod handle_registry;
mod pool;
mod proto;
mod scheduler_heartbeat;
mod secret_resolver;
mod service;
mod snapshot_store;
mod tls;

use std::sync::Arc;

use tonic::transport::Server;
use tracing_subscriber::EnvFilter;

use crate::backend::RuntimeBackend;
use crate::backends::k8s::RuntimeClassConfig;
use crate::backends::{DockerBackend, FirecrackerBackend, K8sBackend, KataBackend, WasmBackend};
use crate::config::{Config, RuntimeBackend as RuntimeBackendKind};
use crate::pool::PoolConfig;
use crate::proto::pb::runtime_harness_server::RuntimeHarnessServer;
use crate::proto::pb::runtime_manager_server::RuntimeManagerServer;
use crate::secret_resolver::SecretResolver;
use crate::service::RuntimeManagerGrpc;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&config.log_level)),
        )
        .json()
        .init();

    tracing::info!(
        listen_addr = %config.listen_addr,
        backend = ?config.runtime_backend,
        agent_image = %config.agent_image,
        "starting lantern-runtime-manager"
    );

    // Create the appropriate backend.
    let backend: Arc<dyn RuntimeBackend> = match &config.runtime_backend {
        RuntimeBackendKind::Docker => Arc::new(DockerBackend::new(
            &config.docker_socket,
            config.agent_image.clone(),
        )?),
        RuntimeBackendKind::K8s => Arc::new(
            K8sBackend::new_with_runtime_classes(
                config.agent_image.clone(),
                RuntimeClassConfig {
                    gvisor: config.runtimeclass_gvisor.clone(),
                    kata: config.runtimeclass_kata.clone(),
                    wasm: config.runtimeclass_wasm.clone(),
                    allow_runc_standard: config.allow_runc_standard,
                },
            )
            .await?,
        ),
        RuntimeBackendKind::Firecracker => Arc::new(FirecrackerBackend::new()),
        RuntimeBackendKind::Kata => Arc::new(KataBackend::from_env(
            &config.docker_socket,
            config.agent_image.clone(),
        )?),
        RuntimeBackendKind::Wasm => Arc::new(WasmBackend::new()?),
    };

    tracing::info!(backend = backend.name(), "runtime backend initialized");

    // Secret resolver — build() selects the relay (ADR 0008) when both
    // LANTERN_CONTROL_PLANE_URL and LANTERN_RUNTIME_SECRET_TOKEN are set;
    // otherwise falls back to EnvSecretResolver (dev/CI default).
    let resolver: Arc<dyn SecretResolver> = crate::secret_resolver::build();

    // Create the gRPC service with warm pool. `RuntimeManagerGrpc` is Clone
    // (its fields are all `Arc`-wrapped), which lets the generated tonic
    // server hold it by value while still sharing the underlying state.
    let pool_config = PoolConfig::default();
    let grpc_service = RuntimeManagerGrpc::new(backend, pool_config, Arc::clone(&resolver));

    // rustls 0.23 requires a process-level CryptoProvider. We pin the `ring`
    // provider (Cargo.toml: rustls default-features off + features=["ring"]),
    // and with only `ring` enabled rustls does NOT auto-install a default — so
    // the tonic TLS server panics on the first handshake unless we install it
    // here. (This path only runs on the Linux mTLS data path, so it is invisible
    // to macOS unit tests; the live microVM integration test is what catches a
    // regression. `.ok()` because a second install is a harmless no-op.)
    let _ = rustls::crypto::ring::default_provider().install_default();

    // mTLS: FAIL-CLOSED in prod when env vars absent, WARN+plaintext in dev.
    // Computed before constructing the harness service so VendSecret knows
    // whether to enforce the client-cert ↔ vm_id identity check.
    let mtls_config = tls::build_server_tls_config()?;
    let mtls_enabled = mtls_config.is_some();

    // The RuntimeHarness server shares the handle registry AND the heartbeat
    // cache with the manager service so VendSecret sees every VM registered by
    // Spawn and Stats for Firecracker VMs reads from the heartbeat cache.
    let harness_service = grpc_service.harness_service(mtls_enabled);

    let listen_addr = config.listen_addr;
    let manager_svc = RuntimeManagerServer::new(grpc_service);
    let harness_svc = RuntimeHarnessServer::new(harness_service);

    // Self-register with the scheduler on a background task. No-op when
    // SCHEDULER_URL is unset (standalone dev).
    scheduler_heartbeat::spawn(scheduler_heartbeat::HeartbeatConfig {
        scheduler_url: config.scheduler_url.clone(),
        token: config.scheduler_token.clone(),
        node_name: config.node_name.clone(),
        advertise_addr: config.node_advertise_addr.clone(),
        region: config.node_region.clone(),
        zone: config.node_zone.clone(),
    });

    tracing::info!(%listen_addr, mtls = mtls_enabled, "gRPC server starting");

    let mut builder = Server::builder();
    if let Some(tls_config) = mtls_config {
        builder = builder.tls_config(tls_config)?;
    }

    builder
        .add_service(manager_svc)
        .add_service(harness_svc)
        .serve_with_shutdown(listen_addr, shutdown_signal())
        .await?;

    tracing::info!("runtime-manager shut down");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => { tracing::info!("received Ctrl+C"); }
        () = terminate => { tracing::info!("received SIGTERM"); }
    }
}
