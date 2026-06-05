mod auth;
mod config;
mod error;
mod grpc;
mod middleware;
mod routes;
mod sse;
mod state;

use tower::ServiceBuilder;
use tower_http::cors::CorsLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::auth::AuthLayer;
use crate::config::Config;
use crate::middleware::rate_limit::RateLimitConfig;
use crate::middleware::RateLimitLayer;
use crate::state::AppState;

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
        control_plane_addr = %config.control_plane_addr,
        "starting lantern-gateway"
    );

    let listen_addr = config.listen_addr;
    let jwt_secret = config.jwt_secret.clone();

    // M2: restrict CORS to configured dashboard origins rather than Any.
    let cors = build_cors(&config.allowed_origins);

    let app_state = AppState::new(config).await?;

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

/// Build a CORS layer restricted to the given list of origins.
/// Falls back to localhost:3001 if the list is empty.
fn build_cors(origins: &[String]) -> CorsLayer {
    use axum::http::HeaderValue;
    use tower_http::cors::AllowOrigin;

    let values: Vec<HeaderValue> = origins
        .iter()
        .filter_map(|o| o.parse::<HeaderValue>().ok())
        .collect();

    if values.is_empty() {
        // Misconfigured — default to local dev only; never fall back to Any.
        tracing::warn!(
            "ALLOWED_ORIGINS produced no valid origins; defaulting to http://localhost:3001"
        );
        let fallback = "http://localhost:3001"
            .parse::<HeaderValue>()
            .expect("localhost origin is a valid header value");
        CorsLayer::new()
            .allow_origin(AllowOrigin::list([fallback]))
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any)
    } else {
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(values))
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any)
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        // L4: log errors instead of panicking on signal-handler install.
        match tokio::signal::ctrl_c().await {
            Ok(()) => tracing::info!("received Ctrl+C"),
            Err(e) => tracing::error!(error = %e, "Ctrl+C handler error"),
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
                tracing::info!("received SIGTERM");
            }
            Err(e) => {
                tracing::error!(error = %e, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
