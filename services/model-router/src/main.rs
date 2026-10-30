mod auth;
mod cache;
mod config;
mod error;
#[cfg(test)]
mod mtls;
mod otel;
mod proto;
mod provider;
mod providers;
mod router;
mod service;

use std::sync::Arc;

use tracing::info;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

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

    // Initialise OTel pipeline (no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset).
    // Keep the guard alive for the duration of main so spans are flushed on exit.
    let _otel_shutdown = otel::init();

    // Build the tracing subscriber.  The tracing-opentelemetry layer bridges
    // every tracing span into the OTLP exporter when OTel is active.  The JSON
    // fmt layer is always present for structured log output.
    let otel_layer = tracing_opentelemetry::layer();
    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&config.log_level));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_target(true)
                .with_thread_ids(true),
        )
        .with(otel_layer)
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

    // Service-token gate (invariant #7). Prod-like env without a token: refuse to start.
    let token = pal_env::var("PAL_GRPC_SERVICE_TOKEN").ok();
    let env = pal_env::var("PAL_ENV").unwrap_or_default();
    if let Err(msg) = auth::check_startup(&env, token.as_deref()) {
        anyhow::bail!(msg);
    }
    if token.as_deref().is_none_or(str::is_empty) {
        tracing::warn!(
            "LANTERN_GRPC_SERVICE_TOKEN is unset: model-router accepts unauthenticated callers (dev only)"
        );
    }

    // Service-mesh mTLS (ADR 0043). This port carries tenant provider keys, so
    // prod refuses plaintext unless PAL_GRPC_INSECURE=1. Both mTLS AND the
    // service token are required; neither replaces the other.
    let is_prod = pal_grpc_tls::is_prod();
    let tls = pal_grpc_tls::server_tls(
        &pal_grpc_tls::Files::from_env(),
        is_prod,
        pal_grpc_tls::insecure_override(),
    )?;

    info!(listen_addr = %config.listen_addr, mtls = tls.is_some(), "gRPC server starting");

    let mut builder = tonic::transport::Server::builder();
    let peers = match tls {
        Some(tls) => {
            builder = builder.tls_config(tls)?;
            let peers = pal_grpc_tls::allowed_peers();
            info!(allowed_peers = ?peers, "model-router gRPC: mTLS enabled (client certificates required)");
            Some(peers)
        }
        None if is_prod => {
            tracing::warn!(
                "SECURITY: PAL_GRPC_INSECURE=1 — model-router gRPC (:50053, tenant provider keys) \
                 serves PLAINTEXT in production; remove it once PAL_GRPC_TLS_CA/_CERT/_KEY are mounted"
            );
            None
        }
        None => {
            tracing::warn!(
                "model-router gRPC: TLS unset — serving plaintext (acceptable in dev; production \
                 requires PAL_GRPC_TLS_CA/_CERT/_KEY)"
            );
            None
        }
    };
    // The identity gate is a no-op when TLS is off (dev / explicit override).
    #[allow(clippy::result_large_err)] // tonic::Status is the mandated interceptor error
    let peer_gate = move |req: tonic::Request<()>| match &peers {
        Some(p) => pal_grpc_tls::peer_interceptor(p.clone())(req),
        None => Ok(req),
    };

    builder
        .layer(tonic::service::interceptor(peer_gate))
        .layer(tonic::service::interceptor(auth::interceptor(token)))
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
