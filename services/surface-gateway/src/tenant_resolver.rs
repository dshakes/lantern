//! Tenant resolution for inbound surface webhooks.
//!
//! ## Problem
//!
//! Platform adapters populate `SurfaceEvent::tenant_id` with whatever identifier the
//! *platform* provides — e.g. Telegram's numeric `chat_id`, Slack's `team_id`, or
//! WhatsApp's `phone_number_id`.  Those are opaque platform strings, not Lantern
//! tenant UUIDs.  Passing them downstream to the control-plane as `tenant_id` breaks
//! multi-tenant isolation: runs would be dispatched under phantom tenants that do not
//! exist in the database.
//!
//! ## Solution
//!
//! Each surface-gateway deployment serves exactly one Lantern tenant.  The real tenant
//! UUID is supplied at deploy time via `LANTERN_TENANT_ID`.  `TenantResolver` holds
//! that configured value and rewrites every event's `tenant_id` to the correct UUID
//! before the event is forwarded to the control plane.
//!
//! If `LANTERN_TENANT_ID` is not set the resolver returns an error so the webhook is
//! rejected with an appropriate 4xx/5xx rather than inventing a fake tenant.

use crate::error::AppError;
use crate::types::SurfaceId;

/// Resolves the Lantern tenant UUID for an inbound surface event.
///
/// In the current deployment model every surface-gateway instance is
/// configured for a single tenant — the UUID comes from `LANTERN_TENANT_ID`.
#[derive(Clone, Debug)]
pub struct TenantResolver {
    /// The Lantern tenant UUID this gateway is configured to serve.
    ///
    /// `None` means the gateway was started without `LANTERN_TENANT_ID`, which is
    /// only acceptable in unit-test or local-dev scenarios where tenant routing is
    /// irrelevant.
    tenant_id: Option<String>,
}

impl TenantResolver {
    /// Create a resolver from the configured tenant UUID.
    ///
    /// `tenant_id` should come from `Config::lantern_tenant_id`.
    pub fn new(tenant_id: Option<String>) -> Self {
        Self { tenant_id }
    }

    /// Return the Lantern tenant UUID to use for an event from the given surface.
    ///
    /// `platform_id` is the raw platform-native identifier extracted by the adapter
    /// (chat_id, team_id, phone_number_id, …).  It is accepted only for logging
    /// purposes — it is **not** used to select the tenant.
    ///
    /// Returns `Err(AppError::AdapterNotConfigured)` when `LANTERN_TENANT_ID` has
    /// not been set, causing the webhook to be rejected rather than mis-tenanted.
    pub fn resolve(&self, platform_id: &str, surface: SurfaceId) -> Result<String, AppError> {
        match &self.tenant_id {
            Some(id) => {
                tracing::debug!(
                    surface = %surface,
                    platform_id = %platform_id,
                    tenant_id = %id,
                    "resolved platform id to lantern tenant"
                );
                Ok(id.clone())
            }
            None => {
                tracing::error!(
                    surface = %surface,
                    platform_id = %platform_id,
                    "LANTERN_TENANT_ID not configured — rejecting inbound webhook to prevent \
                     mis-tenanted dispatch"
                );
                Err(AppError::AdapterNotConfigured(
                    "LANTERN_TENANT_ID is required but not set; \
                     cannot resolve platform id to a Lantern tenant"
                        .to_string(),
                ))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Success: configured tenant UUID is returned regardless of the platform id.
    #[test]
    fn configured_tenant_returned_for_any_platform_id() {
        let resolver =
            TenantResolver::new(Some("00000000-0000-0000-0000-000000000001".to_string()));

        let result = resolver.resolve("12345678", SurfaceId::Telegram);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "00000000-0000-0000-0000-000000000001");
    }

    // Same tenant returned for a different platform id — proves the platform id
    // is not used for routing.
    #[test]
    fn same_tenant_for_different_platform_ids() {
        let resolver =
            TenantResolver::new(Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_string()));

        let r1 = resolver.resolve("T1234567", SurfaceId::Slack).unwrap();
        let r2 = resolver.resolve("T9999999", SurfaceId::Slack).unwrap();
        assert_eq!(
            r1, r2,
            "all platform ids must map to the same configured tenant"
        );
    }

    // Same tenant returned for different surfaces.
    #[test]
    fn same_tenant_for_different_surfaces() {
        let resolver =
            TenantResolver::new(Some("00000000-0000-0000-0000-000000000001".to_string()));

        let r_slack = resolver.resolve("team-abc", SurfaceId::Slack).unwrap();
        let r_telegram = resolver.resolve("99887766", SurfaceId::Telegram).unwrap();
        let r_whatsapp = resolver
            .resolve("15550001234", SurfaceId::WhatsApp)
            .unwrap();
        let r_discord = resolver.resolve("guild-id-1", SurfaceId::Discord).unwrap();
        let r_twilio = resolver.resolve("+15550001234", SurfaceId::Twilio).unwrap();

        assert_eq!(r_slack, "00000000-0000-0000-0000-000000000001");
        assert_eq!(r_telegram, r_slack);
        assert_eq!(r_whatsapp, r_slack);
        assert_eq!(r_discord, r_slack);
        assert_eq!(r_twilio, r_slack);
    }

    // Unknown channel install (no tenant configured) → error, not a fake tenant.
    #[test]
    fn unconfigured_returns_adapter_not_configured_error() {
        let resolver = TenantResolver::new(None);

        let result = resolver.resolve("some-chat-id", SurfaceId::Telegram);
        assert!(result.is_err());
        assert!(
            matches!(result.unwrap_err(), AppError::AdapterNotConfigured(_)),
            "missing LANTERN_TENANT_ID must produce AdapterNotConfigured, not a phantom tenant"
        );
    }

    // The platform id does not appear in the returned tenant UUID (sanity check).
    #[test]
    fn platform_id_not_leaked_into_tenant_id() {
        let resolver =
            TenantResolver::new(Some("00000000-0000-0000-0000-000000000001".to_string()));

        let tenant = resolver.resolve("999999999", SurfaceId::Telegram).unwrap();
        assert!(
            !tenant.contains("999999999"),
            "platform chat_id must not appear in the resolved tenant id"
        );
    }

    // Empty platform id is still resolved correctly (edge case — some adapters
    // may produce an empty string when the field is missing from the payload).
    #[test]
    fn empty_platform_id_still_resolves() {
        let resolver =
            TenantResolver::new(Some("00000000-0000-0000-0000-000000000001".to_string()));

        let result = resolver.resolve("", SurfaceId::WhatsApp);
        assert!(result.is_ok());
    }
}
