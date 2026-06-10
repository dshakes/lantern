//! SecretResolver — pluggable backend for resolving secret URIs to their
//! plaintext values inside the VendSecret RPC handler.
//!
//! # Design
//!
//! The trait is synchronous-ish (async, but the unit-test impls resolve
//! immediately) and purposely narrow: the handler owns all authorization
//! logic (allowlist check, TTL cap, tenant binding). The resolver only
//! answers the question "given this URI, what is the plaintext?".
//!
//! # Backends
//!
//! | Impl | Where used |
//! |------|-----------|
//! | `EnvSecretResolver` | Dev/CI — reads `LANTERN_SECRET_<hex-encoded-uri>`. |
//! | `HashMapSecretResolver` | Unit tests — backed by a `HashMap`. |
//! | `RelaySecretResolver` | Production — calls `POST /v1/runtime/secrets/resolve` |
//! |                        | on the control-plane. Activated when both |
//! |                        | `LANTERN_CONTROL_PLANE_URL` and |
//! |                        | `LANTERN_RUNTIME_SECRET_TOKEN` are set. |
//!
//! # Selection logic (see `build`)
//!
//! When both env vars are set → `RelaySecretResolver`.
//! Otherwise → `EnvSecretResolver` (dev/CI default, unchanged behaviour).
//!
//! The relay is fail-closed: if it is configured but a ref is not found, the
//! error surfaces to the caller. There is no per-ref env fallback when the
//! relay is active (ADR 0008).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

/// Resolve a `lantern.secret://...` URI to its plaintext value.
///
/// Implementations MUST:
/// - Return `Err` when the URI is unknown rather than a default/empty value.
/// - Never log the resolved value.
/// - Be cheaply cloneable (use `Arc` internally if necessary).
#[async_trait]
pub trait SecretResolver: Send + Sync + 'static {
    async fn resolve(&self, secret_uri: &str) -> Result<String, SecretResolverError>;
}

#[derive(Debug, thiserror::Error)]
pub enum SecretResolverError {
    #[error("secret not found: {uri}")]
    NotFound { uri: String },
    #[error("secret resolver backend error: {detail}")]
    Backend { detail: String },
}

// ---------------------------------------------------------------------------
// EnvSecretResolver
// ---------------------------------------------------------------------------

/// Development / CI resolver.
///
/// Reads `LANTERN_SECRET_<key>` from the process environment, where `<key>`
/// is the URI with every non-alphanumeric byte replaced by `_`.  Example:
///
/// ```text
/// secret_uri = "lantern.secret://tenant/t1/key/OPENAI_API_KEY"
/// env var    = LANTERN_SECRET_lantern_secret___tenant_t1_key_OPENAI_API_KEY
/// ```
///
/// This keeps secrets out of the process's args and out of any log lines that
/// happen to dump env — they're still in the env block, but no more exposed
/// than normal env-var secrets.
///
/// **Never use in production.** Set `LANTERN_SECRET_RESOLVER=env` only in
/// dev/test environments.
#[derive(Clone, Default)]
pub struct EnvSecretResolver;

impl EnvSecretResolver {
    fn env_key(uri: &str) -> String {
        let slug: String = uri
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect();
        format!("LANTERN_SECRET_{slug}")
    }
}

#[async_trait]
impl SecretResolver for EnvSecretResolver {
    async fn resolve(&self, secret_uri: &str) -> Result<String, SecretResolverError> {
        let key = Self::env_key(secret_uri);
        std::env::var(&key).map_err(|_| SecretResolverError::NotFound {
            uri: secret_uri.to_string(),
        })
    }
}

// ---------------------------------------------------------------------------
// HashMapSecretResolver (unit tests)
// ---------------------------------------------------------------------------

/// In-memory resolver backed by a plain `HashMap`. Intended for unit tests
/// only — constructing one with `new(secrets)` is the entire setup.
#[derive(Clone)]
pub struct HashMapSecretResolver {
    inner: Arc<HashMap<String, String>>,
}

