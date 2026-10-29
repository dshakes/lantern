//! Prometheus SLI metrics + optional scrape listener (ADR 0041).
//!
//! * `lantern_manager_spawn_duration_seconds{kind,outcome}` - microVM boot
//!   latency, `kind` = `cold` | `restore` (snapshot), `outcome` = `ok` | `error`.
//! * `lantern_egress_broker_decisions_total{outcome}` - `allow`, `deny` (policy:
//!   the guest asked for something the allowlist refuses) or `error` (platform:
//!   DNS/upstream/credential-resolution failure). Only `error` burns the SLO.
//!
//! The listener is opt-in (`PAL_METRICS_ADDR`, legacy `LANTERN_METRICS_ADDR`).

use std::sync::LazyLock;
use std::time::Duration;

use prometheus::{
    Encoder, HistogramVec, IntCounterVec, TextEncoder, register_histogram_vec,
    register_int_counter_vec,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static SPAWN: LazyLock<HistogramVec> = LazyLock::new(|| {
    register_histogram_vec!(
        "lantern_manager_spawn_duration_seconds",
        "RuntimeManager.Spawn boot latency (the backend schedule/restore call).",
        &["kind", "outcome"],
        vec![0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0]
    )
    .expect("register spawn_duration")
});

static EGRESS: LazyLock<IntCounterVec> = LazyLock::new(|| {
    register_int_counter_vec!(
        "lantern_egress_broker_decisions_total",
        "Egress broker decisions by outcome (allow|deny|error).",
        &["outcome"]
    )
    .expect("register egress_decisions")
});

pub fn observe_spawn(from_snapshot: bool, ok: bool, elapsed: Duration) {
    SPAWN
        .with_label_values(&[
            if from_snapshot { "restore" } else { "cold" },
            if ok { "ok" } else { "error" },
        ])
        .observe(elapsed.as_secs_f64());
}

/// Deny reasons that are platform faults, not guest policy violations.
const ERROR_REASONS: &[&str] = &[
    "upstream connect failed",
    "DNS resolution failed",
    "DNS resolution timed out",
    "credential resolution failed",
];

/// `reason` is `None` for an allow.
pub fn egress_decision(reason: Option<&str>) {
    let outcome = match reason {
        None => "allow",
        Some(r) if ERROR_REASONS.contains(&r) => "error",
        Some(_) => "deny",
    };
    EGRESS.with_label_values(&[outcome]).inc();
}

fn render() -> Vec<u8> {
    let mut buf = Vec::new();
    // ponytail: encode only fails on a malformed registry; serve empty then.
    let _ = TextEncoder::new().encode(&prometheus::gather(), &mut buf);
    buf
}

/// Serve `GET /metrics` on `PAL_METRICS_ADDR` (fallback `LANTERN_METRICS_ADDR`).
/// No-op when unset. Hand-rolled HTTP/1.0: one scrape = one short connection.
pub async fn serve_from_env() {
    let Some(addr) = std::env::var("PAL_METRICS_ADDR")
        .or_else(|_| std::env::var("LANTERN_METRICS_ADDR"))
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

    #[test]
    fn records_and_renders() {
        observe_spawn(true, true, Duration::from_millis(120));
        observe_spawn(false, false, Duration::from_secs(2));
        egress_decision(None);
        egress_decision(Some("port not in allowlist"));
        egress_decision(Some("upstream connect failed"));
        let out = String::from_utf8(render()).unwrap();
        assert!(out.contains(
            r#"lantern_manager_spawn_duration_seconds_count{kind="restore",outcome="ok"} "#
        ));
        assert!(out.contains(
            r#"lantern_manager_spawn_duration_seconds_count{kind="cold",outcome="error"} "#
        ));
        // The SLO rules select these exact bucket labels (le="5" cold, le="2" restore).
        for le in ["2", "5"] {
            assert!(out.contains(&format!(
                r#"lantern_manager_spawn_duration_seconds_bucket{{kind="restore",outcome="ok",le="{le}"}}"#
            )));
        }
        for o in ["allow", "deny", "error"] {
            assert!(out.contains(&format!(
                r#"lantern_egress_broker_decisions_total{{outcome="{o}"}} "#
            )));
        }
    }
}
