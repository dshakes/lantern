use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use futures_core::Stream;
use tonic::Streaming;

use crate::grpc::StreamEvent;

/// Converts a gRPC server-streaming response of StreamEvents into an Axum SSE
/// response with heartbeat keep-alive and backpressure support.
pub fn grpc_stream_to_sse(
    stream: Streaming<StreamEvent>,
    from_seq: u64,
) -> impl IntoResponse {
    let event_stream = GrpcSseStream::new(stream, from_seq);

    Sse::new(event_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("heartbeat"),
    )
}

struct GrpcSseStream {
    inner: Streaming<StreamEvent>,
    from_seq: u64,
    done: bool,
}

impl GrpcSseStream {
    fn new(inner: Streaming<StreamEvent>, from_seq: u64) -> Self {
        Self {
            inner,
            from_seq,
            done: false,
        }
    }
}

impl Stream for GrpcSseStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.done {
            return Poll::Ready(None);
        }

        let inner = Pin::new(&mut self.inner);
        match inner.poll_next(cx) {
            Poll::Ready(Some(Ok(event))) => {
                if event.seq < self.from_seq {
                    cx.waker().wake_by_ref();
                    return Poll::Pending;
                }

                let is_end = event.payload.as_ref().is_some_and(|p| {
                    matches!(p, crate::grpc::StreamEventPayload::End(_))
                });

                let seq = event.seq;
                let data = serde_json::to_string(&event)
                    .unwrap_or_else(|_| r#"{"error":"serialization_failed"}"#.to_string());

                let sse_event = Event::default()
                    .event("stream_event")
                    .data(data)
                    .id(seq.to_string())
                    .retry(Duration::from_millis(1500));

                if is_end {
                    self.done = true;
                }

                Poll::Ready(Some(Ok(sse_event)))
            }
            Poll::Ready(Some(Err(status))) => {
                tracing::warn!(code = ?status.code(), message = %status.message(), "grpc stream error");
                self.done = true;

                let error_data = serde_json::json!({
                    "error": status.message(),
                    "code": format!("{:?}", status.code()),
                });
                let sse_event = Event::default()
                    .event("error")
                    .data(error_data.to_string());

                Poll::Ready(Some(Ok(sse_event)))
            }
            Poll::Ready(None) => {
                self.done = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