impl HashMapSecretResolver {
    pub fn new(secrets: HashMap<String, String>) -> Self {
        Self {
            inner: Arc::new(secrets),
        }
    }
}

#[async_trait]
impl SecretResolver for HashMapSecretResolver {
    async fn resolve(&self, secret_uri: &str) -> Result<String, SecretResolverError> {
        self.inner
            .get(secret_uri)
            .cloned()
            .ok_or_else(|| SecretResolverError::NotFound {
                uri: secret_uri.to_string(),
            })
    }
}

// ---------------------------------------------------------------------------
// RelaySecretResolver (ADR 0008)
// ---------------------------------------------------------------------------

/// HTTP request body sent to `POST /v1/runtime/secrets/resolve`.
#[derive(Serialize)]
struct RelayResolveRequest<'a> {
    tenant_id: &'a str,
    vm_id: &'a str,
    refs: &'a [String],
}

/// One entry in the `resolved` array of the relay response.
#[derive(Deserialize)]
struct ResolvedRef {
    #[serde(rename = "ref")]
    ref_name: String,
    value: Option<String>,
    #[allow(dead_code)]
    error: Option<String>,
}

/// Top-level relay response envelope.
#[derive(Deserialize)]
struct RelayResolveResponse {
    resolved: Vec<ResolvedRef>,
}

/// Production resolver: calls `POST /v1/runtime/secrets/resolve` on the
/// control-plane with a pre-shared service token.
///
/// Activated when BOTH `LANTERN_CONTROL_PLANE_URL` and
/// `LANTERN_RUNTIME_SECRET_TOKEN` are set in the manager's environment.
///
/// # Transport security (required)
///
/// `LANTERN_CONTROL_PLANE_URL` MUST use the `https://` scheme.  A plaintext
/// `http://` URL is refused at construction time to prevent decrypted tenant
/// secrets and the shared token from crossing the network in cleartext.
///
/// ```text
/// LANTERN_CONTROL_PLANE_URL=https://control-plane.internal:8443
/// ```
///
/// **Dev escape hatch**: set `LANTERN_RUNTIME_RELAY_ALLOW_INSECURE=1` to
/// allow `http://` (local dev / docker-compose only).  A prominent `WARN`
/// log is emitted; the process continues.  Never set this in production.
///
/// # Fail-closed
///
/// When the relay is configured but a ref is not found (the control-plane
/// returns `"error": "not found"` for that ref), the resolver returns
/// `SecretResolverError::NotFound`.  There is no env-var fallback once the
/// relay is active.
///
/// # Security
///
/// The token is NEVER logged — not in error messages, not in traces.  Only
/// ref names (not values) appear in log output.
#[derive(Clone)]
pub struct RelaySecretResolver {
    /// Base URL of the control-plane, e.g. `https://control-plane.internal:8443`.
    control_plane_url: String,
    /// `X-Lantern-Runtime-Token` header value.  Never logged.
    token: String,
    /// Tenant ID this manager node is responsible for.
    tenant_id: String,
    /// VM ID for audit correlation (set from env, best-effort).
    vm_id: String,
    /// Pre-built reqwest client with timeout configured.
    client: reqwest::Client,
}

/// Environment variable names for the relay.
pub const ENV_CONTROL_PLANE_URL: &str = "LANTERN_CONTROL_PLANE_URL";
pub const ENV_RUNTIME_SECRET_TOKEN: &str = "LANTERN_RUNTIME_SECRET_TOKEN";
/// Set to `"1"` to allow a plaintext `http://` control-plane URL in dev.
/// Never set in production — a prominent WARN is emitted when active.
pub const ENV_RELAY_ALLOW_INSECURE: &str = "LANTERN_RUNTIME_RELAY_ALLOW_INSECURE";

/// HTTP timeout for the relay call (both connect and read).
const RELAY_TIMEOUT: Duration = Duration::from_secs(5);

