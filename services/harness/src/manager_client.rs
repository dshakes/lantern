// Thin abstraction over the gRPC client to runtime-manager.
//
// Today this is a JSON-over-TCP shim that uses tokio's stream primitives so
// every subsystem can call `client.send_report(...)` / `client.vend_secret(...)`
// without caring about transport. Once tonic codegen lands, replace the body
// with the generated `RuntimeHarnessClient` and keep the surface area below.
//
// TODO: regenerate from runtime.proto

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio::sync::mpsc;
use tokio::sync::Mutex;

use crate::proto::{
    HarnessReport, HeartbeatAck, HeartbeatRequest, VendSecretRequest, VendSecretResponse,
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
        g.last_contact_ms = crate::proto::now_unix_ms();
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
        // TODO: regenerate from runtime.proto — replace this entire body with
        // the real tonic RuntimeHarnessClient bidirectional stream.
        //
        // For now we install a loopback pair so the supervisor can keep
        // running even with no manager. The heartbeat task treats this as a
        // healthy-but-silent peer: it pushes acks with no policy changes.
        let _ = tokio::net::TcpStream::connect(&self.manager_addr)
            .await
            .map_err(|e| anyhow::anyhow!("manager unreachable: {e}"))?;

        let (req_tx, _req_rx) = mpsc::channel::<HeartbeatRequest>(8);
        let (ack_tx, ack_rx) = mpsc::channel::<HeartbeatAck>(8);

        // L3 fix: emit a loud WARN so it is visible in production logs that
        // the policy-refresh path is stubbed.  A revoked egress allowlist will
        // NOT propagate to this VM until the real gRPC stream is wired.
        // Synthetic keepalive ack — production swaps this for the gRPC
        // response stream.
        //
        // TODO: remove this spawn and replace with the real gRPC stream.
        // Until then, egress rule revocations from the manager are silently
        // ignored — the in-VM allowlist can only grow, never shrink, during a
        // session.  This is a known gap; see the L3 finding in the security
        // audit.
        tracing::warn!(
            vm_id = %self.vm_id,
            manager_addr = %self.manager_addr,
            "heartbeat: policy-refresh is STUBBED — egress rule revocations \
             from the manager will NOT take effect until the real gRPC stream \
             is wired (TODO: regenerate from runtime.proto)"
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

    /// Unary VendSecret RPC. The harness MUST refresh before expiry.
    pub async fn vend_secret(&self, req: VendSecretRequest) -> Result<VendSecretResponse> {
        // H1 fix: do NOT return a predictable fake secret value.  The old
        // stub produced `STUB::<vm_id>::<secret_uri>` which is deterministic,
        // never tenant-bound, and could be inferred by any code that knows
        // the vm_id and secret URI.
        //
        // TODO: regenerate from runtime.proto — replace this body with the
        // real tonic RuntimeHarnessClient.VendSecret unary RPC.  The manager
        // must bind the returned value to (tenant_id, run_id, vm_id) and
        // enforce the declared-secrets allowlist on its side.
        //
        // Until the real RPC is wired, opt-in with LANTERN_ALLOW_SECRET_STUB=1
        // for local development only.  In production, an unresolvable secret
        // will bubble up as an error to the workload, which is the correct
        // fail-closed behaviour.

        let allow_stub = std::env::var("LANTERN_ALLOW_SECRET_STUB")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        if !allow_stub {
            // Attempt the TCP connection so callers can distinguish "manager
            // truly unreachable" from "stub refused".
            let _conn = tokio::net::TcpStream::connect(&self.manager_addr)
                .await
                .map_err(|e| anyhow::anyhow!("vend_secret transport error: {e}"))?;

            anyhow::bail!(
                "vend_secret: real VendSecret RPC is not yet wired \
                 (TODO: regenerate from runtime.proto). Refusing to return \
                 a predictable stub value that could be mistaken for a real \
                 credential. Set LANTERN_ALLOW_SECRET_STUB=1 only in \
                 dev/test environments."
            );
        }

        tracing::warn!(
            vm_id = %self.vm_id,
            secret_uri = %req.secret_uri,
            "vend_secret: STUB mode (LANTERN_ALLOW_SECRET_STUB=1) — \
             returning a fake value that is NOT a real credential. \
             Dev/test use only."
        );

        let _conn = tokio::net::TcpStream::connect(&self.manager_addr)
            .await
            .map_err(|e| anyhow::anyhow!("vend_secret transport error: {e}"))?;

        // Stub value is clearly marked so it can never be silently used as a
        // real credential — any downstream system that sees this prefix should
        // treat it as an error.
        Ok(VendSecretResponse {
            value: format!(
                "LANTERN_STUB_NOT_A_REAL_SECRET::{}::{}",
                self.vm_id, req.secret_uri
            ),
            expires_at_unix_ms: crate::proto::now_unix_ms() + 60_000,
        })
    }
}
