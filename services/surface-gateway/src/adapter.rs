use async_trait::async_trait;
use axum::http::HeaderMap;

use crate::error::AppError;
use crate::types::{SurfaceEvent, SurfaceId, SurfaceMessage};

/// A surface adapter knows how to receive from and send to a specific external
/// messaging platform. Each adapter handles webhook verification, event parsing,
/// and outbound message delivery for its platform.
#[allow(dead_code)]
#[async_trait]
pub trait SurfaceAdapter: Send + Sync {
    /// The unique identifier for this surface.
    fn id(&self) -> SurfaceId;

    /// A human-readable name for the adapter (e.g. "Slack", "WhatsApp").
    fn name(&self) -> &str;

    /// Verify the webhook signature or challenge from the platform.
    /// Returns `true` if the request is authentic.
    async fn verify_webhook(&self, headers: &HeaderMap, body: &[u8]) -> Result<bool, AppError>;

    /// Parse the raw webhook payload into zero or more normalized surface events.
    /// Returns an empty vec for events we want to acknowledge but not process
    /// (e.g. delivery receipts, typing indicators).
    async fn parse_event(
        &self,
        headers: &HeaderMap,
        body: &[u8],
    ) -> Result<Vec<SurfaceEvent>, AppError>;

    /// Send a message to the given session. Returns the platform's message ID.
    async fn send_message(
        &self,
        session: &str,
        msg: &SurfaceMessage,
    ) -> Result<String, AppError>;

    /// Send an approval card (approve/deny buttons) for a pending human-in-the-loop decision.
    /// Returns the platform's message ID.
    async fn send_approval_card(
        &self,
        session: &str,
        request_id: &str,
        reason: &str,
        approvers: &[String],
    ) -> Result<String, AppError>;

    /// Update an existing message (e.g. to mark approval as resolved).
    async fn update_message(
        &self,
        session: &str,
        message_id: &str,
        msg: &SurfaceMessage,
    ) -> Result<(), AppError>;
}