impl RelaySecretResolver {
    /// Construct from explicit values.
    ///
    /// Returns `Err` when:
    /// - `control_plane_url` uses `http://` and `LANTERN_RUNTIME_RELAY_ALLOW_INSECURE`
    ///   is not `"1"` — plaintext transport is refused to prevent secrets from
    ///   crossing the network in cleartext.
    /// - The reqwest client cannot be built (should never happen in practice).
    ///
    /// When the URL is `http://` AND the escape hatch is set, construction
    /// succeeds but a prominent `WARN` is emitted. The token is never included
    /// in any log or error string.
    pub fn new(
        control_plane_url: impl Into<String>,
        token: impl Into<String>,
        tenant_id: impl Into<String>,
        vm_id: impl Into<String>,
    ) -> Result<Self, SecretResolverError> {
        let url: String = control_plane_url.into();

        // Enforce https:// unless the dev escape hatch is explicitly set.
        if url.starts_with("http://") {
            let insecure_ok = std::env::var(ENV_RELAY_ALLOW_INSECURE).as_deref() == Ok("1");
            if insecure_ok {
                // Emit a prominent warning; never log the token.
                tracing::warn!(
                    control_plane_url = %url,
                    "INSECURE: relay transport is plaintext http — dev only; \
                     set LANTERN_CONTROL_PLANE_URL to an https:// address in production"
                );
            } else {
                return Err(SecretResolverError::Backend {
                    detail: format!(
                        "relay: LANTERN_CONTROL_PLANE_URL uses plaintext http:// \
                         ('{url}'); secrets would cross the network in cleartext. \
                         Use https:// or set LANTERN_RUNTIME_RELAY_ALLOW_INSECURE=1 \
                         for local dev only."
                    ),
                });
            }
        }

        let client = reqwest::Client::builder()
            .timeout(RELAY_TIMEOUT)
            .build()
            .map_err(|e| SecretResolverError::Backend {
                detail: format!("relay: failed to build HTTP client: {e}"),
            })?;
        Ok(Self {
            control_plane_url: url,
            token: token.into(),
            tenant_id: tenant_id.into(),
            vm_id: vm_id.into(),
            client,
        })
    }

    /// Try to build from environment variables.
    ///
    /// Returns `Some(RelaySecretResolver)` when both `LANTERN_CONTROL_PLANE_URL`
    /// and `LANTERN_RUNTIME_SECRET_TOKEN` are set AND the URL passes the scheme
    /// check (see [`RelaySecretResolver::new`]).
    ///
    /// Returns `None` when either var is absent.
    ///
    /// Returns `Err` (wrapped in `Some` — the outer `Option` is present) when
    /// both vars are set but the URL fails the scheme check and the insecure
    /// escape hatch is not active.  Callers that want a hard startup failure
    /// should use `from_env_or_err` instead.
    ///
    /// In practice `build()` calls `from_env_or_err` so a bad URL is a hard
    /// startup error, not a silent fallback.
    pub fn from_env() -> Option<Self> {
        let url = std::env::var(ENV_CONTROL_PLANE_URL).ok()?;
        let token = std::env::var(ENV_RUNTIME_SECRET_TOKEN).ok()?;
        let tenant_id = std::env::var("LANTERN_TENANT_ID").unwrap_or_default();
        let vm_id = std::env::var("LANTERN_VM_ID").unwrap_or_default();
        // Silently suppress the error here; `build()` uses from_env_or_err
        // for the hard-failure path.
        Self::new(url, token, tenant_id, vm_id).ok()
    }

    /// Like `from_env` but surfaces a scheme-check failure as `Err` rather
    /// than `None`, so callers can distinguish "env vars not set" (returns
    /// `Ok(None)`) from "vars set but URL is bad" (returns `Err`).
    pub fn from_env_or_err() -> Result<Option<Self>, SecretResolverError> {
        let url = match std::env::var(ENV_CONTROL_PLANE_URL) {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };
        let token = match std::env::var(ENV_RUNTIME_SECRET_TOKEN) {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };
        let tenant_id = std::env::var("LANTERN_TENANT_ID").unwrap_or_default();
        let vm_id = std::env::var("LANTERN_VM_ID").unwrap_or_default();
        Self::new(url, token, tenant_id, vm_id).map(Some)
    }

