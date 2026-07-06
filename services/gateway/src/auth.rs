use axum::body::Body;
use axum::http::{Method, Request};
use axum::response::{IntoResponse, Response};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tower::{Layer, Service};

use crate::error::AppError;
use crate::introspect::ApiKeyIntrospector;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub tenant_id: String,
    pub user_id: String,
    pub scopes: Vec<String>,
    pub exp: u64,
    pub iat: u64,
}

impl Claims {
    /// Returns true when the request method is safe (read-only).
    fn is_read_method(method: &Method) -> bool {
        matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
    }

    /// Enforce scope→method mapping:
    ///   - Mutating requests (POST/PUT/PATCH/DELETE) require a `write` scope.
    ///   - Read-only requests (GET/HEAD/OPTIONS) are allowed with any scope.
    ///
    /// Returns Err(AppError::Auth) with a 403-equivalent message on violation.
    pub fn enforce_scope(&self, method: &Method) -> Result<(), AppError> {
        if Self::is_read_method(method) {
            return Ok(());
        }
        // Mutating request — require at least one write-class scope.
        let has_write = self
            .scopes
            .iter()
            .any(|s| s == "write" || s == "admin" || s == "api");
        if has_write {
            Ok(())
        } else {
            Err(AppError::Forbidden(
                "write scope required for mutating requests".to_string(),
            ))
        }
    }
}

#[derive(Clone)]
pub struct AuthLayer {
    jwt_secret: Arc<String>,
    introspector: Option<Arc<ApiKeyIntrospector>>,
}

impl AuthLayer {
    /// `introspector` is `None` when API-key auth is unconfigured
    /// (LANTERN_CONTROL_PLANE_URL / LANTERN_GRPC_SERVICE_TOKEN unset) — the
    /// API-key path then stays fail-closed.
    pub fn new(jwt_secret: String, introspector: Option<Arc<ApiKeyIntrospector>>) -> Self {
        Self {
            jwt_secret: Arc::new(jwt_secret),
            introspector,
        }
    }
}

impl<S> Layer<S> for AuthLayer {
    type Service = AuthMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        AuthMiddleware {
            inner,
            jwt_secret: self.jwt_secret.clone(),
            introspector: self.introspector.clone(),
        }
    }
}

#[derive(Clone)]
pub struct AuthMiddleware<S> {
    inner: S,
    jwt_secret: Arc<String>,
    introspector: Option<Arc<ApiKeyIntrospector>>,
}

impl<S> Service<Request<Body>> for AuthMiddleware<S>
where
    S: Service<Request<Body>, Response = Response> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request<Body>) -> Self::Future {
        let path = req.uri().path().to_string();

        if path == "/healthz" || path == "/readyz" {
            let future = self.inner.call(req);
            return Box::pin(future);
        }

        let jwt_secret = self.jwt_secret.clone();
        let introspector = self.introspector.clone();
        let mut inner = self.inner.clone();
        // Extract the credential synchronously so the async block never borrows
        // `req` across an `.await` (which would make the future non-Send).
        let credential = extract_credential(&req);

        Box::pin(async move {
            let claims =
                match resolve_claims(credential, &jwt_secret, introspector.as_deref()).await {
                    Ok(claims) => claims,
                    Err(err) => {
                        return Ok(err.into_response());
                    }
                };

            // H3: enforce scope before the request reaches any handler.
            if let Err(err) = claims.enforce_scope(req.method()) {
                return Ok(err.into_response());
            }

            tracing::debug!(
                tenant_id = %claims.tenant_id,
                user_id = %claims.user_id,
                "authenticated request"
            );

            req.extensions_mut().insert(claims);
            inner.call(req).await
        })
    }
}

/// A presented credential, extracted from request headers (owned, so it can
/// cross an `.await` without borrowing the request).
enum Credential {
    Jwt(String),
    ApiKey(String),
}

