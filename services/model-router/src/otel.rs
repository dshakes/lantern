// OpenTelemetry integration for lantern-model-router.
//
// # Design
//
// Only activated when `OTEL_EXPORTER_OTLP_ENDPOINT` (standard OTLP env var)
// or `LANTERN_OTEL_ENABLED=1` is set.  When neither is present every function
// is a cheap no-op — the service behaves exactly as before with zero overhead.
//
// The exporter uses OTLP/gRPC (tonic) matching the runtime-manager convention.
// A single OTel Collector can receive from all Rust services on port 4317.
//
// W3C TraceContext propagation is always installed so `traceparent` metadata
// from the caller (control-plane gRPC client) is extracted correctly and
// child spans are created under the right trace even without an exporter.
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
use tonic::metadata::MetadataMap;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/// Initialise the OTel pipeline (no-op when the relevant env vars are absent).
///
/// Must be called once, early in `main()`, before any spans are created.
/// Returns a `SdkShutdown` guard — drop it on process exit to flush pending spans.
pub fn init() -> Option<SdkShutdown> {
    // Always set the W3C propagator so extract/inject work even without an exporter.
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

    let endpoint_str = endpoint.unwrap_or_else(|| "http://localhost:4317".to_string());
    tracing::info!(endpoint = %endpoint_str, "otel: initialising OTLP/gRPC exporter");

    let exporter = match opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(&endpoint_str)
        .build()
    {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "otel: failed to build OTLP/gRPC exporter; continuing without traces"
            );
            return None;
        }
    };

    let tracer_provider = opentelemetry_sdk::trace::TracerProvider::builder()
        .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
        .with_sampler(Sampler::AlwaysOn)
        .with_id_generator(RandomIdGenerator::default())
        .with_resource(opentelemetry_sdk::Resource::new(vec![
            opentelemetry::KeyValue::new("service.name", "lantern-model-router"),
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
            tracing::warn!(error = %e, "otel: tracer provider shutdown error");
        }
    }
}

// ---------------------------------------------------------------------------
// gRPC metadata carrier adapters
// ---------------------------------------------------------------------------

/// Adapter: reads `traceparent` / `tracestate` from a tonic `MetadataMap`.
struct MetadataExtractor<'a>(&'a MetadataMap);

impl Extractor for MetadataExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0
            .keys()
            .filter_map(|k| match k {
                tonic::metadata::KeyRef::Ascii(k) => Some(k.as_str()),
                _ => None,
            })
            .collect()
    }
}

/// Adapter: writes `traceparent` / `tracestate` into a tonic `MetadataMap`.
struct MetadataInjector<'a>(&'a mut MetadataMap);

impl Injector for MetadataInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        if let Ok(key) = tonic::metadata::MetadataKey::from_bytes(key.as_bytes())
            && let Ok(val) = tonic::metadata::MetadataValue::try_from(value.as_str())
        {
            self.0.insert(key, val);
        }
    }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/// Extract an OTel `Context` from the incoming gRPC request metadata.
///
/// Returns a root context when no `traceparent` header is present, so callers
/// can always use the returned context as the parent for a new span.
pub fn extract_from_metadata(metadata: &MetadataMap) -> Context {
    global::get_text_map_propagator(|prop| prop.extract(&MetadataExtractor(metadata)))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::propagation::TextMapPropagator;
    use opentelemetry::trace::{SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState};
    use opentelemetry_sdk::propagation::TraceContextPropagator;

    /// A `traceparent` injected into gRPC metadata survives extract → inject unchanged.
    #[test]
    fn trace_context_survives_grpc_hop() {
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

        let parent_cx = Context::default().with_remote_span_context(span_ctx);
        let mut meta = MetadataMap::new();
        propagator.inject_context(&parent_cx, &mut MetadataInjector(&mut meta));

        let tp = meta
            .get("traceparent")
            .expect("traceparent must be present");
        let tp_str = tp.to_str().expect("traceparent must be valid ASCII");
        assert!(
            tp_str.contains("4bf92f3577b34da6a3ce929d0e0e4736"),
            "traceparent must contain the trace id: {tp_str}"
        );

        let extracted_cx = propagator.extract(&MetadataExtractor(&meta));
        let sc = extracted_cx.span().span_context();

        assert!(sc.is_valid(), "extracted span context must be valid");
        assert_eq!(sc.trace_id(), trace_id, "trace id must round-trip");
        assert_eq!(sc.span_id(), span_id, "span id must round-trip");

        // Re-inject and confirm same traceparent.
        let mut meta2 = MetadataMap::new();
        propagator.inject_context(&extracted_cx, &mut MetadataInjector(&mut meta2));
        let tp2 = meta2.get("traceparent").expect("traceparent in second map");
        assert_eq!(
            tp_str,
            tp2.to_str().unwrap(),
            "re-injected traceparent must match original"
        );
    }

    /// Empty metadata produces an invalid (root) span context — no panic.
    #[test]
    fn extract_empty_metadata_returns_invalid_context() {
        let propagator = TraceContextPropagator::new();
        let meta = MetadataMap::new();
        let cx = propagator.extract(&MetadataExtractor(&meta));
        let sc = cx.span().span_context();
        assert!(
            !sc.is_valid(),
            "empty metadata must produce an invalid span context"
        );
    }
}
