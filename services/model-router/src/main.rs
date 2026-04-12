mod cache;
mod config;
mod error;
mod proto;
mod provider;
mod providers;
mod router;
mod service;

use std::sync::Arc;

use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::cache::PromptCache;
use crate::config::Config;
use crate::proto::ModelServiceServer;
use crate::provider::Provider;
use crate::providers::{AnthropicProvider, OpenAiProvider};
use crate::router::ModelRouter;
use crate::service::ModelServiceImpl;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;

    // Initialize tracing with JSON output for structured logging.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(&config.log_level)),
        )
        .json()
        .with_target(true)
        .with_thread_ids(true)
        .init();

    info!(
        listen_addr = %config.listen_addr,
        "starting lantern model router"
    );

    // Build the provider registry based on available API keys.
    let mut provider_list: Vec<Arc<dyn Provider>> = Vec::new();

    if let Some(ref key) = config.openai_api_key {
        info!("openai provider enabled");
        provider_list.push(Arc::new(OpenAiProvider::new(key.clone())));
    }

    if let Some(ref key) = config.anthropic_api_key {
        info!("anthropic provider enabled");
        provider_list.push(Arc::new(AnthropicProvider::new(key.clone())));
    }

    if provider_list.is_empty() {
        anyhow::bail!(
            "no LLM providers configured — set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY"
        );
    }

    let router = Arc::new(ModelRouter::new(provider_list));

    // Initialize prompt cache (best-effort — if Redis is unavailable, run without cache).
    let cache = match PromptCache::new(&config.redis_url, 86400) {
        Ok(c) => {
            info!(redis_url = %config.redis_url, "prompt cache enabled");
            Some(Arc::new(c))
        }
        Err(e) => {
            tracing::warn!(error = %e, "failed to initialize prompt cache, running without cache");
            None
        }
    };

    let svc = ModelServiceImpl::new(router, cache);

    info!(listen_addr = %config.listen_addr, "gRPC server starting");

    tonic::transport::Server::builder()
        .add_service(ModelServiceServer::new(svc))
        .serve_with_shutdown(config.listen_addr, shutdown_signal())
        .await?;

    info!("model router shut down gracefully");
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
        () = ctrl_c => info!("received Ctrl+C, shutting down"),
        () = terminate => info!("received SIGTERM, shutting down"),
    }
}
