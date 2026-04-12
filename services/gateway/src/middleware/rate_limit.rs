use axum::body::Body;
use axum::http::Request;
use axum::response::{IntoResponse, Response};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tower::{Layer, Service};

use crate::auth::Claims;
use crate::error::AppError;

/// Redis-backed token bucket rate limiter.
///
/// Uses a single EVAL script to atomically check and decrement tokens.
/// Falls back to allowing all requests if Redis is unavailable.
const RATE_LIMIT_SCRIPT: &str = r#"
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil then
    tokens = capacity
    last_refill = now
end

local elapsed = math.max(0, now - last_refill)
local refill = elapsed * rate
tokens = math.min(capacity, tokens + refill)

if tokens < requested then
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
    redis.call('EXPIRE', key, 60)
    local wait = (requested - tokens) / rate
    return tostring(-wait)
end

tokens = tokens - requested
redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
redis.call('EXPIRE', key, 60)
return tostring(tokens)
"#;

#[derive(Clone)]
pub struct RateLimitConfig {
    pub requests_per_second: f64,
    pub burst_capacity: f64,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            requests_per_second: 100.0,
            burst_capacity: 200.0,
        }
    }
}

#[derive(Clone)]
pub struct RateLimitLayer {
    redis: Option<redis::Client>,
    config: Arc<RateLimitConfig>,
}

impl RateLimitLayer {
    pub fn new(redis: Option<redis::Client>, config: RateLimitConfig) -> Self {
        Self {
            redis,
            config: Arc::new(config),
        }
    }
}

impl<S> Layer<S> for RateLimitLayer {
    type Service = RateLimitMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        RateLimitMiddleware {
            inner,
            redis: self.redis.clone(),
            config: self.config.clone(),
        }
    }
}

#[derive(Clone)]
pub struct RateLimitMiddleware<S> {
    inner: S,
    redis: Option<redis::Client>,
    config: Arc<RateLimitConfig>,
}

impl<S> Service<Request<Body>> for RateLimitMiddleware<S>
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

    fn call(&mut self, req: Request<Body>) -> Self::Future {
        let path = req.uri().path().to_string();

        // Skip rate limiting for health endpoints
        if path == "/healthz" || path == "/readyz" {
            let future = self.inner.call(req);
            return Box::pin(future);
        }

        let redis = self.redis.clone();
        let config = self.config.clone();
        let mut inner = self.inner.clone();

        Box::pin(async move {
            // Extract tenant_id from request extensions (set by auth middleware)
            let tenant_id = req
                .extensions()
                .get::<Claims>()
                .map(|c| c.tenant_id.clone());

            if let (Some(client), Some(tid)) = (&redis, &tenant_id) {
                match check_rate_limit(client, tid, &config).await {
                    Ok(RateLimitResult::Allowed) => {}
                    Ok(RateLimitResult::Denied { retry_after_secs }) => {
                        return Ok(AppError::RateLimited { retry_after_secs }.into_response());
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            tenant_id = %tid,
                            "rate limit check failed, allowing request"
                        );
                    }
                }
            }

            inner.call(req).await
        })
    }
}

enum RateLimitResult {
    Allowed,
    Denied { retry_after_secs: u64 },
}

async fn check_rate_limit(
    client: &redis::Client,
    tenant_id: &str,
    config: &RateLimitConfig,
) -> Result<RateLimitResult, redis::RedisError> {
    let mut conn = client.get_multiplexed_async_connection().await?;

    let key = format!("rl:tenant:{tenant_id}");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();

    let result: String = redis::cmd("EVAL")
        .arg(RATE_LIMIT_SCRIPT)
        .arg(1)
        .arg(&key)
        .arg(config.requests_per_second)
        .arg(config.burst_capacity)
        .arg(now)
        .arg(1)
        .query_async(&mut conn)
        .await?;

    let tokens: f64 = result.parse().unwrap_or(0.0);
    if tokens < 0.0 {
        let wait_secs = (-tokens).ceil() as u64;
        Ok(RateLimitResult::Denied {
            retry_after_secs: wait_secs.max(1),
        })
    } else {
        Ok(RateLimitResult::Allowed)
    }
}
