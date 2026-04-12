use std::collections::HashMap;
use std::sync::Arc;

use crate::adapter::SurfaceAdapter;
use crate::error::AppError;
use crate::session::SessionStore;
use crate::types::{EventKind, SurfaceEvent, SurfaceId, SurfaceMessage};

/// The dispatcher receives normalized `SurfaceEvent`s, resolves sessions,
/// and either signals an active run or creates a new run in the workflow engine.
/// It also handles routing agent responses back through the correct adapter.
#[allow(dead_code)]
pub struct Dispatcher {
    adapters: HashMap<SurfaceId, Arc<dyn SurfaceAdapter>>,
    sessions: SessionStore,
    control_plane_addr: String,
    http: reqwest::Client,
}

impl Dispatcher {
    pub fn new(
        adapters: HashMap<SurfaceId, Arc<dyn SurfaceAdapter>>,
        sessions: SessionStore,
        control_plane_addr: String,
    ) -> Self {
        Self {
            adapters,
            sessions,
            control_plane_addr,
            http: reqwest::Client::new(),
        }
    }

    /// Dispatch a surface event to the workflow engine.
    ///
    /// - If the session has an active run, signals that run (e.g. for ctx.ask() responses).
    /// - If the event is an approval response, resolves the approval.
    /// - Otherwise, creates a new run with the message as input.
    pub async fn dispatch(&self, event: SurfaceEvent) -> Result<(), AppError> {
        let span = tracing::info_span!(
            "dispatch",
            event_id = %event.id,
            surface = %event.surface,
            tenant_id = %event.tenant_id,
            user_id = %event.user_id,
            session_id = %event.session_id,
        );
        let _enter = span.enter();

        // Handle approval responses separately — they resolve a pending approval
        // regardless of whether there's an active run on this session.
        if let EventKind::ApprovalResponse {
            ref request_id,
            approved,
        } = event.kind
        {
            return self
                .resolve_approval(&event.tenant_id, request_id, approved, &event.user_id)
                .await;
        }

        // Look up the session to check for an active run.
        let session = self
            .sessions
            .get_or_create(event.surface, &event.user_id, &event.tenant_id)
            .await?;

        if let Some(ref run_id) = session.active_run_id {
            tracing::info!(run_id = %run_id, "signalling active run");
            return self.signal_run(&event.tenant_id, run_id, &event).await;
        }

        // No active run — create one.
        let input = match &event.kind {
            EventKind::Message { text, .. } => text.clone(),
            EventKind::Command { name, args } => format!("/{name} {args}"),
            EventKind::Reaction { emoji, message_id } => {
                format!("reacted {emoji} to {message_id}")
            }
            EventKind::ApprovalResponse { .. } => unreachable!(),
        };

        let run_id = self
            .create_run(&event.tenant_id, &session.session_id, &input, &event)
            .await?;

        self.sessions
            .set_active_run(event.surface, &event.user_id, &run_id)
            .await?;

        tracing::info!(run_id = %run_id, "created new run");
        Ok(())
    }

    /// Send an agent response back through the correct surface adapter.
    #[allow(dead_code)]
    pub async fn send_response(
        &self,
        session_id: &str,
        msg: &SurfaceMessage,
    ) -> Result<String, AppError> {
        let session = self
            .sessions
            .get_by_session_id(session_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("session not found: {session_id}")))?;

        let adapter = self
            .adapters
            .get(&session.surface)
            .ok_or_else(|| {
                AppError::AdapterNotConfigured(format!(
                    "no adapter for surface {}",
                    session.surface
                ))
            })?;

        let channel = format!("{}:{}", session.surface, session.external_user_id);
        adapter.send_message(&channel, msg).await
    }

    /// Signal an active run with a user message (e.g. for ctx.ask() responses).
    async fn signal_run(
        &self,
        tenant_id: &str,
        run_id: &str,
        event: &SurfaceEvent,
    ) -> Result<(), AppError> {
        let payload = serde_json::to_value(event)
            .map_err(|e| AppError::Internal(format!("serialize event: {e}")))?;

        let url = format!(
            "{}/api/v1/tenants/{}/runs/{}/signal",
            self.control_plane_addr, tenant_id, run_id
        );

        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "signal": "surface_message",
                "payload": payload,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Upstream(format!(
                "signal run failed ({status}): {body}"
            )));
        }

        Ok(())
    }

    /// Resolve a pending approval in the workflow engine.
    async fn resolve_approval(
        &self,
        tenant_id: &str,
        request_id: &str,
        approved: bool,
        approver: &str,
    ) -> Result<(), AppError> {
        let url = format!(
            "{}/api/v1/tenants/{}/approvals/{}/resolve",
            self.control_plane_addr, tenant_id, request_id
        );

        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "approved": approved,
                "resolved_by": approver,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Upstream(format!(
                "resolve approval failed ({status}): {body}"
            )));
        }

        tracing::info!(
            request_id = %request_id,
            approved = approved,
            approver = %approver,
            "resolved approval"
        );

        Ok(())
    }

    /// Create a new workflow run via the control plane API.
    async fn create_run(
        &self,
        tenant_id: &str,
        session_id: &str,
        input: &str,
        event: &SurfaceEvent,
    ) -> Result<String, AppError> {
        let url = format!(
            "{}/api/v1/tenants/{}/runs",
            self.control_plane_addr, tenant_id
        );

        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "input": input,
                "session_id": session_id,
                "surface": event.surface,
                "metadata": {
                    "surface_event_id": event.id,
                    "surface_user_id": event.user_id,
                },
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Upstream(format!(
                "create run failed ({status}): {body}"
            )));
        }

        #[derive(serde::Deserialize)]
        struct CreateRunResponse {
            run_id: String,
        }

        let body: CreateRunResponse = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("invalid create run response: {e}")))?;

        Ok(body.run_id)
    }
}
