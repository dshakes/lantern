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
use std::time::Duration;

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

    /// Open a long-lived bidirectional Heartbeat stream. The returned
    /// channels are: send heartbeats in via `tx`, drain HeartbeatAcks via
    /// `rx`. The actual transport wiring is in `heartbeat.rs`.
    ///
    /// Returns Err if the manager is unreachable so the caller can back off.
    pub async fn open_heartbeat_stream(
        &self,
    ) -> Result<(mpsc::Sender<HeartbeatRequest>, mpsc::Receiver<HeartbeatAck>)> {
        // TODO: replace with the real tonic RuntimeHarnessClient bidirectional
        // Heartbeat stream once the manager's heartbeat handler is wired.
        //
        // For now we install a loopback pair so the supervisor can keep
        // running even with no manager. The heartbeat task treats this as a
        // healthy-but-silent peer: it pushes acks with no policy changes.
        let _ = tokio::net::TcpStream::connect(&self.manager_addr)
            .await
            .map_err(|e| anyhow::anyhow!("manager unreachable: {e}"))?;

        let (req_tx, _req_rx) = mpsc::channel::<HeartbeatRequest>(8);
        let (ack_tx, ack_rx) = mpsc::channel::<HeartbeatAck>(8);

        tracing::warn!(
            vm_id = %self.vm_id,
            manager_addr = %self.manager_addr,
            "heartbeat: policy-refresh is STUBBED — egress rule revocations \
             from the manager will NOT take effect until the real gRPC stream \
             is wired"
        );

        tokio::spawn(async move {
            loop {
                if ack_tx.send(HeartbeatAck::default()).await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
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
}
