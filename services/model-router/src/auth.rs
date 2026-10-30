//! Service-token gate for the gRPC port (CLAUDE.md invariant #7).
//!
//! Callers must present `x-pal-service-token` (or the pre-PAL
//! `x-lantern-service-token`) == `PAL_GRPC_SERVICE_TOKEN`.
//! Without it any pod reaching :50053 could read tenant caches, burn the
//! router's env provider keys, or feed it a stolen `provider_credentials` map.
//! The token is never logged.

use subtle::ConstantTimeEq;
use tonic::{Request, Status};

pub const TOKEN_HEADER: &str = "x-pal-service-token";
/// Pre-PAL name of the same header (ADR 0032); still accepted.
pub const LEGACY_TOKEN_HEADER: &str = "x-lantern-service-token";

/// True for the env values that mean "production-like" (fail closed).
fn is_prod(env: &str) -> bool {
    matches!(
        env.trim().to_ascii_lowercase().as_str(),
        "prod" | "production" | "staging"
    )
}

/// Pure startup check: prod-like env without a token must not start.
pub fn check_startup(env: &str, token: Option<&str>) -> Result<(), &'static str> {
    let unset = token.is_none_or(str::is_empty);
    if unset && is_prod(env) {
        return Err(
            "LANTERN_GRPC_SERVICE_TOKEN is unset in a production-like LANTERN_ENV; \
             refusing to serve the model-router gRPC port unauthenticated",
        );
    }
    Ok(())
}

#[allow(clippy::result_large_err)] // tonic::Status is the mandated interceptor error type
/// Build the interceptor. `None` token (dev only, validated by `check_startup`)
/// allows all calls.
pub fn interceptor(
    token: Option<String>,
) -> impl Fn(Request<()>) -> Result<Request<()>, Status> + Clone {
    let token = token.filter(|t| !t.is_empty());
    move |req: Request<()>| {
        let Some(expected) = token.as_deref() else {
            return Ok(req);
        };
        // PAL name first, the pre-PAL name only when it is absent: exactly
        // one value is compared (ADR 0032).
        let ok = [TOKEN_HEADER, LEGACY_TOKEN_HEADER]
            .into_iter()
            .filter_map(|k| req.metadata().get(k))
            .find(|v| !v.is_empty())
            .is_some_and(|got| bool::from(got.as_bytes().ct_eq(expected.as_bytes())));
        if ok {
            Ok(req)
        } else {
            Err(Status::unauthenticated("invalid or missing service token"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(tok: Option<&str>) -> Request<()> {
        let mut r = Request::new(());
        if let Some(t) = tok {
            r.metadata_mut().insert(TOKEN_HEADER, t.parse().unwrap());
        }
        r
    }

    #[test]
    fn accepts_correct_token() {
        let i = interceptor(Some("s3cret".into()));
        assert!(i(req(Some("s3cret"))).is_ok());
    }

    #[test]
    fn rejects_missing_and_wrong() {
        let i = interceptor(Some("s3cret".into()));
        for r in [
            req(None),
            req(Some("wrong")),
            req(Some("s3cre")),
            req(Some("s3cret!")),
        ] {
            assert_eq!(i(r).unwrap_err().code(), tonic::Code::Unauthenticated);
        }
    }

    #[test]
    fn dev_without_token_allows() {
        assert!(interceptor(None)(req(None)).is_ok());
        assert!(interceptor(Some(String::new()))(req(None)).is_ok());
    }

    #[test]
    fn startup_check() {
        for env in ["prod", "production", "Staging", " PROD "] {
            assert!(check_startup(env, None).is_err());
            assert!(check_startup(env, Some("")).is_err());
            assert!(check_startup(env, Some("t")).is_ok());
        }
        assert!(check_startup("", None).is_ok());
        assert!(check_startup("dev", None).is_ok());
    }

    /// ADR 0032: the legacy header still authenticates; a wrong PAL token is
    /// not rescued by a right legacy one.
    #[test]
    fn accepts_legacy_header_and_compares_one_value() {
        let i = interceptor(Some("s3cret".into()));
        let with = |pairs: &[(&'static str, &str)]| {
            let mut r = Request::new(());
            for (k, v) in pairs {
                r.metadata_mut().insert(*k, v.parse().unwrap());
            }
            r
        };
        assert!(i(with(&[(LEGACY_TOKEN_HEADER, "s3cret")])).is_ok());
        assert!(
            i(with(&[
                (TOKEN_HEADER, "s3cret"),
                (LEGACY_TOKEN_HEADER, "s3cret")
            ]))
            .is_ok()
        );
        assert!(
            i(with(&[
                (TOKEN_HEADER, "nope"),
                (LEGACY_TOKEN_HEADER, "s3cret")
            ]))
            .is_err()
        );
        assert!(i(with(&[(LEGACY_TOKEN_HEADER, "nope")])).is_err());
    }
}
