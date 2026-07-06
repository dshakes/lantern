//! API-key introspection against the control-plane.
//!
//! On `X-API-Key`, the gateway POSTs the raw key to the control-plane's
//! `/internal/auth/introspect-key` endpoint (authenticated with the shared
//! `LANTERN_GRPC_SERVICE_TOKEN`) and, on 200, builds service `Claims` from the
//! returned tenant + scopes. Successful lookups are cached in-memory for 60s
//! keyed by the SHA-256 of the key, so the hot path avoids a round trip.
//!
//! FAIL-CLOSED: any error, non-200, or malformed response maps to
//! `AppError::Auth`. When the control-plane URL or service token is unset the
//! introspector is not constructed at all (`from_env` → `None`) and the
//! API-key path stays closed with a clear message.
//!
//! Secrets discipline (invariant #10): the raw key and the service token are
//! never logged.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::auth::Claims;
use crate::error::AppError;

const CACHE_TTL: Duration = Duration::from_secs(60);
const SERVICE_TOKEN_HEADER: &str = "x-lantern-service-token";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
struct IntrospectResponse {
    #[serde(rename = "tenantId")]
    tenant_id: String,
    #[serde(default)]
    scopes: Vec<String>,
}

/// SHA-256 of the raw key — used as the cache key so raw keys are never held as
/// map keys.
fn key_hash(raw_key: &str) -> [u8; 32] {
    let digest = ring::digest::digest(&ring::digest::SHA256, raw_key.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

/// Build service Claims from an introspection result. No user id (machine
/// token); short exp mirrors the cache TTL — scopes are what actually gate the
/// request downstream via `Claims::enforce_scope`.
fn build_claims(tenant_id: String, scopes: Vec<String>) -> Claims {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Claims {
        tenant_id,
        user_id: String::new(),
        scopes,
        iat: now,
        exp: now + CACHE_TTL.as_secs(),
    }
}

struct CacheEntry {
    tenant_id: String,
    scopes: Vec<String>,
    expires_at: Instant,
}

/// Tiny expiring cache. `now` is injected so expiry is unit-testable without
/// sleeping. ponytail: prune-on-access only — rotated keys linger until their
/// (≤60s) entry is next looked up; add a sweeper only if the map grows unbounded.
#[derive(Default)]
struct IntrospectCache {
    inner: Mutex<HashMap<[u8; 32], CacheEntry>>,
}

impl IntrospectCache {
    fn get(&self, key: &[u8; 32], now: Instant) -> Option<(String, Vec<String>)> {
        let mut map = self.inner.lock().unwrap();
        match map.get(key) {
            Some(e) if e.expires_at > now => Some((e.tenant_id.clone(), e.scopes.clone())),
            Some(_) => {
                map.remove(key);
                None
            }
            None => None,
        }
    }

    fn insert(&self, key: [u8; 32], tenant_id: String, scopes: Vec<String>, expires_at: Instant) {
        self.inner.lock().unwrap().insert(
            key,
            CacheEntry {
                tenant_id,
                scopes,
                expires_at,
            },
        );
    }
}

pub struct ApiKeyIntrospector {
    http: reqwest::Client,
    url: String,
    service_token: String,
    cache: IntrospectCache,
}

impl ApiKeyIntrospector {
    /// Construct from env. Returns `None` (API-key auth disabled, fail-closed)
    /// when either `LANTERN_CONTROL_PLANE_URL` or `LANTERN_GRPC_SERVICE_TOKEN`
    /// is unset/empty.
    pub fn from_env() -> Option<Self> {
        let base = std::env::var("LANTERN_CONTROL_PLANE_URL")
            .ok()
            .filter(|v| !v.is_empty())?;
        let service_token = std::env::var("LANTERN_GRPC_SERVICE_TOKEN")
            .ok()
            .filter(|v| !v.is_empty())?;
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .ok()?;
        Some(Self {
            http,
            url: format!(
                "{}/internal/auth/introspect-key",
                base.trim_end_matches('/')
            ),
            service_token,
            cache: IntrospectCache::default(),
        })
    }

    /// Validate a raw API key, returning service Claims. Cached on success for
    /// `CACHE_TTL`. Any failure fails closed with `AppError::Auth`.
    pub async fn introspect(&self, raw_key: &str) -> Result<Claims, AppError> {
        let hash = key_hash(raw_key);
        if let Some((tenant_id, scopes)) = self.cache.get(&hash, Instant::now()) {
            return Ok(build_claims(tenant_id, scopes));
        }

        let resp = self
            .http
            .post(&self.url)
            .header(SERVICE_TOKEN_HEADER, &self.service_token)
            .json(&serde_json::json!({ "key": raw_key }))
            .send()
            .await
            .map_err(|_| AppError::Auth("API-key introspection request failed".to_string()))?;

        let status = resp.status().as_u16();
        let body = resp.bytes().await.map_err(|_| {
            AppError::Auth("API-key introspection: unreadable response".to_string())
        })?;

        let (tenant_id, scopes) = parse_introspect_response(status, &body)?;
        self.cache.insert(
            hash,
            tenant_id.clone(),
            scopes.clone(),
            Instant::now() + CACHE_TTL,
        );
        Ok(build_claims(tenant_id, scopes))
    }
}

/// Pure parse of the introspection response — fail-closed on anything but a
/// well-formed 200 with a non-empty tenant. Unit-tested.
fn parse_introspect_response(status: u16, body: &[u8]) -> Result<(String, Vec<String>), AppError> {
    if status != 200 {
        return Err(AppError::Auth("invalid API key".to_string()));
    }
    let parsed: IntrospectResponse = serde_json::from_slice(body)
        .map_err(|_| AppError::Auth("API-key introspection: malformed response".to_string()))?;
    if parsed.tenant_id.is_empty() {
        return Err(AppError::Auth(
            "API-key introspection: empty tenant".to_string(),
        ));
    }
    Ok((parsed.tenant_id, parsed.scopes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ok_maps_tenant_and_scopes() {
        let (tenant, scopes) =
            parse_introspect_response(200, br#"{"tenantId":"t1","scopes":["read","write"]}"#)
                .expect("200 should parse");
        assert_eq!(tenant, "t1");
        assert_eq!(scopes, vec!["read".to_string(), "write".to_string()]);
    }

    #[test]
    fn parse_ok_missing_scopes_defaults_empty() {
        let (tenant, scopes) =
            parse_introspect_response(200, br#"{"tenantId":"t1"}"#).expect("200 should parse");
        assert_eq!(tenant, "t1");
        assert!(scopes.is_empty());
    }

    #[test]
    fn parse_non_200_fails_closed() {
        for status in [401u16, 403, 500, 502] {
            let err = parse_introspect_response(status, b"whatever").unwrap_err();
            assert!(
                matches!(err, AppError::Auth(_)),
                "status {status} must be Auth"
            );
        }
    }

    #[test]
    fn parse_malformed_200_fails_closed() {
        let err = parse_introspect_response(200, b"not json").unwrap_err();
        assert!(matches!(err, AppError::Auth(_)));
    }

    #[test]
    fn parse_empty_tenant_fails_closed() {
        let err = parse_introspect_response(200, br#"{"tenantId":"","scopes":[]}"#).unwrap_err();
        assert!(matches!(err, AppError::Auth(_)));
    }

    #[test]
    fn key_hash_is_deterministic_and_distinct() {
        assert_eq!(key_hash("lsk_abc"), key_hash("lsk_abc"));
        assert_ne!(key_hash("lsk_abc"), key_hash("lsk_xyz"));
    }

    #[test]
    fn cache_hit_within_ttl_then_miss_after_expiry() {
        let cache = IntrospectCache::default();
        let key = key_hash("lsk_cache");
        let t0 = Instant::now();
        cache.insert(
            key,
            "t1".to_string(),
            vec!["write".to_string()],
            t0 + Duration::from_secs(60),
        );

        // Hit before expiry.
        let hit = cache.get(&key, t0 + Duration::from_secs(59));
        assert_eq!(hit, Some(("t1".to_string(), vec!["write".to_string()])));

        // Miss at/after expiry — and the expired entry is pruned.
        assert!(cache.get(&key, t0 + Duration::from_secs(61)).is_none());
        assert!(cache.get(&key, t0 + Duration::from_secs(59)).is_none());
    }

    #[test]
    fn cache_miss_for_absent_key() {
        let cache = IntrospectCache::default();
        assert!(cache.get(&key_hash("nope"), Instant::now()).is_none());
    }

    #[test]
    fn build_claims_carries_tenant_and_scopes() {
        let c = build_claims("tenant-x".to_string(), vec!["read".to_string()]);
        assert_eq!(c.tenant_id, "tenant-x");
        assert_eq!(c.scopes, vec!["read".to_string()]);
        assert!(c.user_id.is_empty());
        assert!(c.exp >= c.iat);
    }
}
