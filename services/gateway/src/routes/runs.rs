use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};

use crate::auth::Claims;
use crate::error::AppError;
use crate::grpc;
use crate::sse::grpc_stream_to_sse;
use crate::state::AppState;

pub fn routes(state: AppState) -> Router {
    Router::new()
        .route("/v1/runs", post(create_run).get(list_runs))
        .route("/v1/runs/{id}", get(get_run))
        .route("/v1/runs/{id}/cancel", post(cancel_run))
        .route("/v1/runs/{id}/events", get(stream_events))
        .route("/v1/runs/{id}/signals/{name}", post(signal_run))
        .with_state(state)
}

#[derive(Deserialize)]
struct CreateRunBody {
    agent_name: String,
    #[serde(default)]
    input: serde_json::Value,
    #[serde(default)]
    trigger_kind: Option<String>,
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    labels: HashMap<String, String>,
    #[serde(default)]
    idempotency_key: String,
}

#[derive(Serialize)]
struct RunResponse {
    id: String,
    tenant_id: String,
    agent_id: String,
    agent_version_id: String,
    status: String,
    trigger_kind: String,
    error: Option<RunErrorResponse>,
    cost_usd: f64,
    tokens_in: i64,
    tokens_out: i64,
    started_at: Option<String>,
    finished_at: Option<String>,
    created_at: Option<String>,
    parent_run_id: String,
    labels: HashMap<String, String>,
}

#[derive(Serialize)]
struct RunErrorResponse {
    code: String,
    message: String,
    step_id: String,
}

#[derive(Serialize)]
struct ListRunsBody {
    runs: Vec<RunResponse>,
    next_page_token: String,
    total_count: i32,
}

#[derive(Debug, Deserialize)]
struct ListRunsParams {
    #[serde(default)]
    agent_name: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default = "default_page_size")]
    page_size: i32,
    #[serde(default)]
    page_token: String,
}

fn default_page_size() -> i32 {
    20
}

fn format_timestamp(ts: &grpc::Timestamp) -> String {
    let secs = ts.seconds;
    let nanos = ts.nanos;
    format!("{secs}.{nanos:09}")
}

fn run_status_to_string(status: i32) -> String {
    match status {
        0 => "unspecified",
        1 => "queued",
        2 => "running",
        3 => "paused",
        4 => "succeeded",
        5 => "failed",
        6 => "cancelled",
        _ => "unknown",
    }
    .to_string()
}

fn trigger_kind_to_string(kind: i32) -> String {
    match kind {
        0 => "unspecified",
        1 => "api",
        2 => "schedule",
        3 => "webhook",
        4 => "surface",
        5 => "a2a",
        6 => "connector",
        7 => "manual",
        _ => "unknown",
    }
    .to_string()
}

fn parse_trigger_kind(s: &str) -> i32 {
    match s.to_lowercase().as_str() {
        "api" => 1,
        "schedule" => 2,
        "webhook" => 3,
        "surface" => 4,
        "a2a" => 5,
        "connector" => 6,
        "manual" => 7,
        _ => 0,
    }
}

fn parse_run_status(s: &str) -> i32 {
    match s.to_lowercase().as_str() {
        "queued" => 1,
        "running" => 2,
        "paused" => 3,
        "succeeded" => 4,
        "failed" => 5,
        "cancelled" => 6,
        _ => 0,
    }
}

impl From<grpc::Run> for RunResponse {
    fn from(r: grpc::Run) -> Self {
        Self {
            id: r.id,
            tenant_id: r.tenant_id,
            agent_id: r.agent_id,
            agent_version_id: r.agent_version_id,
            status: run_status_to_string(r.status),
            trigger_kind: trigger_kind_to_string(r.trigger_kind),
            error: r.error.map(|e| RunErrorResponse {
                code: e.code,
                message: e.message,
                step_id: e.step_id,
            }),
            cost_usd: r.cost_usd,
            tokens_in: r.tokens_in,
            tokens_out: r.tokens_out,
            started_at: r.started_at.as_ref().map(format_timestamp),
            finished_at: r.finished_at.as_ref().map(format_timestamp),
            created_at: r.created_at.as_ref().map(format_timestamp),
            parent_run_id: r.parent_run_id,
            labels: r.labels,
        }
    }
}

