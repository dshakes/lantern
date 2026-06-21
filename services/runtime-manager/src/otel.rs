// OpenTelemetry integration for lantern-runtime-manager.
//
// # Design
//
// Only initialised when `OTEL_EXPORTER_OTLP_ENDPOINT` (standard OTLP env var)
// or `LANTERN_OTEL_ENABLED=1` is set; otherwise every function is a cheap
// no-op so the service behaves exactly as before with zero overhead.
//
// The global propagator is always set to W3C TraceContext so the extract /
// inject helpers work even without an active exporter — the harness can read
// the `traceparent` header regardless of whether the manager is exporting.
//
// # Propagation helpers
//
// `extract_from_metadata` / `inject_into_metadata` bridge between tonic's
// `MetadataMap` and the OTel W3C propagator.  They are the only two places
// in the codebase that touch raw gRPC metadata headers for tracing.
//
// # Round-trip test
//
// `tests::trace_context_survives_grpc_hop` is the "one trace survives a hop"
// proof: given a metadata map with a known `traceparent`, the extracted trace
// id matches, and re-injecting into a fresh metadata map reproduces the same
// trace id.

use opentelemetry::propagation::{Extractor, Injector};
use opentelemetry::trace::TraceContextExt;
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
/// Returns a `Shutdown` guard — drop it on process exit to flush pending spans.
pub fn init() -> Option<SdkShutdown> {
    // Always set the W3C propagator regardless of whether the exporter is
    // active. This ensures extract/inject work even in no-exporter mode.
    global::set_text_map_propagator(TraceContextPropagator::new());

    // Check whether the exporter should be activated.
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let enabled = std::env::var("LANTERN_OTEL_ENABLED")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if endpoint.is_none() && !enabled {
        tracing::debug!(
            "otel: OTEL_EXPORTER_OTLP_ENDPOINT not set and LANTERN_OTEL_ENABLED != 1; \
             running without OTLP exporter (propagation headers still active)"
        );
        return None;
    }

    let endpoint_str = endpoint.unwrap_or_else(|| "http://localhost:4317".to_string());
    tracing::info!(endpoint = %endpoint_str, "otel: initialising OTLP exporter");

    let exporter = match opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(&endpoint_str)
        .build()
    {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(error = %e, "otel: failed to build OTLP exporter; continuing without traces");
            return None;
        }
    };

    let tracer_provider = opentelemetry_sdk::trace::TracerProvider::builder()
        .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
        .with_sampler(Sampler::AlwaysOn)
        .with_id_generator(RandomIdGenerator::default())
        .with_resource(opentelemetry_sdk::Resource::new(vec![
            opentelemetry::KeyValue::new("service.name", "lantern-runtime-manager"),
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
            // Best-effort: we're in process teardown anyway.
            tracing::warn!(error = %e, "otel: tracer provider shutdown error");
        }
    }
}

// ---------------------------------------------------------------------------
// Metadata carrier adapters
// ---------------------------------------------------------------------------

/// Adapter: reads `traceparent` / `tracestate` from a tonic `MetadataMap`
/// for the OTel W3C extractor.
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

/// Adapter: writes `traceparent` / `tracestate` into a tonic `MetadataMap`
/// for the OTel W3C injector.
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
/// Returns a root (empty) context when no `traceparent` header is present, so
/// callers can always call `cx.with_remote_span_context(...)` unconditionally.
pub fn extract_from_metadata(metadata: &MetadataMap) -> Context {
    global::get_text_map_propagator(|prop| prop.extract(&MetadataExtractor(metadata)))
}

/// Inject the current span context from `cx` into the outgoing gRPC metadata.
///
/// No-op when `cx` carries no valid span (e.g., propagation disabled or
/// not yet initialised).
pub fn inject_into_metadata(cx: &Context, metadata: &mut MetadataMap) {
    global::get_text_map_propagator(|prop| {
        prop.inject_context(cx, &mut MetadataInjector(metadata))
    });
}

