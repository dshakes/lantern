use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

pub fn routes() -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
}

#[tracing::instrument]
async fn healthz() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"status": "ok"})))
}

#[tracing::instrument]
async fn readyz() -> impl IntoResponse {
    // In a full implementation this would check the gRPC channel health
    // and Redis connectivity. For now, return ok if the process is running.
    (StatusCode::OK, Json(json!({"status": "ready"})))
}
