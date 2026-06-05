use axum::body::Body;
use axum::http::Request;
use axum::response::{IntoResponse, Response};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tower::{Layer, Service};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub tenant_id: String,
    pub user_id: String,
    pub scopes: Vec<String>,
    pub exp: u64,
    pub iat: u64,
}

#[derive(Clone)]
pub struct AuthLayer {
    jwt_secret: Arc<String>,
}

impl AuthLayer {
    pub fn new(jwt_secret: String) -> Self {
        Self {
            jwt_secret: Arc::new(jwt_secret),
        }
    }
}

impl<S> Layer<S> for AuthLayer {
    type Service = AuthMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        AuthMiddleware {
            inner,
            jwt_secret: self.jwt_secret.clone(),
        }
    }
}

#[derive(Clone)]
pub struct AuthMiddleware<S> {
    inner: S,
    jwt_secret: Arc<String>,
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
        let mut inner = self.inner.clone();

        Box::pin(async move {
            let claims = match extract_claims(&req, &jwt_secret) {
                Ok(claims) => claims,
                Err(err) => {
                    return Ok(err.into_response());
                }
            };

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

fn extract_claims(req: &Request<Body>, jwt_secret: &str) -> Result<Claims, AppError> {
    if let Some(auth_header) = req.headers().get("authorization") {
        let header_str = auth_header
            .to_str()
            .map_err(|_| AppError::Auth("invalid authorization header encoding".to_string()))?;

        if let Some(token) = header_str.strip_prefix("Bearer ") {
            return decode_jwt(token.trim(), jwt_secret);
        }
    }

    if let Some(api_key_header) = req.headers().get("x-api-key") {
        let key = api_key_header
            .to_str()
            .map_err(|_| AppError::Auth("invalid X-API-Key header encoding".to_string()))?;
        return extract_tenant_from_api_key(key);
    }

    Err(AppError::Auth(
        "missing authorization header or X-API-Key".to_string(),
    ))
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

fn extract_tenant_from_api_key(key: &str) -> Result<Claims, AppError> {
    // API key format: hlx_live_<tenant_id>_<random>
    // For the spike, extract tenant_id from the key structure.
    if !key.starts_with("hlx_live_") && !key.starts_with("hlx_test_") {
        return Err(AppError::Auth("invalid API key format".to_string()));
    }

    let parts: Vec<&str> = key.splitn(4, '_').collect();
    if parts.len() < 4 {
        return Err(AppError::Auth("malformed API key".to_string()));
    }

    let tenant_id = parts[2].to_string();
    if tenant_id.is_empty() {
        return Err(AppError::Auth(
            "API key does not contain a valid tenant_id".to_string(),
        ));
    }

    Ok(Claims {
        tenant_id,
        user_id: "api-key-user".to_string(),
        scopes: vec!["api".to_string()],
        exp: u64::MAX,
        iat: 0,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
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

    // ---- extract_tenant_from_api_key ----

    #[test]
    fn api_key_live_valid() {
        let result = extract_tenant_from_api_key("hlx_live_mytenant_randomsuffix");
        assert!(result.is_ok());
        let claims = result.unwrap();
        assert_eq!(claims.tenant_id, "mytenant");
        assert_eq!(claims.user_id, "api-key-user");
        assert!(claims.scopes.contains(&"api".to_string()));
    }

    #[test]
    fn api_key_test_valid() {
        let result = extract_tenant_from_api_key("hlx_test_acme_abc123");
        assert!(result.is_ok());
        assert_eq!(result.unwrap().tenant_id, "acme");
    }

    #[test]
    fn api_key_wrong_prefix_rejected() {
        let result = extract_tenant_from_api_key("sk_live_mytenant_abc");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::Auth(_)));
    }

    #[test]
    fn api_key_too_few_parts_rejected() {
        // "hlx_live_only3parts" splits into ["hlx", "live", "only3parts"] < 4
        let result = extract_tenant_from_api_key("hlx_live_only3");
        assert!(result.is_err());
    }

    #[test]
    fn api_key_empty_tenant_rejected() {
        // "hlx_live__suffix" — third part is empty
        let result = extract_tenant_from_api_key("hlx_live__suffix");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::Auth(_)));
    }

    #[test]
    fn api_key_empty_string_rejected() {
        let result = extract_tenant_from_api_key("");
        assert!(result.is_err());
    }
}
