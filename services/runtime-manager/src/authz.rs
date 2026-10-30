//! Per-call authorization for the `RuntimeManager` gRPC service (ADR 0025).
//!
//! Every per-VM client cert is signed by the CA the server trusts, so the TLS
//! handshake alone cannot tell a guest from the scheduler. This interceptor
//! closes that gap:
//!
//! 1. A peer presenting a **VM cert** (`OU=pal-vm`, or the pre-rename
//!    marker, see `tls::LEGACY_VM_CERT_OU`) is refused outright —
//!    guests may only reach `RuntimeHarness`, whose methods bind the cert
//!    CN/SAN to the request's `vm_id` per message.
//! 2. Everyone else must present `x-pal-service-token` ==
//!    `PAL_GRPC_SERVICE_TOKEN` (constant-time compare) — the same shared
//!    token the Go services use for their trust boundaries (invariant #7).
//!
//! Token unset: prod (`PAL_ENV` prod/production/staging) refuses to start;
//! dev warns and allows, matching the Go services.

use std::sync::Arc;

use tonic::{Request, Status};

pub const SERVICE_TOKEN_HEADER: &str = "x-pal-service-token";
pub const ENV_SERVICE_TOKEN: &str = "PAL_GRPC_SERVICE_TOKEN";

/// Interceptor state. Cheap to clone (tonic clones it per connection).
#[derive(Clone)]
pub struct ManagerAuth {
    token: Option<Arc<str>>,
}

impl ManagerAuth {
    pub fn new(token: Option<String>) -> Self {
        Self {
            token: token.filter(|t| !t.is_empty()).map(Arc::from),
        }
    }

    /// Build from env. Errors (refuse to start) in prod when the token is unset.
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_parts(
            std::env::var(ENV_SERVICE_TOKEN).ok(),
            crate::tls::is_prod_env(),
        )
    }

    fn from_parts(token: Option<String>, prod: bool) -> anyhow::Result<Self> {
        let auth = Self::new(token);
        if auth.token.is_none() {
            if prod {
                anyhow::bail!(
                    "{ENV_SERVICE_TOKEN} is required in production — refusing to start \
                     the runtime-manager with an unauthenticated RuntimeManager service"
                );
            }
            tracing::warn!(
                "{ENV_SERVICE_TOKEN} unset — RuntimeManager service-token check disabled (dev mode)"
            );
        }
        Ok(auth)
    }

    /// The pure decision: `peer_is_vm` = the TLS peer presented a VM cert;
    /// `presented` = the raw service-token header value (see [`presented_token`]).
    // `Status` is large by design; this runs once per call.
    #[allow(clippy::result_large_err)]
    pub fn check(&self, peer_is_vm: bool, presented: Option<&[u8]>) -> Result<(), Status> {
        if peer_is_vm {
            return Err(Status::permission_denied(
                "VM client certificates may not call RuntimeManager methods",
            ));
        }
        let Some(expected) = self.token.as_deref() else {
            return Ok(()); // dev: token unset (prod refused to start)
        };
        match presented {
            Some(p) if ct_eq(p, expected.as_bytes()) => Ok(()),
            _ => Err(Status::unauthenticated(
                "missing or invalid x-pal-service-token",
            )),
        }
    }
}

impl tonic::service::Interceptor for ManagerAuth {
    fn call(&mut self, req: Request<()>) -> Result<Request<()>, Status> {
        let peer_is_vm = req
            .peer_certs()
            .and_then(|chain| {
                chain
                    .first()
                    .map(|c| crate::tls::is_vm_client_cert(c.as_ref()))
            })
            .unwrap_or(false);
        self.check(peer_is_vm, presented_token(req.metadata()))?;
        Ok(req)
    }
}

/// The token under the service-token header. An empty value counts as absent.
pub fn presented_token(md: &tonic::metadata::MetadataMap) -> Option<&[u8]> {
    md.get(SERVICE_TOKEN_HEADER)
        .map(|v| v.as_bytes())
        .filter(|v| !v.is_empty())
}

/// Constant-time byte comparison (length is not secret).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len()
        && std::hint::black_box(a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y))) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::Code;
    use tonic::service::Interceptor;

    #[test]
    fn token_required_when_configured() {
        let auth = ManagerAuth::new(Some("s3cret".into()));
        assert!(auth.check(false, Some(b"s3cret")).is_ok());
        assert_eq!(
            auth.check(false, Some(b"wrong!")).unwrap_err().code(),
            Code::Unauthenticated
        );
        assert_eq!(
            auth.check(false, Some(b"s3cre")).unwrap_err().code(),
            Code::Unauthenticated
        );
        assert_eq!(
            auth.check(false, None).unwrap_err().code(),
            Code::Unauthenticated
        );
    }

    #[test]
    fn vm_cert_denied_even_with_valid_token() {
        let auth = ManagerAuth::new(Some("s3cret".into()));
        assert_eq!(
            auth.check(true, Some(b"s3cret")).unwrap_err().code(),
            Code::PermissionDenied
        );
        // Dev (no token) still refuses guests.
        let dev = ManagerAuth::new(None);
        assert_eq!(
            dev.check(true, None).unwrap_err().code(),
            Code::PermissionDenied
        );
    }

    #[test]
    fn dev_without_token_allows_service_calls() {
        assert!(ManagerAuth::new(None).check(false, None).is_ok());
        // Empty string is "unset", not a token that matches empty headers.
        assert!(ManagerAuth::new(Some(String::new())).token.is_none());
    }

    #[test]
    fn prod_without_token_refuses_to_start() {
        assert!(ManagerAuth::from_parts(None, true).is_err());
        assert!(ManagerAuth::from_parts(Some(String::new()), true).is_err());
        assert!(ManagerAuth::from_parts(Some("t".into()), true).is_ok());
        assert!(ManagerAuth::from_parts(None, false).is_ok());
    }

    #[test]
    fn interceptor_reads_metadata_header() {
        let mut auth = ManagerAuth::new(Some("tok".into()));
        let mut ok = Request::new(());
        ok.metadata_mut()
            .insert(SERVICE_TOKEN_HEADER, "tok".parse().unwrap());
        assert!(auth.call(ok).is_ok());
        assert_eq!(
            auth.call(Request::new(())).unwrap_err().code(),
            Code::Unauthenticated
        );
    }
}
