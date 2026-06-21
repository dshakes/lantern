// OTel pass-through: reads pre-serialized OTLP span batches from a unix
// socket (`/run/lantern/otlp.sock`) and forwards them via the Report
// stream. The workload's tracing setup writes OTLP/protobuf bytes here.
//
// Wire protocol: length-prefixed (u32 big-endian) OTLP batches. One batch
// per connection or many — both are supported.
//
// This module also provides W3C trace-context propagation helpers used by
// `manager_client.rs` to inject the spawn-time `traceparent` into every
// outgoing gRPC call to the manager, so the harness's activity appears as
// a child of the scheduler's `RuntimeScheduler.Schedule` span.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use tokio::io::AsyncReadExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::time::Instant;

use crate::manager_client::ManagerClient;
use crate::proto::HarnessReport;

const BATCH_INTERVAL: Duration = Duration::from_secs(2);
const MAX_BATCH_BYTES: usize = 1024 * 1024;

pub async fn run(manager: ManagerClient) -> Result<()> {
    let path: PathBuf = std::env::var("LANTERN_OTLP_SOCKET")
        .unwrap_or_else(|_| "/run/lantern/otlp.sock".to_string())
        .into();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let _ = tokio::fs::remove_file(&path).await;
    let listener = UnixListener::bind(&path)?;
    tracing::info!(?path, "otel: OTLP socket listening");

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, "otel: accept failed");
                continue;
            }
        };
        let m = manager.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(m, stream).await {
                tracing::debug!(error = %e, "otel: conn ended");
            }
        });
    }
}

async fn handle_conn(manager: ManagerClient, mut stream: UnixStream) -> Result<()> {
    let mut pending: Vec<u8> = Vec::new();
    let mut last_flush = Instant::now();

    loop {
        let mut len_buf = [0u8; 4];
        match stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                if !pending.is_empty() {
                    flush(&manager, &mut pending).await;
                }
                return Ok(());
            }
            Err(e) => return Err(e.into()),
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        if len > MAX_BATCH_BYTES {
            return Err(anyhow::anyhow!("otlp batch too large: {len}"));
        }
        let mut buf = vec![0u8; len];
        stream.read_exact(&mut buf).await?;
        pending.extend_from_slice(&buf);

        if pending.len() >= MAX_BATCH_BYTES / 2 || last_flush.elapsed() >= BATCH_INTERVAL {
            flush(&manager, &mut pending).await;
            last_flush = Instant::now();
        }
    }
}

async fn flush(manager: &ManagerClient, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let bytes = std::mem::take(pending);
    manager
        .enqueue_report(HarnessReport::OtlpTraces { bytes })
        .await;
}

// ---------------------------------------------------------------------------
// W3C trace-context propagation
// ---------------------------------------------------------------------------
//
// The manager injects `LANTERN_TRACE_PARENT` into the VM's environment at
// spawn time.  `init_propagator` must be called once at startup (before any
// gRPC calls to the manager); it sets the global W3C propagator and returns
// the root `Context` parsed from that env var.  Subsequent calls to
// `inject_into_metadata` stamp every outgoing gRPC request with the same
// `traceparent`, making every harness call a child of the manager's spawn span.

use opentelemetry::propagation::{Extractor, Injector};
use opentelemetry::trace::TraceContextExt as _;
use opentelemetry::{global, Context};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use tonic::metadata::MetadataMap;

/// Single-key carrier that presents `LANTERN_TRACE_PARENT` as the W3C
/// `traceparent` key so the propagator can extract from it.
struct EnvCarrier(String);

impl Extractor for EnvCarrier {
    fn get(&self, key: &str) -> Option<&str> {
        if key.eq_ignore_ascii_case("traceparent") {
            Some(&self.0)
        } else {
            None
        }
    }

    fn keys(&self) -> Vec<&str> {
        vec!["traceparent"]
    }
}

/// Adapter: writes W3C headers into a tonic `MetadataMap`.
struct MetadataInjector<'a>(&'a mut MetadataMap);

impl Injector for MetadataInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        if let Ok(k) = tonic::metadata::MetadataKey::from_bytes(key.as_bytes())
            && let Ok(v) = tonic::metadata::MetadataValue::try_from(value.as_str())
        {
            self.0.insert(k, v);
        }
    }
}

