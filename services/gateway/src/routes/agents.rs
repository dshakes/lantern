use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};

use crate::auth::Claims;
use crate::error::AppError;
use crate::grpc;
use crate::state::AppState;

pub fn routes(state: AppState) -> Router {
    Router::new()
        .route("/v1/agents", post(create_agent).get(list_agents))
        .route("/v1/agents/{name}", get(get_agent).delete(delete_agent))
        .with_state(state)
}

#[derive(Deserialize)]
struct CreateAgentBody {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    labels: HashMap<String, String>,
}

#[derive(Serialize)]
struct AgentResponse {
    id: String,
    tenant_id: String,
    name: String,
    description: String,
    current_version_id: String,
    created_by: String,
    created_at: Option<String>,
    archived_at: Option<String>,
    labels: HashMap<String, String>,
}

impl From<grpc::Agent> for AgentResponse {
    fn from(a: grpc::Agent) -> Self {
        Self {
            id: a.id,
            tenant_id: a.tenant_id,
            name: a.name,
            description: a.description,
            current_version_id: a.current_version_id,
            created_by: a.created_by,
            created_at: a.created_at.map(|t| format_timestamp(&t)),
            archived_at: a.archived_at.map(|t| format_timestamp(&t)),
            labels: a.labels,
        }
    }
}

#[derive(Serialize)]
struct ListAgentsBody {
    agents: Vec<AgentResponse>,
    next_page_token: String,
    total_count: i32,
}

#[derive(Debug, Deserialize)]
struct ListAgentsParams {
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

#[tracing::instrument(skip(state, claims, body))]
async fn create_agent(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateAgentBody>,
) -> Result<impl IntoResponse, AppError> {
    if body.name.is_empty() {
        return Err(AppError::BadRequest("agent name is required".to_string()));
    }

    let req = grpc::CreateAgentRequest {
        name: body.name,
        description: body.description,
        labels: body.labels,
    };

    let agent = state.control_plane.create_agent(&claims, req).await?;
    let resp = AgentResponse::from(agent);

    Ok((StatusCode::CREATED, Json(resp)))
}

#[tracing::instrument(skip(state, claims))]
async fn get_agent(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let req = grpc::GetAgentRequest { name };
    let agent = state.control_plane.get_agent(&claims, req).await?;
    Ok(Json(AgentResponse::from(agent)))
}

#[tracing::instrument(skip(state, claims))]
async fn list_agents(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<ListAgentsParams>,
) -> Result<impl IntoResponse, AppError> {
    let req = grpc::ListAgentsRequest {
        page_size: params.page_size,
        page_token: params.page_token,
        label_filter: HashMap::new(),
    };

    let resp = state.control_plane.list_agents(&claims, req).await?;

    let body = ListAgentsBody {
        agents: resp.agents.into_iter().map(AgentResponse::from).collect(),
        next_page_token: resp.next_page_token,
        total_count: resp.total_count,
    };

    Ok(Json(body))
}

#[tracing::instrument(skip(state, claims))]
async fn delete_agent(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let req = grpc::DeleteAgentRequest { name };
    state.control_plane.delete_agent(&claims, req).await?;
    Ok(StatusCode::NO_CONTENT)
}
