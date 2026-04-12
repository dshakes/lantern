use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
#[allow(dead_code)]
pub enum AppError {
    #[error("authentication failed: {0}")]
    Auth(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("internal error: {0}")]
    Internal(String),

    #[error("upstream service error: {0}")]
    Upstream(String),

    #[error("rate limited")]
    RateLimited { retry_after_secs: u64 },
}

#[derive(Serialize)]
struct ProblemDetail {
    #[serde(rename = "type")]
    error_type: &'static str,
    title: &'static str,
    status: u16,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after: Option<u64>,
}

impl AppError {
    fn status_code(&self) -> StatusCode {
        match self {
            AppError::Auth(_) => StatusCode::UNAUTHORIZED,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::Upstream(_) => StatusCode::BAD_GATEWAY,
            AppError::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
        }
    }

    fn error_type(&self) -> &'static str {
        match self {
            AppError::Auth(_) => "https://lantern.run/errors/unauthorized",
            AppError::NotFound(_) => "https://lantern.run/errors/not-found",
            AppError::BadRequest(_) => "https://lantern.run/errors/bad-request",
            AppError::Internal(_) => "https://lantern.run/errors/internal",
            AppError::Upstream(_) => "https://lantern.run/errors/upstream",
            AppError::RateLimited { .. } => "https://lantern.run/errors/rate-limited",
        }
    }

    fn title(&self) -> &'static str {
        match self {
            AppError::Auth(_) => "Unauthorized",
            AppError::NotFound(_) => "Not Found",
            AppError::BadRequest(_) => "Bad Request",
            AppError::Internal(_) => "Internal Server Error",
            AppError::Upstream(_) => "Bad Gateway",
            AppError::RateLimited { .. } => "Too Many Requests",
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status_code();

        let retry_after = match &self {
            AppError::RateLimited { retry_after_secs } => Some(*retry_after_secs),
            _ => None,
        };

        let body = ProblemDetail {
            error_type: self.error_type(),
            title: self.title(),
            status: status.as_u16(),
            detail: self.to_string(),
            retry_after,
        };

        let mut response = (
            status,
            [(
                axum::http::header::CONTENT_TYPE,
                "application/problem+json",
            )],
            serde_json::to_string(&body).unwrap_or_else(|_| {
                r#"{"type":"https://lantern.run/errors/internal","title":"Internal Server Error","status":500,"detail":"failed to serialize error"}"#.to_string()
            }),
        )
            .into_response();

        if let Some(secs) = retry_after {
            response.headers_mut().insert(
                "Retry-After",
                axum::http::HeaderValue::from_str(&secs.to_string())
                    .unwrap_or_else(|_| axum::http::HeaderValue::from_static("1")),
            );
        }

        response
    }
}

pub fn grpc_status_to_app_error(status: tonic::Status) -> AppError {
    match status.code() {
        tonic::Code::NotFound => AppError::NotFound(status.message().to_string()),
        tonic::Code::InvalidArgument => AppError::BadRequest(status.message().to_string()),
        tonic::Code::Unauthenticated => AppError::Auth(status.message().to_string()),
        tonic::Code::PermissionDenied => AppError::Auth(status.message().to_string()),
        tonic::Code::ResourceExhausted => AppError::RateLimited {
            retry_after_secs: 1,
        },
        _ => AppError::Upstream(format!("{}: {}", status.code(), status.message())),
    }
}