/// Pull the credential out of the request headers synchronously. Bearer JWT
/// wins over X-API-Key when both are present.
fn extract_credential(req: &Request<Body>) -> Result<Credential, AppError> {
    if let Some(auth_header) = req.headers().get("authorization") {
        let header_str = auth_header
            .to_str()
            .map_err(|_| AppError::Auth("invalid authorization header encoding".to_string()))?;
        if let Some(token) = header_str.strip_prefix("Bearer ") {
            return Ok(Credential::Jwt(token.trim().to_string()));
        }
    }

    if let Some(api_key_header) = req.headers().get("x-api-key") {
        let key = api_key_header
            .to_str()
            .map_err(|_| AppError::Auth("invalid X-API-Key header encoding".to_string()))?;
        return Ok(Credential::ApiKey(key.to_string()));
    }

    Err(AppError::Auth(
        "missing authorization header or X-API-Key".to_string(),
    ))
}

async fn resolve_claims(
    credential: Result<Credential, AppError>,
    jwt_secret: &str,
    introspector: Option<&ApiKeyIntrospector>,
) -> Result<Claims, AppError> {
    match credential? {
        Credential::Jwt(token) => decode_jwt(&token, jwt_secret),
        // API-key path: introspect against the control-plane (cached 60s). Still
        // FAILS CLOSED when introspection is unconfigured — a caller must not be
        // able to impersonate a tenant by forging the key body.
        Credential::ApiKey(key) => match introspector {
            Some(i) => i.introspect(&key).await,
            None => Err(AppError::Auth(
                "API-key authentication is not configured at this gateway (set \
                 LANTERN_CONTROL_PLANE_URL and LANTERN_GRPC_SERVICE_TOKEN)"
                    .to_string(),
            )),
        },
    }
}

