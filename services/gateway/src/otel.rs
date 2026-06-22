// OpenTelemetry integration for lantern-gateway.
//
// # Design
//
// Only activated when `OTEL_EXPORTER_OTLP_ENDPOINT` (standard OTLP env var)
// or `LANTERN_OTEL_ENABLED=1` is set.  When neither is present every function
// is a cheap no-op, so the default behaviour (no collector configured) is
// completely unchanged — the service starts and runs without any telemetry
// overhead.
//
// The exporter uses OTLP/HTTP (proto encoding) so the endpoint convention
// matches the Go control-plane's `otlptracehttp` exporter and a single
// OpenTelemetry Collector can receive from all services using the same
// `OTEL_EXPORTER_OTLP_ENDPOINT` env var (e.g. `http://otel-collector:4318`).
//
// W3C TraceContext propagation is always installed (even without an exporter)
// so `traceparent` headers from upstream callers are extracted correctly and
// forwarded on outgoing gRPC calls to the control-plane.
//
// # Usage
//
//   let _otel_shutdown = otel::init();   // early in main(), before spans
//   // _otel_shutdown flushes pending spans on drop at process exit

use opentelemetry::propagation::{Extractor, Injector};
use opentelemetry::{global, Context};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::{RandomIdGenerator, Sampler};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/// Initialise the OTel pipeline (no-op when the relevant env vars are absent).
///
/// Must be called once, early in `main()`, before any spans are created.
/// Returns a `SdkShutdown` guard — drop it on process exit to flush pending spans.
pub fn init() -> Option<SdkShutdown> {
    // Always set the W3C propagator regardless of whether the exporter is
    // active. This ensures extract/inject work even in no-exporter mode.
    global::set_text_map_propagator(TraceContextPropagator::new());

    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let enabled = std::env::var("LANTERN_OTEL_ENABLED")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if endpoint.is_none() && !enabled {
        tracing::debug!(
            "otel: OTEL_EXPORTER_OTLP_ENDPOINT not set and LANTERN_OTEL_ENABLED != 1; \
             running without OTLP exporter (W3C propagation headers still active)"
        );
        return None;
    }

    // Default to the standard OTLP/HTTP port when LANTERN_OTEL_ENABLED=1 is set
    // but no explicit endpoint is given.
    let endpoint_str = endpoint.unwrap_or_else(|| "http://localhost:4318".to_string());
    tracing::info!(endpoint = %endpoint_str, "otel: initialising OTLP/HTTP exporter");

    let exporter = match opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(&endpoint_str)
        .build()
    {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "otel: failed to build OTLP/HTTP exporter; continuing without traces"
            );
            return None;
        }
    };

    let tracer_provider = opentelemetry_sdk::trace::TracerProvider::builder()
        .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
        .with_sampler(Sampler::AlwaysOn)
        .with_id_generator(RandomIdGenerator::default())
        .with_resource(opentelemetry_sdk::Resource::new(vec![
            opentelemetry::KeyValue::new("service.name", "lantern-gateway"),
        ]))
        .build();

    global::set_tracer_provider(tracer_provider.clone());

    Some(SdkShutdown(tracer_provider))
}

/// RAII guard: flushes pending spans when dropped.
pub struct SdkShutdown(opentelemetry_sdk::trace::TracerProvider);

impl Drop for SdkShutdown {
    fn drop(&mut self) {
        if let Err(e) = self.0.shutdown() {
            // Best-effort — we are in process teardown.
            tracing::warn!(error = %e, "otel: tracer provider shutdown error");
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP carrier adapters (for extracting traceparent from inbound HTTP requests)
// ---------------------------------------------------------------------------

/// Adapter: reads propagation headers (e.g. `traceparent`) from an HTTP `HeaderMap`.
pub struct HeaderExtractor<'a>(pub &'a axum::http::HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|k| k.as_str()).collect()
    }
}

/// Adapter: writes propagation headers into an HTTP `HeaderMap` for outbound calls.
pub struct HeaderInjector<'a>(pub &'a mut axum::http::HeaderMap);

impl Injector for HeaderInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        if let (Ok(name), Ok(val)) = (
            axum::http::HeaderName::from_bytes(key.as_bytes()),
            axum::http::HeaderValue::from_str(&value),
        ) {
            self.0.insert(name, val);
        }
    }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/// Extract an OTel `Context` from the inbound HTTP request headers.
///
/// Returns a root context when no `traceparent` header is present, so callers
/// can always use the returned context as the parent for a new span.
pub fn extract_from_headers(headers: &axum::http::HeaderMap) -> Context {
    global::get_text_map_propagator(|prop| prop.extract(&HeaderExtractor(headers)))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;
    use opentelemetry::propagation::TextMapPropagator;
    use opentelemetry::trace::{
        SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState,
    };
    use opentelemetry_sdk::propagation::TraceContextPropagator;

    /// A known `traceparent` header round-trips through extract → inject unchanged.
    #[test]
    fn trace_context_survives_http_hop() {
        let propagator = TraceContextPropagator::new();

        let trace_id = TraceId::from_hex("4bf92f3577b34da6a3ce929d0e0e4736").unwrap();
        let span_id = SpanId::from_hex("00f067aa0ba902b7").unwrap();
        let span_ctx = SpanContext::new(
            trace_id,
            span_id,
            TraceFlags::SAMPLED,
            true,
            TraceState::default(),
        );

        // Inject into a HeaderMap.
        let parent_cx = Context::default().with_remote_span_context(span_ctx);
        let mut headers = HeaderMap::new();
        propagator.inject_context(&parent_cx, &mut HeaderInjector(&mut headers));

        let tp = headers
            .get("traceparent")
            .expect("traceparent header must be present");
        let tp_str = tp.to_str().expect("traceparent must be valid ASCII");
        assert!(
            tp_str.contains("4bf92f3577b34da6a3ce929d0e0e4736"),
            "traceparent must contain the trace id: {tp_str}"
        );

        // Extract back out.
        let extracted_cx = propagator.extract(&HeaderExtractor(&headers));
        let sc = extracted_cx.span().span_context();

        assert!(sc.is_valid(), "extracted span context must be valid");
        assert_eq!(sc.trace_id(), trace_id, "trace id must round-trip");
        assert_eq!(sc.span_id(), span_id, "span id must round-trip");
    }

    /// Empty headers produce an invalid (root) span context — no panic.
    #[test]
    fn extract_empty_headers_returns_invalid_context() {
        let propagator = TraceContextPropagator::new();
        let headers = HeaderMap::new();
        let cx = propagator.extract(&HeaderExtractor(&headers));
        let sc = cx.span().span_context();
        assert!(
            !sc.is_valid(),
            "empty headers must produce an invalid span context (fresh root trace)"
        );
    }
}
