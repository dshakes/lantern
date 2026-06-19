// Thin abstraction over the gRPC client to runtime-manager.
//
// Every subsystem calls `client.enqueue_report(...)` / `client.vend_secret(...)`
// without caring about transport details.
//
// Transport
// ---------
// `vend_secret` calls the real `RuntimeHarness.VendSecret` unary RPC over the
// tonic channel to the manager. This is the H1 GA fix: the stub is gone from
// the default path. `LANTERN_ALLOW_SECRET_STUB=1` re-enables the old fake
// value **only** for dev environments that have no manager running.
//
// Authentication assumption
// -------------------------
// The harness sends its `vm_id` (injected at spawn by the manager) in every
// `VendSecretRequest`. The manager resolves that vm_id against its own registry
// — populated at spawn time — to bind the request to the correct
// tenant_id / run_id / declared-secrets allowlist. The harness never asserts
// tenant or run identity. mTLS (per-VM client cert, CN = vm_id) is the planned
// transport-layer binding; for now the TCP connection from inside the VM
// (vsock or host-network) is the boundary. See ADR note in service.rs.

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::Mutex;
use tokio::sync::mpsc;

use crate::proto::{
    self, HarnessReport, HeartbeatAck, HeartbeatRequest, VendSecretRequest, VendSecretResponse, pb,
};

/// Connection state for the manager. The harness MUST tolerate the manager
/// being unreachable — the workload always runs even if no heartbeats land.
#[derive(Clone)]
pub struct ManagerClient {
    pub manager_addr: String,
    pub vm_id: String,
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    /// Outbound report fan-in. The Report stream task drains this.
    report_tx: Option<mpsc::Sender<HarnessReport>>,
    /// Last successful contact (unix ms). 0 means never. Surfaced over
    /// `/healthz` once that endpoint lands.
    #[allow(dead_code)]
    last_contact_ms: i64,
    /// Whether the manager has been reachable at least once in this process.
    #[allow(dead_code)]
    has_ever_connected: bool,
}

impl ManagerClient {
    pub fn new(manager_addr: String, vm_id: String) -> Self {
        Self {
            manager_addr,
            vm_id,
            inner: Arc::new(Mutex::new(Inner {
                report_tx: None,
                last_contact_ms: 0,
                has_ever_connected: false,
            })),
        }
    }

    /// Register the channel used by the Report stream so subsystems can fan
    /// reports in. Called once by [`crate::logs`] / [`crate::otel`] startup.
    pub async fn set_report_channel(&self, tx: mpsc::Sender<HarnessReport>) {
        let mut g = self.inner.lock().await;
        g.report_tx = Some(tx);
    }

    pub async fn enqueue_report(&self, r: HarnessReport) {
        let tx = {
            let g = self.inner.lock().await;
            g.report_tx.clone()
        };
        if let Some(tx) = tx {
            // Best-effort: if the buffer is full we drop. Reports are
            // observability, never load-bearing for workload progress.
            let _ = tx.try_send(r);
        }
    }

    pub async fn note_contact(&self) {
        let mut g = self.inner.lock().await;
        g.last_contact_ms = proto::now_unix_ms();
        g.has_ever_connected = true;
    }

