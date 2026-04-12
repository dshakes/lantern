use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use tracing::{debug, warn};

use crate::proto::{CompleteRequest, CompleteResponse};

/// Prompt-level cache backed by Redis.
///
/// Caches non-streaming, non-tool-use completions keyed on a SHA-256 hash of the
/// normalized request (messages + capability). Streaming and tool-use requests are
/// never cached because they are non-deterministic or have side effects.
pub struct PromptCache {
    client: redis::Client,
    ttl_seconds: u64,
}

impl PromptCache {
    pub fn new(redis_url: &str, ttl_seconds: u64) -> Result<Self, redis::RedisError> {
        let client = redis::Client::open(redis_url)?;
        Ok(Self {
            client,
            ttl_seconds,
        })
    }

    /// Compute a cache key from the request. Returns None if the request is not cacheable.
    fn cache_key(req: &CompleteRequest) -> Option<String> {
        // Don't cache if explicitly opted out.
        if req.no_cache {
            return None;
        }

        // Don't cache requests with tools (non-deterministic tool calling).
        if !req.tools.is_empty() {
            return None;
        }

        let mut hasher = Sha256::new();

        // Hash capability.
        hasher.update(req.capability.to_le_bytes());

        // Hash each message (role + content) in order.
        for msg in &req.messages {
            hasher.update(msg.role.as_bytes());
            hasher.update(b":");
            hasher.update(msg.content.as_bytes());
            hasher.update(b"|");
        }

        // Hash generation parameters that affect output.
        hasher.update(req.max_tokens.to_le_bytes());
        hasher.update(req.temperature.to_le_bytes());
        hasher.update(req.top_p.to_le_bytes());
        for stop in &req.stop {
            hasher.update(stop.as_bytes());
            hasher.update(b",");
        }

        let hash = hex::encode(hasher.finalize());
        Some(format!("lantern:prompt_cache:{hash}"))
    }

    /// Try to get a cached response. Returns None on miss or if the request is not cacheable.
    pub async fn get(&self, req: &CompleteRequest) -> Option<CompleteResponse> {
        let key = Self::cache_key(req)?;

        let mut conn = match self.client.get_multiplexed_async_connection().await {
            Ok(c) => c,
            Err(e) => {
                warn!(error = %e, "failed to connect to redis for cache get");
                return None;
            }
        };

        let data: Option<String> = match conn.get(&key).await {
            Ok(d) => d,
            Err(e) => {
                warn!(error = %e, "redis cache get failed");
                return None;
            }
        };

        let data = data?;

        match serde_json::from_str::<CompleteResponse>(&data) {
            Ok(mut resp) => {
                resp.cache_kind = "prompt_cache".into();
                debug!(key = %key, "prompt cache hit");
                Some(resp)
            }
            Err(e) => {
                warn!(error = %e, key = %key, "failed to deserialize cached response");
                None
            }
        }
    }

    /// Store a response in the cache. No-op if the request is not cacheable.
    pub async fn set(&self, req: &CompleteRequest, resp: &CompleteResponse) {
        let key = match Self::cache_key(req) {
            Some(k) => k,
            None => return,
        };

        let data = match serde_json::to_string(resp) {
            Ok(d) => d,
            Err(e) => {
                warn!(error = %e, "failed to serialize response for cache");
                return;
            }
        };

        let mut conn = match self.client.get_multiplexed_async_connection().await {
            Ok(c) => c,
            Err(e) => {
                warn!(error = %e, "failed to connect to redis for cache set");
                return;
            }
        };

        let result: Result<(), _> = conn.set_ex(&key, &data, self.ttl_seconds).await;
        if let Err(e) = result {
            warn!(error = %e, key = %key, "redis cache set failed");
        } else {
            debug!(key = %key, ttl = self.ttl_seconds, "cached response");
        }
    }
}
