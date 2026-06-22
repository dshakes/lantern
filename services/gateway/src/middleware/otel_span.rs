// Middleware that opens a per-request tracing span carrying the tenant identifier
// and parented to any inbound W3C TraceContext, so gateway requests join the
// caller's distributed trace instead of starting a fresh root every time.
//
// It runs after `AuthLayer` has inserted `Claims` into the request extensions,
// so `tenant_id` is available. Two things this layer must get right (an earlier
// version got both wrong):
//
//   1. The span DECLARES `tenant_id` up front (`field::Empty`). `Span::record`
//      silently drops a field that wasn't declared at span creation, so
//      recording onto `TraceLayer`'s default span (which declares nothing) was
//      a no-op. We own the span here, with the field declared, then record it.
//   2. The inbound context is attached via `set_parent`, not merely extracted.
//      Extracting and dropping the context (as before) never propagated the
//      upstream trace id. `set_parent` makes this span a child of the remote
//      span; with no `traceparent` header the extracted context is empty and
//      the span is a normal root.
//
// Placement in the stack:
//   SetRequestIdLayer → PropagateRequestIdLayer → TraceLayer
//     → CorsLayer → AuthLayer (inserts Claims) → OtelSpanLayer (opens span)
//       → RateLimitLayer → handler

use axum::body::Body;
use axum::http::Request;
use axum::response::Response;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use tower::{Layer, Service};
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;

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
        // Open the request span with tenant_id declared so it can be recorded
        // below (see the module doc for why recording onto TraceLayer's span
        // didn't work).
        let span = tracing::info_span!("gateway.request", tenant_id = tracing::field::Empty);

        // Honour an inbound W3C `traceparent`: make this span a child of the
        // upstream context. Empty context (no header) → a normal root span.
        let parent_cx = otel::extract_from_headers(req.headers());
        span.set_parent(parent_cx);

        // Auth runs before this layer, so Claims (and tenant_id) are present on
        // non-public routes.
        if let Some(claims) = req.extensions().get::<Claims>() {
            span.record("tenant_id", claims.tenant_id.as_str());
        }

        Box::pin(self.inner.call(req).instrument(span))
    }
}
