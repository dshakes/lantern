//! Prometheus SLI metrics + optional scrape listener (ADR 0041).
//!
//! `lantern_model_router_requests_total{method,outcome}` is the error-rate SLI:
//! outcome `ok`, `error` (server-side: the router could not serve it), or
//! `client` (caller's fault; excluded from the SLO). The duration histogram
//! feeds the latency SLI. The listener is opt-in (`PAL_METRICS_ADDR`)
//! and unset means no port is opened.

use std::future::Future;
use std::sync::LazyLock;
use std::time::Instant;

use prometheus::{
    Encoder, HistogramVec, IntCounterVec, TextEncoder, register_histogram_vec,
    register_int_counter_vec,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tonic::Code;

static REQUESTS: LazyLock<IntCounterVec> = LazyLock::new(|| {
    register_int_counter_vec!(
        "lantern_model_router_requests_total",
        "ModelService RPCs by method and outcome (ok|error|client).",
        &["method", "outcome"]
    )
    .expect("register requests_total")
});

static DURATION: LazyLock<HistogramVec> = LazyLock::new(|| {
    register_histogram_vec!(
        "lantern_model_router_request_duration_seconds",
        "ModelService RPC latency (to first response for streaming RPCs).",
        &["method"],
        vec![0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0]
    )
    .expect("register request_duration")
});

/// Server-side failures count against the SLO; caller errors do not.
fn outcome(code: Code) -> &'static str {
    match code {
        Code::Ok => "ok",
        Code::Internal
        | Code::Unavailable
        | Code::DeadlineExceeded
        | Code::Unknown
        | Code::ResourceExhausted
        | Code::DataLoss => "error",
        _ => "client",
    }
}

/// Run `fut`, recording its outcome and latency under `method`.
pub async fn timed<T>(
    method: &'static str,
    fut: impl Future<Output = Result<T, tonic::Status>>,
) -> Result<T, tonic::Status> {
    let start = Instant::now();
    let res = fut.await;
    let code = res.as_ref().map_or_else(tonic::Status::code, |_| Code::Ok);
    REQUESTS.with_label_values(&[method, outcome(code)]).inc();
    DURATION
        .with_label_values(&[method])
        .observe(start.elapsed().as_secs_f64());
    res
}

fn render() -> Vec<u8> {
    let mut buf = Vec::new();
    // ponytail: encode only fails on a malformed registry; serve empty then.
    let _ = TextEncoder::new().encode(&prometheus::gather(), &mut buf);
    buf
}

/// Serve `GET /metrics` on `PAL_METRICS_ADDR`.
/// No-op when unset. Hand-rolled HTTP/1.0: one scrape = one short connection.
pub async fn serve_from_env() {
    let Some(addr) = std::env::var("PAL_METRICS_ADDR")
        .ok()
        .filter(|a| !a.trim().is_empty())
    else {
        return;
    };
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!(%addr, error = %e, "metrics listener failed to bind; /metrics disabled");
            return;
        }
    };
    tracing::info!(%addr, "metrics listener started");
    tokio::spawn(async move {
        loop {
            let Ok((mut conn, _)) = listener.accept().await else {
                continue;
            };
            tokio::spawn(async move {
                let mut req = [0u8; 512];
                let n =
                    tokio::time::timeout(std::time::Duration::from_secs(5), conn.read(&mut req))
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or(0);
                let is_metrics = req[..n].starts_with(b"GET /metrics");
                let (status, body) = if is_metrics {
                    ("200 OK", render())
                } else {
                    ("404 Not Found", Vec::new())
                };
                let head = format!(
                    "HTTP/1.0 {status}\r\nContent-Type: text/plain; version=0.0.4\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = conn.write_all(head.as_bytes()).await;
                let _ = conn.write_all(&body).await;
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn timed_classifies_outcomes_and_renders() {
        let _ = timed("t", async { Ok::<_, tonic::Status>(1) }).await;
        let _ = timed("t", async { Err::<(), _>(tonic::Status::unavailable("x")) }).await;
        let _ = timed("t", async {
            Err::<(), _>(tonic::Status::invalid_argument("x"))
        })
        .await;
        let out = String::from_utf8(render()).unwrap();
        assert!(out.contains(r#"lantern_model_router_requests_total{method="t",outcome="ok"} 1"#));
        assert!(
            out.contains(r#"lantern_model_router_requests_total{method="t",outcome="error"} 1"#)
        );
        assert!(
            out.contains(r#"lantern_model_router_requests_total{method="t",outcome="client"} 1"#)
        );
        assert!(out.contains("lantern_model_router_request_duration_seconds_bucket"));
    }
}
