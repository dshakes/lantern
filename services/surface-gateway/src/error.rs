use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("webhook verification failed: {0}")]
    WebhookVerification(String),

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("adapter not configured: {0}")]
    AdapterNotConfigured(String),

    #[error("upstream service error: {0}")]
    Upstream(String),

    #[error("internal error: {0}")]
    Internal(String),
}

#[derive(Serialize)]
struct ProblemDetail {
    #[serde(rename = "type")]
    error_type: &'static str,
    title: &'static str,
    status: u16,
    detail: String,
}

impl AppError {
    fn status_code(&self) -> StatusCode {
        match self {
            AppError::WebhookVerification(_) => StatusCode::UNAUTHORIZED,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::AdapterNotConfigured(_) => StatusCode::SERVICE_UNAVAILABLE,
            AppError::Upstream(_) => StatusCode::BAD_GATEWAY,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn error_type(&self) -> &'static str {
        match self {
            AppError::WebhookVerification(_) => {
                "https://lantern.run/errors/webhook-verification-failed"
            }
            AppError::BadRequest(_) => "https://lantern.run/errors/bad-request",
            AppError::NotFound(_) => "https://lantern.run/errors/not-found",
            AppError::AdapterNotConfigured(_) => "https://lantern.run/errors/adapter-not-configured",
            AppError::Upstream(_) => "https://lantern.run/errors/upstream",
            AppError::Internal(_) => "https://lantern.run/errors/internal",
        }
    }

    fn title(&self) -> &'static str {
        match self {
            AppError::WebhookVerification(_) => "Webhook Verification Failed",
            AppError::BadRequest(_) => "Bad Request",
            AppError::NotFound(_) => "Not Found",
            AppError::AdapterNotConfigured(_) => "Adapter Not Configured",
            AppError::Upstream(_) => "Bad Gateway",
            AppError::Internal(_) => "Internal Server Error",
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status_code();

        tracing::error!(
            error_type = self.error_type(),
            status = status.as_u16(),
            detail = %self,
            "request error"
        );

        let body = ProblemDetail {
            error_type: self.error_type(),
            title: self.title(),
            status: status.as_u16(),
            detail: self.to_string(),
        };

        (
            status,
            [(
                axum::http::header::CONTENT_TYPE,
                "application/problem+json",
            )],
            serde_json::to_string(&body).unwrap_or_else(|_| {
                r#"{"type":"https://lantern.run/errors/internal","title":"Internal Server Error","status":500,"detail":"failed to serialize error"}"#.to_string()
            }),
        )
            .into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        AppError::Internal(err.to_string())
    }
}

impl From<redis::RedisError> for AppError {
    fn from(err: redis::RedisError) -> Self {
        AppError::Internal(format!("redis: {err}"))
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        AppError::Upstream(format!("http client: {err}"))
    }
}
