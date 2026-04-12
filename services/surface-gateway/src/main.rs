mod adapter;
mod adapters;
mod config;
mod dispatcher;
mod error;
mod routes;
mod session;
mod types;

use std::collections::HashMap;
use std::sync::Arc;

use tower::ServiceBuilder;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::adapter::SurfaceAdapter;
use crate::config::Config;
use crate::dispatcher::Dispatcher;
use crate::routes::RouteState;
use crate::session::SessionStore;
use crate::types::SurfaceId;

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
        "starting lantern-surface-gateway"
    );

    let listen_addr = config.listen_addr;

    // Connect to Redis for session management.
    let redis = redis::Client::open(config.redis_url.as_str())?;
    let sessions = SessionStore::new(redis);

    // Build adapter registry — only register adapters whose credentials are present.
    let mut adapters: HashMap<SurfaceId, Arc<dyn SurfaceAdapter>> = HashMap::new();

    if let (Some(signing_secret), Some(bot_token)) =
        (&config.slack_signing_secret, &config.slack_bot_token)
    {
        let adapter = adapters::slack::SlackAdapter::new(
            signing_secret.clone(),
            bot_token.clone(),
        );
        adapters.insert(SurfaceId::Slack, Arc::new(adapter));
        tracing::info!("registered Slack adapter");
    }

    if let (Some(verify_token), Some(api_token), Some(phone_number_id)) = (
        &config.whatsapp_verify_token,
        &config.whatsapp_api_token,
        &config.whatsapp_phone_number_id,
    ) {
        let adapter = adapters::whatsapp::WhatsAppAdapter::new(
            verify_token.clone(),
            api_token.clone(),
            phone_number_id.clone(),
        );
        adapters.insert(SurfaceId::WhatsApp, Arc::new(adapter));
        tracing::info!("registered WhatsApp adapter");
    }

    if let Some(bot_token) = &config.telegram_bot_token {
        let adapter = adapters::telegram::TelegramAdapter::new(bot_token.clone());
        adapters.insert(SurfaceId::Telegram, Arc::new(adapter));
        tracing::info!("registered Telegram adapter");
    }

    if let (Some(account_sid), Some(auth_token), Some(phone_number)) = (
        &config.twilio_account_sid,
        &config.twilio_auth_token,
        &config.twilio_phone_number,
    ) {
        let adapter = adapters::twilio::TwilioAdapter::new(
            account_sid.clone(),
            auth_token.clone(),
            phone_number.clone(),
        );
        adapters.insert(SurfaceId::Twilio, Arc::new(adapter));
        tracing::info!("registered Twilio adapter");
    }

    if let (Some(bot_token), Some(public_key)) =
        (&config.discord_bot_token, &config.discord_public_key)
    {
        let adapter = adapters::discord::DiscordAdapter::new(
            bot_token.clone(),
            public_key.clone(),
        );
        adapters.insert(SurfaceId::Discord, Arc::new(adapter));
        tracing::info!("registered Discord adapter");
    }

    if adapters.is_empty() {
        tracing::warn!(
            "no surface adapters configured — set platform credentials via environment variables"
        );
    } else {
        tracing::info!(
            count = adapters.len(),
            surfaces = ?adapters.keys().collect::<Vec<_>>(),
            "surface adapters ready"
        );
    }

    let dispatcher = Arc::new(Dispatcher::new(
        adapters.clone(),
        sessions,
        config.control_plane_addr.clone(),
    ));

    let route_state = RouteState {
        adapters,
        dispatcher,
        whatsapp_verify_token: config.whatsapp_verify_token.clone(),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let middleware_stack = ServiceBuilder::new()
        .layer(TraceLayer::new_for_http())
        .layer(cors);

    let app = routes::build_router(route_state).layer(middleware_stack);

    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    tracing::info!(%listen_addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("surface-gateway shut down");
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
