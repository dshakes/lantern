mod auth;
mod config;
mod error;
mod grpc;
mod middleware;
mod routes;
mod sse;
mod state;

use tower::ServiceBuilder;
use tower_http::cors::{Any, CorsLayer};
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::auth::AuthLayer;
use crate::config::Config;
use crate::middleware::RateLimitLayer;
use crate::middleware::rate_limit::RateLimitConfig;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(&config.log_level)),
        )
        .json()
        .init();

    tracing::info!(
        listen_addr = %config.listen_addr,
        control_plane_addr = %config.control_plane_addr,
        "starting lantern-gateway"
    );

    let listen_addr = config.listen_addr;
    let jwt_secret = config.jwt_secret.clone();
    let app_state = AppState::new(config).await?;

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let x_request_id = axum::http::HeaderName::from_static("x-request-id");

    let middleware_stack = ServiceBuilder::new()
        .layer(SetRequestIdLayer::new(
            x_request_id.clone(),
            MakeRequestUuid,
        ))
        .layer(PropagateRequestIdLayer::new(x_request_id))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .layer(AuthLayer::new(jwt_secret))
        .layer(RateLimitLayer::new(
            app_state.redis.clone(),
            RateLimitConfig::default(),
        ));

    let app = routes::build_router(app_state).layer(middleware_stack);

    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    tracing::info!(%listen_addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("gateway shut down");
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