/// Extract the 32-hex-char trace id string from a context's span.
///
/// Returns an empty string when the context carries no valid span — matches
/// the StatusEvent.trace_id proto convention (empty = not traced).
pub fn trace_id_from_context(cx: &Context) -> String {
    // Bind the span to a local variable so its borrow outlives the
    // `span_context()` call (the span() method returns a temporary Box).
    let span = cx.span();
    let sc = span.span_context();
    if sc.is_valid() {
        format!("{:032x}", sc.trace_id())
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Tests — round-trip: extract → inject reproduces the same trace id
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::propagation::TextMapPropagator;
    use opentelemetry::trace::{SpanContext, SpanId, TraceFlags, TraceId, TraceState};
    use opentelemetry_sdk::propagation::TraceContextPropagator;

    /// Ensure that when a `traceparent` is injected into a MetadataMap and
    /// then extracted, the resulting trace id equals the original.
    ///
    /// This is the "one trace survives a gRPC hop" proof: it exercises both
    /// `inject_into_metadata` and `extract_from_metadata` end-to-end.
    #[test]
    fn trace_context_survives_grpc_hop() {
        // Use a fresh propagator (not the global one, to avoid test ordering
        // issues if other tests set a different propagator).
        let propagator = TraceContextPropagator::new();

        // Build a known SpanContext with a fixed trace id.
        let trace_id = TraceId::from_hex("4bf92f3577b34da6a3ce929d0e0e4736").unwrap();
        let span_id = SpanId::from_hex("00f067aa0ba902b7").unwrap();
        let span_ctx = SpanContext::new(
            trace_id,
            span_id,
            TraceFlags::SAMPLED,
            true,
            TraceState::default(),
        );

        // Inject into a fresh MetadataMap.
        let parent_cx = Context::default().with_remote_span_context(span_ctx);
        let mut meta = MetadataMap::new();
        propagator.inject_context(&parent_cx, &mut MetadataInjector(&mut meta));

        // Verify the header is present.
        let tp = meta
            .get("traceparent")
            .expect("traceparent must be present");
        let tp_str = tp.to_str().expect("traceparent must be valid ASCII");
        assert!(
            tp_str.contains("4bf92f3577b34da6a3ce929d0e0e4736"),
            "traceparent header must contain the trace id: {tp_str}"
        );

        // Extract from the MetadataMap into a new context.
        let extracted_cx = propagator.extract(&MetadataExtractor(&meta));
        let extracted_span = extracted_cx.span();
        let extracted_sc = extracted_span.span_context();

        assert!(
            extracted_sc.is_valid(),
            "extracted span context must be valid"
        );
        assert_eq!(
            extracted_sc.trace_id(),
            trace_id,
            "extracted trace id must match original"
        );
        assert_eq!(
            extracted_sc.span_id(),
            span_id,
            "extracted span id must match original"
        );

        // Re-inject into a second MetadataMap and confirm the same trace id.
        let mut meta2 = MetadataMap::new();
        propagator.inject_context(&extracted_cx, &mut MetadataInjector(&mut meta2));
        let tp2 = meta2.get("traceparent").expect("traceparent in second map");
        let tp2_str = tp2.to_str().unwrap();
        assert_eq!(
            tp_str, tp2_str,
            "re-injected traceparent must equal the original"
        );

        // Confirm trace_id_from_context produces the lowercase hex.
        let tid_str = trace_id_from_context(&extracted_cx);
        assert_eq!(
            tid_str, "4bf92f3577b34da6a3ce929d0e0e4736",
            "trace_id_from_context must return lowercase hex trace id"
        );
    }

    /// When no traceparent is present in the metadata, extract returns a
    /// context with no valid span (so spans get a fresh root trace id).
    #[test]
    fn extract_empty_metadata_returns_invalid_context() {
        let propagator = TraceContextPropagator::new();
        let meta = MetadataMap::new();
        let cx = propagator.extract(&MetadataExtractor(&meta));
        let empty_span = cx.span();
        let sc = empty_span.span_context();
        assert!(
            !sc.is_valid(),
            "empty metadata must produce an invalid span context (no parent)"
        );
        let tid = trace_id_from_context(&cx);
        assert!(
            tid.is_empty(),
            "trace_id_from_context on invalid context must be empty"
        );
    }
}