fn decode_jwt(token: &str, secret: &str) -> Result<Claims, AppError> {
    let decoding_key = DecodingKey::from_secret(secret.as_bytes());
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_required_spec_claims(&["exp", "iat"]);

    let token_data = jsonwebtoken::decode::<Claims>(token, &decoding_key, &validation)
        .map_err(|e| AppError::Auth(format!("invalid JWT: {e}")))?;

    if token_data.claims.tenant_id.is_empty() {
        return Err(AppError::Auth("JWT missing tenant_id claim".to_string()));
    }

    Ok(token_data.claims)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Method;
    use jsonwebtoken::{encode, EncodingKey, Header};

    fn make_jwt(claims: &Claims, secret: &str) -> String {
        encode(
            &Header::default(),
            claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    }

    fn valid_claims() -> Claims {
        let exp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        Claims {
            tenant_id: "tenant-abc".to_string(),
            user_id: "user-1".to_string(),
            scopes: vec!["read".to_string()],
            exp,
            iat: 0,
        }
    }

    // ---- decode_jwt ----

    #[test]
    fn decode_jwt_valid_token() {
        let secret = "super-secret";
        let claims = valid_claims();
        let token = make_jwt(&claims, secret);
        let result = decode_jwt(&token, secret);
        assert!(result.is_ok(), "valid JWT must decode successfully");
        let decoded = result.unwrap();
        assert_eq!(decoded.tenant_id, "tenant-abc");
        assert_eq!(decoded.user_id, "user-1");
    }

    #[test]
    fn decode_jwt_wrong_secret_rejected() {
        let claims = valid_claims();
        let token = make_jwt(&claims, "right-secret");
        let result = decode_jwt(&token, "wrong-secret");
        assert!(result.is_err(), "JWT signed with wrong secret must fail");
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::Auth(_)),
            "error must be AppError::Auth"
        );
    }

    #[test]
    fn decode_jwt_expired_token_rejected() {
        let mut claims = valid_claims();
        claims.exp = 1; // unix epoch + 1s — always expired
        let token = make_jwt(&claims, "secret");
        let result = decode_jwt(&token, "secret");
        assert!(result.is_err(), "expired JWT must be rejected");
    }

    #[test]
    fn decode_jwt_empty_tenant_id_rejected() {
        let mut claims = valid_claims();
        claims.tenant_id = String::new();
        let token = make_jwt(&claims, "secret");
        let result = decode_jwt(&token, "secret");
        assert!(result.is_err(), "empty tenant_id must be rejected");
        let err = result.unwrap_err();
        assert!(matches!(err, AppError::Auth(_)));
    }

    #[test]
    fn decode_jwt_malformed_token_rejected() {
        let result = decode_jwt("not.a.jwt", "secret");
        assert!(result.is_err());
    }

    #[test]
    fn decode_jwt_empty_token_rejected() {
        let result = decode_jwt("", "secret");
        assert!(result.is_err());
    }

    // ---- C2: API-key path fails closed ----

    #[tokio::test]
    async fn api_key_rejected_when_introspection_unconfigured() {
        // With no introspector wired (unset control-plane URL / service token)
        // the API-key path must fail closed — no tenant impersonation.
        let req = Request::builder()
            .method(Method::GET)
            .uri("/v1/agents")
            .header("x-api-key", "hlx_live_mytenant_randomsuffix")
            .body(Body::empty())
            .unwrap();
        let result = resolve_claims(extract_credential(&req), "jwt-secret", None).await;
        assert!(
            result.is_err(),
            "API-key auth must fail closed — no tenant impersonation"
        );
        assert!(
            matches!(result.unwrap_err(), AppError::Auth(_)),
            "error must be AppError::Auth"
        );
    }

    #[tokio::test]
    async fn api_key_arbitrary_tenant_rejected() {
        // An attacker forging hlx_live_victim_anything must be rejected when
        // introspection is unconfigured.
        let req = Request::builder()
            .method(Method::POST)
            .uri("/v1/runs")
            .header("x-api-key", "hlx_live_victim-tenant_exploit")
            .body(Body::empty())
            .unwrap();
        let result = resolve_claims(extract_credential(&req), "jwt-secret", None).await;
        assert!(result.is_err());
    }

    // ---- H3: scope enforcement ----

    fn claims_with_scopes(scopes: &[&str]) -> Claims {
        Claims {
            tenant_id: "t1".to_string(),
            user_id: "u1".to_string(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            exp: u64::MAX,
            iat: 0,
        }
    }

    #[test]
    fn read_scope_allows_get() {
        let claims = claims_with_scopes(&["read"]);
        assert!(claims.enforce_scope(&Method::GET).is_ok());
    }

    #[test]
    fn read_scope_blocks_post() {
        let claims = claims_with_scopes(&["read"]);
        let err = claims.enforce_scope(&Method::POST);
        assert!(err.is_err());
        assert!(matches!(err.unwrap_err(), AppError::Forbidden(_)));
    }

    #[test]
    fn read_scope_blocks_delete() {
        let claims = claims_with_scopes(&["read"]);
        assert!(claims.enforce_scope(&Method::DELETE).is_err());
    }

    #[test]
    fn write_scope_allows_post() {
        let claims = claims_with_scopes(&["write"]);
        assert!(claims.enforce_scope(&Method::POST).is_ok());
    }

    #[test]
    fn admin_scope_allows_delete() {
        let claims = claims_with_scopes(&["admin"]);
        assert!(claims.enforce_scope(&Method::DELETE).is_ok());
    }

    #[test]
    fn api_scope_allows_post() {
        // "api" scope (legacy) is treated as write-capable.
        let claims = claims_with_scopes(&["api"]);
        assert!(claims.enforce_scope(&Method::POST).is_ok());
    }

    #[test]
    fn no_scopes_blocks_post() {
        let claims = claims_with_scopes(&[]);
        assert!(claims.enforce_scope(&Method::POST).is_err());
    }

    #[test]
    fn options_always_allowed() {
        let claims = claims_with_scopes(&[]); // no scopes
        assert!(claims.enforce_scope(&Method::OPTIONS).is_ok());
    }
}
