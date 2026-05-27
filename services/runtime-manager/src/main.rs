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
mod service;

use std::sync::Arc;

use tonic::transport::Server;
use tracing_subscriber::EnvFilter;

use crate::backend::RuntimeBackend;
use crate::backends::{DockerBackend, FirecrackerBackend, K8sBackend};
use crate::config::{Config, RuntimeBackend as RuntimeBackendKind};
use crate::pool::PoolConfig;
use crate::proto::pb::runtime_manager_server::RuntimeManagerServer;
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
        RuntimeBackendKind::K8s => Arc::new(K8sBackend::new(config.agent_image.clone()).await?),
        RuntimeBackendKind::Firecracker => {
            Arc::new(FirecrackerBackend::new("/tmp/firecracker.sock".to_string()))
        }
    };

    tracing::info!(backend = backend.name(), "runtime backend initialized");

    // Create the gRPC service with warm pool. `RuntimeManagerGrpc` is Clone
    // (its fields are all `Arc`-wrapped), which lets the generated tonic
    // server hold it by value while still sharing the underlying state.
    let pool_config = PoolConfig::default();
    let grpc_service = RuntimeManagerGrpc::new(backend, pool_config);

    let listen_addr = config.listen_addr;
    let svc = RuntimeManagerServer::new(grpc_service);

    tracing::info!(%listen_addr, "gRPC server starting");

    Server::builder()
        .add_service(svc)
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