    /// Open the real bidirectional `RuntimeHarness.Heartbeat` gRPC stream.
    ///
    /// Returns `(tx, rx)` where:
    ///   - `tx` accepts `HeartbeatRequest` values from `heartbeat.rs` (the
    ///     sender loop) and forwards them to the manager over the wire.
    ///   - `rx` delivers `HeartbeatAck` values received from the manager
    ///     (may carry egress overrides, drain/snapshot signals, etc.).
    ///
    /// Uses the same mTLS channel setup as `vend_secret`. Falls back to
    /// plaintext when the TLS env vars are absent (dev mode).
    ///
    /// Returns `Err` when the manager is unreachable so the caller's
    /// exponential-backoff reconnect loop in `heartbeat.rs` can retry without
    /// stopping the workload.
    pub async fn open_heartbeat_stream(
        &self,
    ) -> Result<(mpsc::Sender<HeartbeatRequest>, mpsc::Receiver<HeartbeatAck>)> {
        let tls_config = crate::tls::build_client_tls_config()
            .with_context(|| "heartbeat: failed to build TLS client config")?;

        let scheme = if tls_config.is_some() {
            "https"
        } else {
            "http"
        };
        let endpoint_url = format!("{scheme}://{}", self.manager_addr);
        let endpoint = tonic::transport::Endpoint::from_shared(endpoint_url.clone())
            .with_context(|| format!("heartbeat: invalid endpoint URL {endpoint_url}"))?;

        let endpoint = if let Some(tls) = tls_config {
            endpoint
                .tls_config(tls)
                .with_context(|| "heartbeat: failed to apply TLS config to endpoint")?
        } else {
            endpoint
        };

        let mut client = pb::runtime_harness_client::RuntimeHarnessClient::connect(endpoint)
            .await
            .with_context(|| {
                format!(
                    "heartbeat: could not connect to manager at {}",
                    self.manager_addr
                )
            })?;

        // Outbound channel: heartbeat.rs pushes HeartbeatRequest here; we
        // forward each one (converted to pb) into the tonic stream.
        let (req_tx, mut req_rx) = mpsc::channel::<HeartbeatRequest>(8);
        // Inbound channel: tonic acks are converted and delivered here.
        let (ack_tx, ack_rx) = mpsc::channel::<HeartbeatAck>(8);

        // Bridge the internal req_rx into a tonic ReceiverStream.
        // We use a separate mpsc to avoid holding req_rx across the await.
        let (wire_tx, wire_rx) = mpsc::channel::<pb::HeartbeatRequest>(8);
        let manager_addr = self.manager_addr.clone();
        let vm_id = self.vm_id.clone();

        // Converter task: internal HeartbeatRequest → pb wire type.
        tokio::spawn(async move {
            while let Some(req) = req_rx.recv().await {
                let wire = pb::HeartbeatRequest::from(req);
                if wire_tx.send(wire).await.is_err() {
                    // tonic stream task exited; stop converting.
                    break;
                }
            }
        });

        // tonic stream task: open the bidi RPC and relay acks back.
        let contact = self.clone();
        tokio::spawn(async move {
            let req_stream = tokio_stream::wrappers::ReceiverStream::new(wire_rx);
            let mut ack_stream = match client.heartbeat(req_stream).await {
                Ok(resp) => resp.into_inner(),
                Err(e) => {
                    tracing::warn!(
                        vm_id = %vm_id,
                        manager_addr = %manager_addr,
                        error = %e,
                        "heartbeat: RPC call failed after connect"
                    );
                    return;
                }
            };

            tracing::info!(
                vm_id = %vm_id,
                manager_addr = %manager_addr,
                "heartbeat: bidi stream established"
            );

            loop {
                match ack_stream.message().await {
                    Ok(Some(wire_ack)) => {
                        // Refresh liveness on every ack so /healthz (when it
                        // lands) reflects ongoing contact, not just stream-open.
                        contact.note_contact().await;
                        let ack = HeartbeatAck::from(wire_ack);
                        if ack_tx.send(ack).await.is_err() {
                            // heartbeat.rs ack reader exited; close cleanly.
                            break;
                        }
                    }
                    Ok(None) => {
                        tracing::debug!(
                            vm_id = %vm_id,
                            "heartbeat: manager closed ack stream (VM draining?)"
                        );
                        break;
                    }
                    Err(e) => {
                        tracing::warn!(
                            vm_id = %vm_id,
                            error = %e,
                            "heartbeat: ack stream error; reconnect will be triggered"
                        );
                        break;
                    }
                }
            }
        });

        Ok((req_tx, ack_rx))
    }

    /// Build the clearly-marked stub response used when
    /// `LANTERN_ALLOW_SECRET_STUB=1`. Extracted so tests can verify the
    /// format without needing to mutate global env.
    fn stub_response(vm_id: &str, secret_uri: &str) -> VendSecretResponse {
        VendSecretResponse {
            value: format!("LANTERN_STUB_NOT_A_REAL_SECRET::{vm_id}::{secret_uri}"),
            expires_at_unix_ms: proto::now_unix_ms() + 60_000,
        }
    }