/// Initialise the W3C propagator globally and parse `LANTERN_TRACE_PARENT`
/// into a root `Context`.
///
/// Call once, early in `main()`, before any outgoing gRPC calls.  Returns
/// the parent context the harness should use for all its spans.  When the
/// env var is absent or malformed the returned context carries no span
/// (harness starts a fresh root trace — graceful degradation).
pub fn init_propagator() -> Context {
    global::set_text_map_propagator(TraceContextPropagator::new());

    let traceparent = std::env::var("LANTERN_TRACE_PARENT")
        .ok()
        .filter(|s| !s.trim().is_empty());

    match traceparent {
        Some(tp) => {
            let cx = global::get_text_map_propagator(|prop| prop.extract(&EnvCarrier(tp.clone())));
            let span = cx.span();
            let sc = span.span_context();
            if sc.is_valid() {
                tracing::debug!(
                    trace_id = %format!("{:032x}", sc.trace_id()),
                    "otel: joined distributed trace from LANTERN_TRACE_PARENT"
                );
            } else {
                tracing::debug!("otel: LANTERN_TRACE_PARENT present but malformed; starting fresh trace");
            }
            cx
        }
        None => {
            tracing::debug!("otel: LANTERN_TRACE_PARENT not set; starting fresh trace");
            Context::default()
        }
    }
}

/// Inject the W3C `traceparent` (from `cx`) into outgoing gRPC metadata.
///
/// No-op when `cx` carries no valid span.
pub fn inject_into_metadata(cx: &Context, metadata: &mut MetadataMap) {
    global::get_text_map_propagator(|prop| {
        prop.inject_context(cx, &mut MetadataInjector(metadata))
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::propagation::TextMapPropagator;
    use opentelemetry::trace::{SpanContext, SpanId, TraceFlags, TraceId, TraceState};

    /// Round-trip: a known traceparent in the env carrier extracts to the
    /// correct trace id, and re-injecting into a MetadataMap reproduces it.
    /// This is the "one trace survives a hop" proof for the harness side.
    #[test]
    fn trace_context_survives_env_to_grpc_hop() {
        let propagator = TraceContextPropagator::new();

        let trace_id = TraceId::from_hex("4bf92f3577b34da6a3ce929d0e0e4736").unwrap();
        let span_id = SpanId::from_hex("00f067aa0ba902b7").unwrap();
        let tp_value =
            format!("00-{:032x}-{:016x}-01", trace_id, span_id);

        // Extract from the env-style carrier.
        let cx = propagator.extract(&EnvCarrier(tp_value.clone()));
        let extracted_span = cx.span();
        let sc = extracted_span.span_context();

        assert!(sc.is_valid(), "span context must be valid after extraction");
        assert_eq!(sc.trace_id(), trace_id, "trace id must match");
        assert_eq!(sc.span_id(), span_id, "span id must match");

        // Inject into gRPC metadata.
        let mut meta = MetadataMap::new();
        propagator.inject_context(&cx, &mut MetadataInjector(&mut meta));

        let tp_header = meta
            .get("traceparent")
            .expect("traceparent must be in metadata");
        let tp_str = tp_header.to_str().unwrap();
        assert!(
            tp_str.contains("4bf92f3577b34da6a3ce929d0e0e4736"),
            "injected metadata must contain the trace id: {tp_str}"
        );
        assert_eq!(
            tp_str, tp_value,
            "round-tripped traceparent must equal the original"
        );
    }

    /// A SpanContext constructed directly round-trips through inject/extract.
    #[test]
    fn span_context_round_trips_through_metadata() {
        let propagator = TraceContextPropagator::new();

        let trace_id = TraceId::from_hex("a3ce929d0e0e47364bf92f3577b34da6").unwrap();
        let span_id = SpanId::from_hex("a902b700f067aa0b").unwrap();
        let sc = SpanContext::new(
            trace_id,
            span_id,
            TraceFlags::SAMPLED,
            true,
            TraceState::default(),
        );

        let parent_cx = Context::default().with_remote_span_context(sc);
        let mut meta = MetadataMap::new();
        propagator.inject_context(&parent_cx, &mut MetadataInjector(&mut meta));

        // Re-extract from the metadata map using the Extractor adapter.
        struct MetaExtractor<'a>(&'a MetadataMap);
        impl Extractor for MetaExtractor<'_> {
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

        let extracted = propagator.extract(&MetaExtractor(&meta));
        let extracted_span = extracted.span();
        let extracted_sc = extracted_span.span_context();

        assert!(extracted_sc.is_valid());
        assert_eq!(extracted_sc.trace_id(), trace_id);
        assert_eq!(extracted_sc.span_id(), span_id);
    }
}
