use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;

use crate::adapter::SurfaceAdapter;
use crate::dispatcher::Dispatcher;
use crate::error::AppError;
use crate::types::SurfaceId;

/// Shared state for all webhook routes.
#[derive(Clone)]
pub struct RouteState {
    pub adapters: HashMap<SurfaceId, Arc<dyn SurfaceAdapter>>,
    pub dispatcher: Arc<Dispatcher>,
    /// WhatsApp verify token for GET challenge (stored separately since it's
    /// needed before the adapter processes the body).
    pub whatsapp_verify_token: Option<String>,
}

pub fn build_router(state: RouteState) -> Router {
    Router::new()
        .route("/webhooks/slack", post(slack_webhook))
        .route("/webhooks/whatsapp", get(whatsapp_verify).post(whatsapp_webhook))
        .route("/webhooks/telegram", post(telegram_webhook))
        .route("/webhooks/twilio/sms", post(twilio_sms_webhook))
        .route("/webhooks/twilio/voice", post(twilio_voice_webhook))
        .route(
            "/webhooks/twilio/transcription",
            post(twilio_transcription_webhook),
        )
        .route("/webhooks/discord", post(discord_webhook))
        .route("/healthz", get(healthz))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async fn healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

async fn slack_webhook(
    State(state): State<RouteState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let adapter = state
        .adapters
        .get(&SurfaceId::Slack)
        .ok_or_else(|| AppError::AdapterNotConfigured("slack".to_string()))?;

    // Check if this is a Slack interactive payload (form-encoded).
    let body_bytes = if let Some(content_type) = headers.get("content-type") {
        if content_type
            .to_str()
            .unwrap_or("")
            .contains("application/x-www-form-urlencoded")
        {
            // Interactive payloads come as "payload=<JSON>"
            let form_str = std::str::from_utf8(&body)
                .map_err(|_| AppError::BadRequest("invalid UTF-8".to_string()))?;

            // Verify the raw form body first.
            if !adapter.verify_webhook(&headers, &body).await? {
                return Err(AppError::WebhookVerification(
                    "slack signature mismatch".to_string(),
                ));
            }

            let params: HashMap<String, String> =
                url::form_urlencoded::parse(form_str.as_bytes())
                    .map(
                        |(k, v): (std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>)| {
                            (k.to_string(), v.to_string())
                        },
                    )
                    .collect();

            if let Some(payload_json) = params.get("payload") {
                Bytes::from(payload_json.clone().into_bytes())
            } else {
                body
            }
            .to_vec()
        } else {
            // Verify JSON body.
            if !adapter.verify_webhook(&headers, &body).await? {
                return Err(AppError::WebhookVerification(
                    "slack signature mismatch".to_string(),
                ));
            }
            body.to_vec()
        }
    } else {
        if !adapter.verify_webhook(&headers, &body).await? {
            return Err(AppError::WebhookVerification(
                "slack signature mismatch".to_string(),
            ));
        }
        body.to_vec()
    };

    // Handle URL verification challenge.
    if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&body_bytes)
        && payload["type"].as_str() == Some("url_verification") {
            let challenge = payload["challenge"].as_str().unwrap_or("");
            return Ok((
                StatusCode::OK,
                [("content-type", "application/json")],
                serde_json::json!({ "challenge": challenge }).to_string(),
            )
                .into_response());
        }

    let events = adapter.parse_event(&headers, &body_bytes).await?;

    for event in events {
        let dispatcher = state.dispatcher.clone();
        tokio::spawn(async move {
            if let Err(e) = dispatcher.dispatch(event).await {
                tracing::error!(error = %e, "failed to dispatch slack event");
            }
        });
    }

    Ok((StatusCode::OK, "").into_response())
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct WhatsAppVerifyQuery {
    #[serde(rename = "hub.mode")]
    mode: Option<String>,
    #[serde(rename = "hub.verify_token")]
    verify_token: Option<String>,
    #[serde(rename = "hub.challenge")]
    challenge: Option<String>,
}

async fn whatsapp_verify(
    State(state): State<RouteState>,
    Query(query): Query<WhatsAppVerifyQuery>,
) -> Result<Response, AppError> {
    let verify_token = state
        .whatsapp_verify_token
        .as_deref()
        .ok_or_else(|| AppError::AdapterNotConfigured("whatsapp".to_string()))?;

    let mode = query.mode.as_deref().unwrap_or("");
    let token = query.verify_token.as_deref().unwrap_or("");
    let challenge = query.challenge.as_deref().unwrap_or("");

    let response =
        crate::adapters::whatsapp::verify_challenge(verify_token, mode, token, challenge)?;

    Ok((StatusCode::OK, response).into_response())
}

async fn whatsapp_webhook(
    State(state): State<RouteState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let adapter = state
        .adapters
        .get(&SurfaceId::WhatsApp)
        .ok_or_else(|| AppError::AdapterNotConfigured("whatsapp".to_string()))?;

    if !adapter.verify_webhook(&headers, &body).await? {
        return Err(AppError::WebhookVerification(
            "whatsapp signature mismatch".to_string(),
        ));
    }

    let events = adapter.parse_event(&headers, &body).await?;

    for event in events {
        let dispatcher = state.dispatcher.clone();
        tokio::spawn(async move {
            if let Err(e) = dispatcher.dispatch(event).await {
                tracing::error!(error = %e, "failed to dispatch whatsapp event");
            }
        });
    }

    Ok((StatusCode::OK, "").into_response())
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async fn telegram_webhook(
    State(state): State<RouteState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let adapter = state
        .adapters
        .get(&SurfaceId::Telegram)
        .ok_or_else(|| AppError::AdapterNotConfigured("telegram".to_string()))?;

    if !adapter.verify_webhook(&headers, &body).await? {
        return Err(AppError::WebhookVerification(
            "telegram verification failed".to_string(),
        ));
    }

    let events = adapter.parse_event(&headers, &body).await?;

    for event in events {
        let dispatcher = state.dispatcher.clone();
        tokio::spawn(async move {
            if let Err(e) = dispatcher.dispatch(event).await {
                tracing::error!(error = %e, "failed to dispatch telegram event");
            }
        });
    }

    Ok((StatusCode::OK, "").into_response())
}

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------

async fn twilio_sms_webhook(
    State(state): State<RouteState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let adapter = state
        .adapters
        .get(&SurfaceId::Twilio)
        .ok_or_else(|| AppError::AdapterNotConfigured("twilio".to_string()))?;

    if !adapter.verify_webhook(&headers, &body).await? {
        return Err(AppError::WebhookVerification(
            "twilio signature mismatch".to_string(),
        ));
    }

    let events = adapter.parse_event(&headers, &body).await?;

    for event in events {
        let dispatcher = state.dispatcher.clone();
        tokio::spawn(async move {
            if let Err(e) = dispatcher.dispatch(event).await {
                tracing::error!(error = %e, "failed to dispatch twilio sms event");
            }
        });
    }

    // Twilio expects a TwiML response even for SMS (empty is fine).
    Ok((
        StatusCode::OK,
        [("content-type", "application/xml")],
        "<Response></Response>",
    )
        .into_response())
}

async fn twilio_voice_webhook(
    State(state): State<RouteState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let adapter = state
        .adapters
        .get(&SurfaceId::Twilio)
        .ok_or_else(|| AppError::AdapterNotConfigured("twilio".to_string()))?;

    if !adapter.verify_webhook(&headers, &body).await? {
        return Err(AppError::WebhookVerification(
            "twilio signature mismatch".to_string(),
        ));
    }

    let events = adapter.parse_event(&headers, &body).await?;

    for event in events {
        let dispatcher = state.dispatcher.clone();
        tokio::spawn(async move {
            if let Err(e) = dispatcher.dispatch(event).await {
                tracing::error!(error = %e, "failed to dispatch twilio voice event");
            }
        });
    }

    // Return TwiML greeting for inbound calls.
    let twiml = crate::adapters::twilio::voice_twiml_greeting();
    Ok((
        StatusCode::OK,
        [("content-type", "application/xml")],
        twiml,
    )
        .into_response())
}

async fn twilio_transcription_webhook(
    State(state): State<RouteState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let adapter = state
        .adapters
        .get(&SurfaceId::Twilio)
        .ok_or_else(|| AppError::AdapterNotConfigured("twilio".to_string()))?;

    if !adapter.verify_webhook(&headers, &body).await? {
        return Err(AppError::WebhookVerification(
            "twilio signature mismatch".to_string(),
        ));
    }

    let events = adapter.parse_event(&headers, &body).await?;

    for event in events {
        let dispatcher = state.dispatcher.clone();
        tokio::spawn(async move {
            if let Err(e) = dispatcher.dispatch(event).await {
                tracing::error!(error = %e, "failed to dispatch twilio transcription event");
            }
        });
    }

    Ok((
        StatusCode::OK,
        [("content-type", "application/xml")],
        "<Response></Response>",
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

async fn discord_webhook(
    State(state): State<RouteState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let adapter = state
        .adapters
        .get(&SurfaceId::Discord)
        .ok_or_else(|| AppError::AdapterNotConfigured("discord".to_string()))?;

    if !adapter.verify_webhook(&headers, &body).await? {
        return Err(AppError::WebhookVerification(
            "discord signature mismatch".to_string(),
        ));
    }

    // Handle Discord PING interaction (type 1) — must respond with type 1 PONG.
    if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&body)
        && payload["type"].as_u64() == Some(1) {
            return Ok((
                StatusCode::OK,
                [("content-type", "application/json")],
                serde_json::json!({ "type": 1 }).to_string(),
            )
                .into_response());
        }

    let events = adapter.parse_event(&headers, &body).await?;

    // For Discord interactions (types 2, 3, 5), we must respond within 3 seconds.
    // Acknowledge immediately with a deferred response, then dispatch async.
    let has_interaction = !events.is_empty();

    for event in events {
        let dispatcher = state.dispatcher.clone();
        tokio::spawn(async move {
            if let Err(e) = dispatcher.dispatch(event).await {
                tracing::error!(error = %e, "failed to dispatch discord event");
            }
        });
    }

    if has_interaction {
        // Type 5: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
        Ok((
            StatusCode::OK,
            [("content-type", "application/json")],
            serde_json::json!({ "type": 5 }).to_string(),
        )
            .into_response())
    } else {
        Ok((StatusCode::OK, "").into_response())
    }
}
