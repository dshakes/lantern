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
//!
//! Production backends (Vault, AWS Secrets Manager, control-plane relay) plug
//! in here once the harness↔manager gRPC path is validated end-to-end.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

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
}