#[tracing::instrument(skip(state, claims, body))]
async fn create_run(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateRunBody>,
) -> Result<axum::response::Response, AppError> {
    if body.agent_name.is_empty() {
        return Err(AppError::BadRequest(
            "agent_name is required".to_string(),
        ));
    }

    let trigger_kind = body
        .trigger_kind
        .as_deref()
        .map(parse_trigger_kind)
        .unwrap_or(1); // default to API trigger

    let input_bytes = serde_json::to_vec(&body.input)
        .map_err(|e| AppError::BadRequest(format!("invalid input: {e}")))?;

    let should_stream = body.stream;

    let req = grpc::CreateRunRequest {
        agent_name: body.agent_name,
        input: input_bytes,
        trigger_kind,
        stream: should_stream,
        labels: body.labels,
        idempotency_key: body.idempotency_key,
    };

    if should_stream {
        let run = state.control_plane.create_run(&claims, req).await?;

        let stream_req = grpc::StreamRunEventsRequest {
            run_id: run.id.clone(),
            from_seq: 0,
            live: true,
        };

        let stream = state
            .control_plane
            .stream_run_events(&claims, stream_req)
            .await?;

        Ok(grpc_stream_to_sse(stream, 0).into_response())
    } else {
        let run = state.control_plane.create_run(&claims, req).await?;
        let resp = RunResponse::from(run);
        Ok((StatusCode::CREATED, Json(resp)).into_response())
    }
}

#[tracing::instrument(skip(state, claims))]
async fn get_run(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let req = grpc::GetRunRequest { id };
    let run = state.control_plane.get_run(&claims, req).await?;
    Ok(Json(RunResponse::from(run)))
}

#[tracing::instrument(skip(state, claims))]
async fn list_runs(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<ListRunsParams>,
) -> Result<impl IntoResponse, AppError> {
    let status_filter = params
        .status
        .as_deref()
        .map(parse_run_status)
        .unwrap_or(0);

    let req = grpc::ListRunsRequest {
        agent_name: params.agent_name,
        status_filter,
        page_size: params.page_size,
        page_token: params.page_token,
    };

    let resp = state.control_plane.list_runs(&claims, req).await?;

    let body = ListRunsBody {
        runs: resp.runs.into_iter().map(RunResponse::from).collect(),
        next_page_token: resp.next_page_token,
        total_count: resp.total_count,
    };

    Ok(Json(body))
}

#[derive(Deserialize)]
struct CancelRunBody {
    #[serde(default)]
    reason: String,
}

#[tracing::instrument(skip(state, claims, body))]
async fn cancel_run(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<String>,
    Json(body): Json<CancelRunBody>,
) -> Result<impl IntoResponse, AppError> {
    let req = grpc::CancelRunRequest {
        id,
        reason: body.reason,
    };
    let run = state.control_plane.cancel_run(&claims, req).await?;
    Ok(Json(RunResponse::from(run)))
}

#[tracing::instrument(skip(state, claims, headers))]
async fn stream_events(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let from_seq = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .map(|seq| seq + 1)
        .unwrap_or(0);

    let req = grpc::StreamRunEventsRequest {
        run_id: id,
        from_seq,
        live: true,
    };

    let stream = state
        .control_plane
        .stream_run_events(&claims, req)
        .await?;

    Ok(grpc_stream_to_sse(stream, from_seq).into_response())
}

#[derive(Deserialize)]
struct SignalRunBody {
    #[serde(default)]
    value: serde_json::Value,
}

#[tracing::instrument(skip(state, claims, body))]
async fn signal_run(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((id, name)): Path<(String, String)>,
    Json(body): Json<SignalRunBody>,
) -> Result<impl IntoResponse, AppError> {
    let value_bytes = serde_json::to_vec(&body.value)
        .map_err(|e| AppError::BadRequest(format!("invalid signal value: {e}")))?;

    let req = grpc::SignalRunRequest {
        run_id: id,
        signal_name: name,
        value: value_bytes,
    };

    state.control_plane.signal_run(&claims, req).await?;
    Ok(StatusCode::NO_CONTENT)
}
