use std::collections::HashMap;
use std::sync::Arc;

use crate::adapter::SurfaceAdapter;
use crate::control_plane::ControlPlaneClient;
use crate::error::AppError;
use crate::session::SessionStore;
use crate::tenant_resolver::TenantResolver;
use crate::types::{EventKind, SurfaceEvent, SurfaceId, SurfaceMessage};

/// The dispatcher receives normalized `SurfaceEvent`s, resolves sessions,
/// and either signals an active run or creates a new run in the workflow engine.
/// It also handles routing agent responses back through the correct adapter.
#[allow(dead_code)]
pub struct Dispatcher {
    adapters: HashMap<SurfaceId, Arc<dyn SurfaceAdapter>>,
    sessions: SessionStore,
    /// gRPC client for the control-plane RunService.  Points to :50051
    /// (gRPC port) with x-lantern-service-token auth (invariant #7).
    control_plane: ControlPlaneClient,
    /// Name of the Lantern agent that handles inbound surface messages.
    /// Set LANTERN_AGENT_NAME; run creation returns an error when unset.
    agent_name: Option<String>,
    /// Resolves each inbound event's platform-native id (chat_id, team_id,
    /// phone_number_id, …) to the real Lantern tenant UUID.  Without this
    /// step runs would be dispatched under the platform's own identifiers,
    /// breaking multi-tenant isolation.
    tenant_resolver: TenantResolver,
}

impl Dispatcher {
    pub fn new(
        adapters: HashMap<SurfaceId, Arc<dyn SurfaceAdapter>>,
        sessions: SessionStore,
        control_plane: ControlPlaneClient,
        agent_name: Option<String>,
        tenant_resolver: TenantResolver,
    ) -> Self {
        Self {
            adapters,
            sessions,
            control_plane,
            agent_name,
            tenant_resolver,
        }
    }

    /// Dispatch a surface event to the workflow engine.
    ///
    /// - If the session has an active run, signals that run (e.g. for ctx.ask() responses).
    /// - If the event is an approval response, resolves the approval.
    /// - Otherwise, creates a new run with the message as input.
    pub async fn dispatch(&self, mut event: SurfaceEvent) -> Result<(), AppError> {
        // P1.2 — Tenant resolution.
        //
        // Adapters set `event.tenant_id` to the platform-native identifier present in
        // the webhook payload (Telegram chat_id, Slack team_id, WhatsApp
        // phone_number_id, Twilio destination number, Discord guild_id).  Those are
        // NOT Lantern tenant UUIDs.  Before forwarding to the control-plane we must
        // replace the platform id with the real Lantern tenant UUID, or reject the
        // event if the gateway is mis-configured (LANTERN_TENANT_ID not set).
        //
        // The raw platform id is preserved in the trace span for debugging but must
        // never reach the control-plane as a tenant discriminator.
        let platform_id = std::mem::take(&mut event.tenant_id);
        event.tenant_id = self.tenant_resolver.resolve(&platform_id, event.surface)?;

        let span = tracing::info_span!(
            "dispatch",
            event_id = %event.id,
            surface = %event.surface,
            tenant_id = %event.tenant_id,
            platform_id = %platform_id,
            user_id = %event.user_id,
            session_id = %event.session_id,
        );
        let _enter = span.enter();

        // Look up the session first — needed for both the active-run check and
        // the approval-response path (which needs the active_run_id).
        let session = self
            .sessions
            .get_or_create(event.surface, &event.user_id, &event.tenant_id)
            .await?;

        // Handle approval responses — signal the active run with the outcome.
        if let EventKind::ApprovalResponse {
            ref request_id,
            approved,
        } = event.kind
        {
            return self
                .resolve_approval(
                    &event.tenant_id,
                    &session,
                    request_id,
                    approved,
                    &event.user_id,
                )
                .await;
        }

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
            .create_run(&event.tenant_id, &session.session_id, &input)
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

        let adapter = self.adapters.get(&session.surface).ok_or_else(|| {
            AppError::AdapterNotConfigured(format!("no adapter for surface {}", session.surface))
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
        let text = match &event.kind {
            EventKind::Message { text, .. } => text.as_str(),
            _ => "",
        };
        self.control_plane
            .signal_run(
                tenant_id,
                run_id,
                "surface_message",
                &[("text", text), ("event_id", event.id.as_str())],
            )
            .await
    }

    /// Resolve a pending approval by signalling the active run.
    ///
    /// The session's `active_run_id` is the run waiting for the approval.
    /// `RunService.SignalRun` is currently `Unimplemented` on the server —
    /// the call is still authenticated and correctly formed; it will start
    /// succeeding once the server-side handler is wired.
    async fn resolve_approval(
        &self,
        tenant_id: &str,
        session: &crate::session::Session,
        request_id: &str,
        approved: bool,
        approver: &str,
    ) -> Result<(), AppError> {
        let run_id = session.active_run_id.as_deref().ok_or_else(|| {
            AppError::NotFound(format!(
                "approval response for request {request_id} but no active run in session"
            ))
        })?;

        let approved_str = if approved { "true" } else { "false" };
        self.control_plane
            .signal_run(
                tenant_id,
                run_id,
                "approval_response",
                &[
                    ("request_id", request_id),
                    ("approved", approved_str),
                    ("approver", approver),
                ],
            )
            .await
    }

    /// Create a new workflow run via the control-plane gRPC RunService.
    async fn create_run(
        &self,
        tenant_id: &str,
        session_id: &str,
        input: &str,
    ) -> Result<String, AppError> {
        let agent_name = self.agent_name.as_deref().ok_or_else(|| {
            AppError::Internal(
                "LANTERN_AGENT_NAME is not set — cannot create run without an agent name"
                    .to_string(),
            )
        })?;

        self.control_plane
            .create_run(tenant_id, agent_name, session_id, input)
            .await
    }
}