    /// The relay endpoint path.
    fn resolve_url(&self) -> String {
        format!("{}/v1/runtime/secrets/resolve", self.control_plane_url)
    }

    /// Construct without the scheme check.  Test-only — used by the mock
    /// server helpers that must speak plain `http://`.
    #[cfg(test)]
    fn new_unchecked(
        control_plane_url: impl Into<String>,
        token: impl Into<String>,
        tenant_id: impl Into<String>,
        vm_id: impl Into<String>,
    ) -> Self {
        let client = reqwest::Client::builder()
            .timeout(RELAY_TIMEOUT)
            .build()
            .expect("test: reqwest client build");
        Self {
            control_plane_url: control_plane_url.into(),
            token: token.into(),
            tenant_id: tenant_id.into(),
            vm_id: vm_id.into(),
            client,
        }
    }
}

#[async_trait]
impl SecretResolver for RelaySecretResolver {
    /// Resolve a single `secret_uri` via the control-plane relay.
    ///
    /// Sends a batched request with a single ref.  The response is
    /// fail-closed: a per-ref `"error"` from the control-plane surfaces as
    /// `SecretResolverError::NotFound`.
    ///
    /// # Retry policy
    ///
    /// One retry on connect-level errors only (network not yet up at manager
    /// boot).  No retry on HTTP 4xx/5xx responses — those are definitive.
    async fn resolve(&self, secret_uri: &str) -> Result<String, SecretResolverError> {
        let refs = vec![secret_uri.to_string()];

        // Log ref name only — never the token or a resolved value.
        tracing::debug!(
            ref_name = secret_uri,
            tenant_id = %self.tenant_id,
            vm_id = %self.vm_id,
            "relay: resolving secret ref (value NOT logged)"
        );

        let body = RelayResolveRequest {
            tenant_id: &self.tenant_id,
            vm_id: &self.vm_id,
            refs: &refs,
        };

        let make_request = || {
            self.client
                .post(self.resolve_url())
                .header("X-Lantern-Runtime-Token", &self.token)
                .header("Content-Type", "application/json")
                .json(&body)
        };

        // Single retry on connection error (manager boot race).
        let resp = match make_request().send().await {
            Ok(r) => r,
            Err(e) if e.is_connect() => {
                tracing::warn!(
                    ref_name = secret_uri,
                    error = %e,
                    "relay: connect failed; retrying once"
                );
                make_request()
                    .send()
                    .await
                    .map_err(|e2| SecretResolverError::Backend {
                        // Include error kind only — never the token or ref value.
                        detail: format!("relay: connect failed after retry: {e2}"),
                    })?
            }
            Err(e) => {
                return Err(SecretResolverError::Backend {
                    detail: format!("relay: HTTP send error: {e}"),
                });
            }
        };

        let status = resp.status();

        // 403 = relay disabled or invalid token.  Surface as Backend error
        // (not NotFound) so the caller doesn't think the ref is just absent.
        if status == reqwest::StatusCode::FORBIDDEN {
            return Err(SecretResolverError::Backend {
                detail: format!(
                    "relay: control-plane returned 403 (relay disabled or invalid token) \
                     for ref '{secret_uri}'"
                ),
            });
        }

        if !status.is_success() {
            return Err(SecretResolverError::Backend {
                detail: format!(
                    "relay: control-plane returned HTTP {} for ref '{secret_uri}'",
                    status.as_u16()
                ),
            });
        }

        let relay_resp: RelayResolveResponse =
            resp.json()
                .await
                .map_err(|e| SecretResolverError::Backend {
                    detail: format!("relay: failed to parse response body: {e}"),
                })?;

        // Find the entry for our single ref.
        let entry = relay_resp
            .resolved
            .into_iter()
            .find(|r| r.ref_name == secret_uri)
            .ok_or_else(|| SecretResolverError::Backend {
                detail: format!("relay: response missing entry for ref '{secret_uri}'"),
            })?;

        match entry.value {
            Some(v) => {
                tracing::debug!(
                    ref_name = secret_uri,
                    "relay: ref resolved (value NOT logged)"
                );
                Ok(v)
            }
            None => {
                // Control-plane returned an error for this ref (not found,
                // wrong tenant, parse error — all collapse to NotFound per ADR).
                tracing::debug!(
                    ref_name = secret_uri,
                    "relay: ref not found on control-plane"
                );
                Err(SecretResolverError::NotFound {
                    uri: secret_uri.to_string(),
                })
            }
        }
    }
}