    /// Unary VendSecret RPC — calls the real manager gRPC endpoint.
    ///
    /// The manager authenticates this call by looking up `vm_id` in its own
    /// registry (populated at spawn). It enforces the declared-secrets
    /// allowlist and returns a value with TTL ≤ 300 s.
    ///
    /// Dev escape: set `LANTERN_ALLOW_SECRET_STUB=1` to skip the RPC and
    /// return a clearly-marked stub value. This is intended for local
    /// development where no manager process is running.
    pub async fn vend_secret(&self, req: VendSecretRequest) -> Result<VendSecretResponse> {
        // Dev stub escape-hatch — explicit opt-in only.
        if std::env::var("LANTERN_ALLOW_SECRET_STUB")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
        {
            tracing::warn!(
                vm_id = %self.vm_id,
                secret_uri = %req.secret_uri,
                "vend_secret: STUB mode (LANTERN_ALLOW_SECRET_STUB=1) — \
                 returning a fake value. Dev/test use only."
            );
            return Ok(Self::stub_response(&self.vm_id, &req.secret_uri));
        }

        // Real path: call the manager's RuntimeHarness.VendSecret RPC.
        //
        // mTLS: when LANTERN_VM_TLS_CERT / LANTERN_VM_TLS_KEY /
        // LANTERN_MANAGER_TLS_CA are present (injected by the manager at
        // spawn), use a TLS channel so the manager can verify this VM's
        // identity via its client cert.  Falls back to plaintext in dev.
        let tls_config = crate::tls::build_client_tls_config()
            .with_context(|| "vend_secret: failed to build TLS client config".to_string())?;

        let scheme = if tls_config.is_some() {
            "https"
        } else {
            "http"
        };
        let endpoint_url = format!("{scheme}://{}", self.manager_addr);
        let endpoint = tonic::transport::Endpoint::from_shared(endpoint_url.clone())
            .with_context(|| format!("vend_secret: invalid endpoint URL {endpoint_url}"))?;

        let endpoint = if let Some(tls) = tls_config {
            endpoint.tls_config(tls).with_context(|| {
                "vend_secret: failed to apply TLS config to endpoint".to_string()
            })?
        } else {
            endpoint
        };

        let mut client = pb::runtime_harness_client::RuntimeHarnessClient::connect(endpoint)
            .await
            .with_context(|| {
                format!(
                    "vend_secret: could not connect to manager at {}",
                    self.manager_addr
                )
            })?;

        let ttl_proto = if req.ttl_secs > 0 {
            Some(prost_types::Duration {
                seconds: req.ttl_secs,
                nanos: 0,
            })
        } else {
            None
        };

        let wire_req = pb::VendSecretRequest {
            vm_id: req.vm_id,
            secret_uri: req.secret_uri.clone(),
            ttl: ttl_proto,
        };

        let wire_resp = client
            .vend_secret(wire_req)
            .await
            .with_context(|| format!("vend_secret RPC failed for secret_uri '{}'", req.secret_uri))?
            .into_inner();

        // Convert the proto Timestamp to unix-ms for the internal cache.
        let expires_at_unix_ms = wire_resp
            .expires_at
            .as_ref()
            .map(|ts| ts.seconds * 1_000 + i64::from(ts.nanos) / 1_000_000)
            .unwrap_or_else(|| proto::now_unix_ms() + 300_000);

        self.note_contact().await;

        Ok(VendSecretResponse {
            value: wire_resp.value,
            expires_at_unix_ms,
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// When LANTERN_ALLOW_SECRET_STUB is not set, vend_secret must fail if
    /// the manager is unreachable rather than returning any value.
    #[tokio::test]
    async fn vend_secret_fails_when_manager_unreachable_without_stub() {
        // Guard: do not accidentally pass when the env var is already set in
        // the test environment.
        if std::env::var("LANTERN_ALLOW_SECRET_STUB").is_ok() {
            return; // skip — env already enables stub; different code path
        }

        let client = ManagerClient::new(
            // Port 1 is reserved and will be refused immediately.
            "127.0.0.1:1".to_string(),
            "test-vm".to_string(),
        );
        let result = client
            .vend_secret(VendSecretRequest {
                vm_id: "test-vm".to_string(),
                secret_uri: "lantern.secret://tenant/t1/key/K".to_string(),
                ttl_secs: 60,
            })
            .await;
        assert!(
            result.is_err(),
            "expected error when manager unreachable without stub, got Ok"
        );
    }

    /// `stub_response` produces a clearly-marked value — no env mutation needed.
    #[test]
    fn stub_response_format_is_marked() {
        let resp = ManagerClient::stub_response("vm-abc", "lantern.secret://t1/key/K");
        assert!(
            resp.value.starts_with("LANTERN_STUB_NOT_A_REAL_SECRET::"),
            "stub value must carry the STUB prefix, got: {}",
            resp.value
        );
        assert!(
            resp.value.contains("vm-abc"),
            "stub value must embed the vm_id"
        );
        assert!(
            resp.value.contains("lantern.secret://t1/key/K"),
            "stub value must embed the secret_uri"
        );
        assert!(
            resp.expires_at_unix_ms > proto::now_unix_ms(),
            "stub expiry must be in the future"
        );
    }

    /// When the manager is unreachable, `open_heartbeat_stream` must return
    /// `Err` so the backoff reconnect loop in `heartbeat.rs` can retry without
    /// stopping the workload.
    #[tokio::test]
    async fn heartbeat_stream_fails_when_manager_unreachable() {
        let client = ManagerClient::new(
            // Port 1 is reserved and will be refused immediately.
            "127.0.0.1:1".to_string(),
            "test-vm-hb".to_string(),
        );
        let result = client.open_heartbeat_stream().await;
        assert!(
            result.is_err(),
            "expected Err when manager is unreachable, got Ok"
        );
    }
}

// ---------------------------------------------------------------------------
// Proto conversion tests (pure, no I/O)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod proto_conversion_tests {
    use crate::proto::{self, HeartbeatAck, HeartbeatRequest, ResourceUsage, pb};

    /// HeartbeatRequest → pb::HeartbeatRequest round-trip: all fields preserved.
    #[test]
    fn heartbeat_request_converts_to_wire() {
        let at_ms: i64 = 1_700_000_000_123; // arbitrary unix-ms
        let req = HeartbeatRequest {
            vm_id: "vm-conv-test".to_string(),
            at_unix_ms: at_ms,
            usage: ResourceUsage {
                vcpu_ms_used: 42,
                memory_bytes: 128 * 1024 * 1024,
                network_bytes_in: 1000,
                network_bytes_out: 2000,
                disk_bytes: 4096,
                cost_usd_accumulated: 0.001,
            },
            worker_pid: 12345,
            restart_count: 2,
        };

        let wire = pb::HeartbeatRequest::from(req);

        assert_eq!(wire.vm_id, "vm-conv-test");
        assert_eq!(wire.worker_pid, 12345);
        assert_eq!(wire.restart_count, 2);

        let ts = wire.at.expect("Timestamp must be set");
        // Timestamp seconds = at_ms / 1000
        assert_eq!(ts.seconds, at_ms / 1_000);
        // Timestamp nanos = (at_ms % 1000) * 1_000_000
        assert_eq!(ts.nanos, ((at_ms % 1_000) * 1_000_000) as i32);

        let usage = wire.usage.expect("ResourceUsage must be set");
        assert_eq!(usage.vcpu_ms_used, 42);
        assert_eq!(usage.memory_bytes, 128 * 1024 * 1024);
        assert_eq!(usage.network_bytes_in, 1000);
        assert_eq!(usage.network_bytes_out, 2000);
        assert_eq!(usage.disk_bytes, 4096);
        assert!((usage.cost_usd_accumulated - 0.001).abs() < f64::EPSILON);
    }

    /// HeartbeatRequest with at_unix_ms=0 must produce a zero Timestamp, not
    /// a negative nanos value (the ms % 1000 branch on zero is fine).
    #[test]
    fn heartbeat_request_zero_timestamp() {
        let req = HeartbeatRequest {
            at_unix_ms: 0,
            ..Default::default()
        };
        let wire = pb::HeartbeatRequest::from(req);
        let ts = wire.at.expect("Timestamp must be set");
        assert_eq!(ts.seconds, 0);
        assert_eq!(ts.nanos, 0);
    }

    /// pb::HeartbeatAck → HeartbeatAck: drain/snapshot flags + egress rules.
    #[test]
    fn heartbeat_ack_converts_from_wire_drain_snapshot() {
        let wire = pb::HeartbeatAck {
            egress_overrides: vec![],
            limits_override: None,
            drain: true,
            snapshot: true,
        };
        let ack = HeartbeatAck::from(wire);
        assert!(ack.drain, "drain must be true");
        assert!(ack.snapshot, "snapshot must be true");
        assert!(ack.egress_overrides.is_empty());
        assert!(ack.limits_override.is_none());
    }

    /// pb::HeartbeatAck with egress overrides: patterns and methods preserved.
    #[test]
    fn heartbeat_ack_converts_egress_overrides() {
        let wire = pb::HeartbeatAck {
            egress_overrides: vec![
                pb::EgressRule {
                    pattern: "*.openai.com".to_string(),
                    http_methods: vec!["POST".to_string()],
                    rate_bps: 1_000_000,
                },
                pb::EgressRule {
                    pattern: "10.0.0.0/8".to_string(),
                    http_methods: vec![],
                    rate_bps: 0,
                },
            ],
            limits_override: None,
            drain: false,
            snapshot: false,
        };
        let ack = HeartbeatAck::from(wire);
        assert_eq!(ack.egress_overrides.len(), 2);
        assert_eq!(ack.egress_overrides[0].pattern, "*.openai.com");
        assert_eq!(ack.egress_overrides[0].http_methods, vec!["POST"]);
        assert_eq!(ack.egress_overrides[0].rate_bps, 1_000_000);
        assert_eq!(ack.egress_overrides[1].pattern, "10.0.0.0/8");
        assert!(ack.egress_overrides[1].http_methods.is_empty());
    }

    /// pb::HeartbeatAck with a limits_override: all ResourceLimits fields
    /// are preserved, including the timeout_secs conversion.
    #[test]
    fn heartbeat_ack_converts_limits_override() {
        let wire = pb::HeartbeatAck {
            egress_overrides: vec![],
            limits_override: Some(pb::ResourceLimits {
                vcpu: "2000m".to_string(),
                memory: "1Gi".to_string(),
                gpu: "".to_string(),
                timeout: Some(prost_types::Duration {
                    seconds: 300,
                    nanos: 0,
                }),
                max_steps: 100,
                max_tokens: 4096,
                max_cost_usd: 0.50,
                scratch_size: "512Mi".to_string(),
            }),
            drain: false,
            snapshot: false,
        };
        let ack = HeartbeatAck::from(wire);
        let limits = ack.limits_override.expect("limits_override must be Some");
        assert_eq!(limits.vcpu, "2000m");
        assert_eq!(limits.memory, "1Gi");
        assert_eq!(limits.timeout_secs, 300);
        assert_eq!(limits.max_steps, 100);
        assert_eq!(limits.max_tokens, 4096);
        assert!((limits.max_cost_usd - 0.50).abs() < f64::EPSILON);
        assert_eq!(limits.scratch_size, "512Mi");
    }

    /// limits_override with no timeout set maps to timeout_secs = 0.
    #[test]
    fn heartbeat_ack_limits_no_timeout_maps_to_zero() {
        let wire = pb::HeartbeatAck {
            egress_overrides: vec![],
            limits_override: Some(pb::ResourceLimits {
                vcpu: "500m".to_string(),
                memory: "256Mi".to_string(),
                gpu: "".to_string(),
                timeout: None,
                max_steps: 0,
                max_tokens: 0,
                max_cost_usd: 0.0,
                scratch_size: "".to_string(),
            }),
            drain: false,
            snapshot: false,
        };
        let ack = HeartbeatAck::from(wire);
        let limits = ack.limits_override.unwrap();
        assert_eq!(limits.timeout_secs, 0, "absent timeout must map to 0");
    }

    /// now_unix_ms returns a plausible current time (after year 2020).
    #[test]
    fn now_unix_ms_is_sane() {
        let ms = proto::now_unix_ms();
        // 2020-01-01T00:00:00Z = 1577836800000 ms
        assert!(ms > 1_577_836_800_000, "timestamp looks wrong: {ms}");
    }
}
