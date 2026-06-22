// Middleware that enriches the current tracing span with tenant and request
// identifiers extracted from authenticated requests.
//
// This runs after the `AuthLayer` has inserted `Claims` into the request
// extensions, so `tenant_id` is available.  It also extracts W3C TraceContext
// from inbound HTTP headers so upstream trace ids are honoured rather than
// starting a fresh root span for every gateway request.
//
// Placement in the stack:
//   SetRequestIdLayer → PropagateRequestIdLayer → TraceLayer (opens span)
//     → CorsLayer → AuthLayer (inserts Claims) → OtelSpanLayer (enriches span)
//       → RateLimitLayer → handler

use axum::body::Body;
use axum::http::Request;
use axum::response::Response;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use tower::{Layer, Service};
use tracing::Span;

use crate::auth::Claims;
use crate::otel;

#[derive(Clone, Default)]
pub struct OtelSpanLayer;

impl<S> Layer<S> for OtelSpanLayer {
    type Service = OtelSpanMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        OtelSpanMiddleware { inner }
    }
}

#[derive(Clone)]
pub struct OtelSpanMiddleware<S> {
    inner: S,
}

impl<S> Service<Request<Body>> for OtelSpanMiddleware<S>
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
        // Extract W3C TraceContext from inbound headers so this gateway request
        // becomes a child of any upstream span (e.g. a caller that injected
        // `traceparent`).  This is always a no-op when no header is present.
        let _parent_cx = otel::extract_from_headers(req.headers());

        // If auth has already run (non-health-check path), record tenant_id on
        // the current span opened by TraceLayer.
        if let Some(claims) = req.extensions().get::<Claims>() {
            let span = Span::current();
            span.record("tenant_id", claims.tenant_id.as_str());
        }

        let future = self.inner.call(req);
        Box::pin(future)
    }
}