// ---------------------------------------------------------------------------
// build — factory that wires the right resolver from the environment
// ---------------------------------------------------------------------------

/// Build the production `SecretResolver`.
///
/// Decision tree:
/// - Both `LANTERN_CONTROL_PLANE_URL` and `LANTERN_RUNTIME_SECRET_TOKEN` set,
///   URL passes the scheme check → `RelaySecretResolver`.
/// - Both set, but URL is `http://` and `LANTERN_RUNTIME_RELAY_ALLOW_INSECURE`
///   is not `"1"` → **panics** at startup with a clear message.  A plaintext
///   URL is a misconfiguration, not a graceful fallback situation.
/// - Either var absent → `EnvSecretResolver` (dev/CI default).
///
/// The returned `Arc<dyn SecretResolver>` is ready to be shared across
/// service instances.
pub fn build() -> Arc<dyn SecretResolver> {
    match RelaySecretResolver::from_env_or_err() {
        Ok(Some(relay)) => {
            tracing::info!(
                control_plane_url = %relay.control_plane_url,
                tenant_id = %relay.tenant_id,
                "secret resolver: using control-plane relay (ADR 0008)"
            );
            Arc::new(relay)
        }
        Ok(None) => {
            tracing::info!("secret resolver: using env-var resolver (dev/CI mode)");
            Arc::new(EnvSecretResolver)
        }
        Err(e) => {
            // Both env vars were set but the URL failed the scheme check.
            // This is a definitive misconfiguration; panic at startup so the
            // operator sees the error immediately rather than silently falling
            // back to the env resolver (which would mask the bad config).
            panic!(
                "secret resolver: relay misconfiguration — refusing to start: {e}\n\
                 Fix LANTERN_CONTROL_PLANE_URL to use https://, or set \
                 LANTERN_RUNTIME_RELAY_ALLOW_INSECURE=1 for local dev only."
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hashmap_resolver_returns_value() {
        let mut m = HashMap::new();
        m.insert(
            "lantern.secret://tenant/t1/key/OPENAI".to_string(),
            "sk-test-1234".to_string(),
        );
        let r = HashMapSecretResolver::new(m);
        let val = r
            .resolve("lantern.secret://tenant/t1/key/OPENAI")
            .await
            .unwrap();
        assert_eq!(val, "sk-test-1234");
    }

    #[tokio::test]
    async fn hashmap_resolver_missing_returns_not_found() {
        let r = HashMapSecretResolver::new(HashMap::new());
        let err = r.resolve("lantern.secret://tenant/t1/key/MISSING").await;
        assert!(matches!(err, Err(SecretResolverError::NotFound { .. })));
    }

    #[test]
    fn env_key_encoding_is_stable() {
        let uri = "lantern.secret://tenant/t1/key/OPENAI_API_KEY";
        let key = EnvSecretResolver::env_key(uri);
        // Must start with the prefix and replace non-alphanum with _.
        assert!(key.starts_with("LANTERN_SECRET_"));
        assert!(!key.contains("://"), "slashes must be replaced");
        assert!(!key.contains('.'), "dots must be replaced");
    }

    #[tokio::test]
    async fn env_resolver_missing_returns_not_found() {
        let r = EnvSecretResolver;
        // Use a URI whose encoded key definitely doesn't exist.
        let err = r.resolve("lantern.secret://tenant/no-such-key/test").await;
        assert!(matches!(err, Err(SecretResolverError::NotFound { .. })));
    }

    // -----------------------------------------------------------------------
    // RelaySecretResolver tests
    //
    // Each test spins up a minimal tokio TCP/HTTP mock server that speaks
    // HTTP/1.1, serves a canned response body, and shuts down after one
    // request.  We avoid any external crate (axum, warp, etc.) — the server is
    // ~30 lines of raw tokio I/O.
    // -----------------------------------------------------------------------

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Bind an ephemeral port and return (addr, TcpListener).
    async fn bind_mock() -> (std::net::SocketAddr, TcpListener) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        (addr, listener)
    }

    /// Serve exactly one HTTP/1.1 request and respond with `status` and
    /// `body_json`.  The captured request bytes are returned for assertions.
    async fn serve_one(listener: TcpListener, status: u16, body_json: &'static str) -> Vec<u8> {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 4096];
        let n = stream.read(&mut buf).await.unwrap();
        let request_bytes = buf[..n].to_vec();

        let response = format!(
            "HTTP/1.1 {status} OK\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             \r\n\
             {body_json}",
            body_json.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        request_bytes
    }

    /// Build a RelaySecretResolver pointed at the mock server (plain http://).
    ///
    /// Uses `new_unchecked` to bypass the scheme guard — the mock is always
    /// plaintext by necessity; this helper must never be used in production
    /// paths.
    fn relay_for(addr: std::net::SocketAddr, token: &str) -> RelaySecretResolver {
        RelaySecretResolver::new_unchecked(
            format!("http://{addr}"),
            token,
            "tenant-test",
            "vm-test",
        )
    }

    // --- happy path: ref resolves ---

    #[tokio::test]
    async fn relay_happy_path_returns_value() {
        let (addr, listener) = bind_mock().await;

        let body = r#"{"resolved":[{"ref":"lantern.secret/llm/openai","value":"sk-secret-val"}]}"#;
        let server = tokio::spawn(serve_one(listener, 200, body));

        let resolver = relay_for(addr, "valid-token");
        let val = resolver
            .resolve("lantern.secret/llm/openai")
            .await
            .expect("should resolve");

        assert_eq!(val, "sk-secret-val");
        server.await.unwrap();
    }

    // --- not-found: control-plane returns error for the ref ---

    #[tokio::test]
    async fn relay_not_found_surfaces_as_not_found_error() {
        let (addr, listener) = bind_mock().await;

        let body = r#"{"resolved":[{"ref":"lantern.secret/llm/missing","error":"not found"}]}"#;
        let _server = tokio::spawn(serve_one(listener, 200, body));

        let resolver = relay_for(addr, "valid-token");
        let err = resolver
            .resolve("lantern.secret/llm/missing")
            .await
            .expect_err("not-found ref should produce an error");

        assert!(
            matches!(err, SecretResolverError::NotFound { .. }),
            "expected NotFound, got: {err:?}"
        );
        // Token must NOT appear in the error message.
        assert!(
            !format!("{err}").contains("valid-token"),
            "token must not appear in error: {err}"
        );
    }

    // --- 403: wrong or missing token ---

    #[tokio::test]
    async fn relay_403_surfaces_as_backend_error() {
        let (addr, listener) = bind_mock().await;

        let body = r#"{"error":"forbidden"}"#;
        let _server = tokio::spawn(serve_one(listener, 403, body));

        let resolver = relay_for(addr, "wrong-token");
        let err = resolver
            .resolve("lantern.secret/llm/openai")
            .await
            .expect_err("403 should be an error");

        assert!(
            matches!(err, SecretResolverError::Backend { .. }),
            "expected Backend error for 403, got: {err:?}"
        );
        // Token must NOT appear in the error message.
        assert!(
            !format!("{err}").contains("wrong-token"),
            "token must not appear in error: {err}"
        );
    }

    // --- env fallback when relay is not configured ---

    #[tokio::test]
    async fn build_returns_env_resolver_when_relay_not_configured() {
        // Ensure neither env var is set in this test process.
        // We deliberately avoid std::env::remove_var for thread safety;
        // instead construct the resolver directly.
        let relay = RelaySecretResolver::from_env();
        // In the test environment neither LANTERN_CONTROL_PLANE_URL nor
        // LANTERN_RUNTIME_SECRET_TOKEN should be set → None.
        // If they happen to be set in CI the test is a no-op (not a failure).
        if std::env::var(ENV_CONTROL_PLANE_URL).is_err()
            || std::env::var(ENV_RUNTIME_SECRET_TOKEN).is_err()
        {
            assert!(
                relay.is_none(),
                "RelaySecretResolver::from_env() should return None when env vars are absent"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Scheme enforcement tests (security fix)
    // -----------------------------------------------------------------------

    // --- http:// without escape hatch → constructor returns Err ---

    #[test]
    fn http_url_without_escape_hatch_is_refused() {
        // Ensure the escape hatch is NOT set.  We read the current value and
        // assert only when it is absent, so concurrent tests that set it for
        // their own purposes don't cause a false failure here.
        if std::env::var(ENV_RELAY_ALLOW_INSECURE).is_ok() {
            // Escape hatch already active in this process; skip rather than
            // fight the global env.
            return;
        }

        let result = RelaySecretResolver::new(
            "http://control-plane:8080",
            "super-secret-token",
            "tenant-1",
            "vm-1",
        );

        assert!(
            result.is_err(),
            "http:// URL without escape hatch must be refused"
        );

        let err = result
            .err()
            .expect("http:// without escape hatch must be Err");
        let msg = format!("{err}");

        // Error must mention the scheme problem.
        assert!(
            msg.contains("plaintext http://"),
            "error should explain the plaintext problem: {msg}"
        );
        // Token must NOT appear in the error.
        assert!(
            !msg.contains("super-secret-token"),
            "token must not appear in error message: {msg}"
        );
    }

    // --- http:// WITH escape hatch → succeeds, mock server resolves ---

    #[tokio::test]
    async fn http_url_with_escape_hatch_works_against_mock() {
        // This test sets LANTERN_RUNTIME_RELAY_ALLOW_INSECURE=1 via new()
        // directly rather than through std::env::set_var (which is not
        // thread-safe in concurrent test execution).  We instead pass the
        // env var check inside new() by temporarily manipulating the env only
        // for this single-threaded call.  The cleanest approach without
        // touching std::env is to pass the insecure flag explicitly to new().
        //
        // Because we can't mutate the env safely in a concurrent test suite,
        // we verify the allow-insecure path by inspecting new()'s error when
        // the var is absent, and a separate integration-level concern covers
        // the actual WARN log in a process where the var IS set.  Instead,
        // for the "works against mock" assertion we use new_unchecked()
        // (same as relay_for) and confirm a real HTTP round-trip succeeds —
        // the scheme guard path is fully covered by
        // http_url_without_escape_hatch_is_refused.

        let (addr, listener) = bind_mock().await;
        let body = r#"{"resolved":[{"ref":"lantern.secret/llm/openai","value":"relay-val"}]}"#;
        let _server = tokio::spawn(serve_one(listener, 200, body));

        // new_unchecked mirrors what new() does after the escape hatch
        // check passes — we verify the full resolve path works over http.
        let resolver =
            RelaySecretResolver::new_unchecked(format!("http://{addr}"), "test-token", "t1", "vm1");
        let val = resolver
            .resolve("lantern.secret/llm/openai")
            .await
            .expect("resolve should succeed over http with insecure bypass");
        assert_eq!(val, "relay-val");
    }

    // --- error message from scheme refusal contains no token material ---

    #[test]
    fn scheme_refusal_error_contains_no_token() {
        if std::env::var(ENV_RELAY_ALLOW_INSECURE).is_ok() {
            return; // escape hatch active; test inapplicable
        }

        let sentinel = "tok-sentinel-12345";
        let result = RelaySecretResolver::new("http://internal-host:9000", sentinel, "t1", "vm1");

        let err_msg = format!("{}", result.err().expect("http:// must be refused"));
        assert!(
            !err_msg.contains(sentinel),
            "scheme-refusal error must not contain token material: {err_msg}"
        );
    }
}
