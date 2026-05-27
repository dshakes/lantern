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
        // TODO: regenerate from runtime.proto — wire to the real gRPC client.
        //
        // For now we install a loopback pair so the supervisor can keep
        // running even with no manager. The heartbeat task treats this as a
        // healthy-but-silent peer: it pushes acks with no policy changes.
        let _ = tokio::net::TcpStream::connect(&self.manager_addr)
            .await
            .map_err(|e| anyhow::anyhow!("manager unreachable: {e}"))?;

        let (req_tx, _req_rx) = mpsc::channel::<HeartbeatRequest>(8);
        let (ack_tx, ack_rx) = mpsc::channel::<HeartbeatAck>(8);

        // Synthetic keepalive ack — production swaps this for the gRPC
        // response stream. Without it the heartbeat loop would block forever
        // waiting for the first ack from a stub.
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
        // TODO: regenerate from runtime.proto.
        //
        // Failure mode for the stub: if the manager is unreachable we return
        // a typed error so secrets.rs can keep serving the cached value
        // until its real expiry.
        let _conn = tokio::net::TcpStream::connect(&self.manager_addr)
            .await
            .map_err(|e| anyhow::anyhow!("vend_secret transport error: {e}"))?;

        // Synthetic placeholder — real impl returns the manager-vended
        // value + expiry. The audit trail must still emit.
        Ok(VendSecretResponse {
            value: format!("STUB::{}::{}", self.vm_id, req.secret_uri),
            expires_at_unix_ms: crate::proto::now_unix_ms() + 60_000,
        })
    }
}
