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
use tower_http::cors::CorsLayer;
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
    // Typed Twilio handle for URL-aware signature verification in routes.
    let mut twilio_adapter_typed: Option<Arc<adapters::twilio::TwilioAdapter>> = None;

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
        // M1: pass app_secret (distinct from verify_token) for POST signature verification.
        let adapter = adapters::whatsapp::WhatsAppAdapter::new(
            verify_token.clone(),
            config.whatsapp_app_secret.clone(),
            api_token.clone(),
            phone_number_id.clone(),
        );
        adapters.insert(SurfaceId::WhatsApp, Arc::new(adapter));
        tracing::info!(
            app_secret_configured = config.whatsapp_app_secret.is_some(),
            "registered WhatsApp adapter"
        );
    }

    if let Some(bot_token) = &config.telegram_bot_token {
        // C3: pass secret_token for X-Telegram-Bot-Api-Secret-Token verification.
        let adapter = adapters::telegram::TelegramAdapter::new(
            bot_token.clone(),
            config.telegram_secret_token.clone(),
        );
        adapters.insert(SurfaceId::Telegram, Arc::new(adapter));
        tracing::info!(
            secret_token_configured = config.telegram_secret_token.is_some(),
            "registered Telegram adapter"
        );
    }

    if let (Some(account_sid), Some(auth_token), Some(phone_number)) = (
        &config.twilio_account_sid,
        &config.twilio_auth_token,
        &config.twilio_phone_number,
    ) {
        // H5: pass webhook_base_url so routes can do URL-aware HMAC-SHA1 verification.
        let adapter = Arc::new(adapters::twilio::TwilioAdapter::new(
            account_sid.clone(),
            auth_token.clone(),
            phone_number.clone(),
            config.twilio_webhook_base_url.clone(),
        ));
        adapters.insert(SurfaceId::Twilio, adapter.clone());
        twilio_adapter_typed = Some(adapter);
        tracing::info!(
            base_url_configured = config.twilio_webhook_base_url.is_some(),
            "registered Twilio adapter"
        );
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
        twilio_adapter: twilio_adapter_typed,
    };

    // M2: restrict CORS to configured origins rather than Any.
    let cors = build_cors(&config.allowed_origins);

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

/// Build a CORS layer restricted to the given list of origins.
fn build_cors(origins: &[String]) -> CorsLayer {
    use axum::http::HeaderValue;
    use tower_http::cors::AllowOrigin;

    let values: Vec<HeaderValue> = origins
        .iter()
        .filter_map(|o| o.parse::<HeaderValue>().ok())
        .collect();

    if values.is_empty() {
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
        // L4: log instead of panicking on signal-handler install failure.
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
