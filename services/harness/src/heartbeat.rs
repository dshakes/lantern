// Heartbeat: bidirectional gRPC stream to runtime-manager.
//
// Sends a HeartbeatRequest every 5s containing the current ResourceUsage
// snapshot, the supervisor's worker_pid, and the restart count.
//
// Reads HeartbeatAck messages from the manager. Acks may carry:
//   * egress_overrides — pushed live to the egress proxy
//   * limits_override  — recorded for future workload restarts
//   * drain            — signals graceful shutdown
//   * snapshot         — prep for snapshot (flush buffers, signal workload)
//
// MUST tolerate the manager being unreachable: failures roll into an
// exponential backoff reconnect loop. The workload keeps running.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::sync::mpsc::Sender as MpscSender;

use crate::egress::EgressPolicy;
use crate::manager_client::ManagerClient;
use crate::proto::{HeartbeatRequest, ResourceUsage, now_unix_ms};
use crate::signals::ControlSignal;
use crate::supervisor::SupervisorHandles;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

pub struct Heartbeat {
    manager: ManagerClient,
    supervisor: SupervisorHandles,
    egress: Arc<EgressPolicy>,
    control_tx: MpscSender<ControlSignal>,
    usage: Arc<Mutex<ResourceUsage>>,
}

impl Heartbeat {
    pub fn new(
        manager: ManagerClient,
        supervisor: SupervisorHandles,
        egress: Arc<EgressPolicy>,
        control_tx: MpscSender<ControlSignal>,
    ) -> Self {
        Self {
            manager,
            supervisor,
            egress,
            control_tx,
            usage: Arc::new(Mutex::new(ResourceUsage::default())),
        }
    }

    /// Expose the usage Arc so `main.rs` can start the sampler task.
    pub fn usage_handle(&self) -> Arc<Mutex<ResourceUsage>> {
        Arc::clone(&self.usage)
    }

    /// Loop forever: connect, send/receive, on error back off and retry.
    pub async fn run(self) {
        let mut backoff = INITIAL_BACKOFF;

        loop {
            match self.manager.open_heartbeat_stream().await {
                Ok((req_tx, mut ack_rx)) => {
                    tracing::info!("heartbeat: stream open to {}", self.manager.manager_addr);
                    self.manager.note_contact().await;
                    backoff = INITIAL_BACKOFF;

                    // Two halves: sender loop + ack reader.
                    let send_handle = {
                        let manager = self.manager.clone();
                        let supervisor = self.supervisor.clone();
                        let usage = Arc::clone(&self.usage);
                        let req_tx = req_tx.clone();
                        tokio::spawn(async move {
                            let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
                            loop {
                                ticker.tick().await;
                                let snap = usage.lock().await.clone();
                                let req = HeartbeatRequest {
                                    vm_id: manager.vm_id.clone(),
                                    at_unix_ms: now_unix_ms(),
                                    usage: snap,
                                    worker_pid: supervisor.worker_pid.load(Ordering::SeqCst),
                                    restart_count: supervisor.restart_count.load(Ordering::SeqCst),
                                };
                                if req_tx.send(req).await.is_err() {
                                    tracing::warn!("heartbeat: send channel closed");
                                    return;
                                }
                            }
                        })
                    };

                    // Ack reader. Loop until the stream ends.
                    while let Some(ack) = ack_rx.recv().await {
                        self.manager.note_contact().await;

                        if !ack.egress_overrides.is_empty() {
                            tracing::info!(
                                rules = ack.egress_overrides.len(),
                                "heartbeat: applying egress overrides"
                            );
                            self.egress.replace_rules(ack.egress_overrides).await;
                        }

                        if ack.drain {
                            tracing::info!("heartbeat: manager requested drain");
                            let _ = self.control_tx.send(ControlSignal::Drain).await;
                        }

                        if ack.snapshot {
                            tracing::info!("heartbeat: manager requested snapshot");
                            let _ = self.control_tx.send(ControlSignal::Snapshot).await;
                        }
                    }

                    tracing::warn!("heartbeat: ack stream ended, will reconnect");
                    send_handle.abort();
                }
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        backoff_ms = backoff.as_millis() as u64,
                        "manager unreachable, will retry"
                    );
                }
            }

            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }
}

/// Background sampler that fills `usage` from /proc and the kernel. On
/// non-Linux hosts (developer macOS) this stays at zeros — the heartbeat
/// loop still ticks for end-to-end verification.
pub async fn sample_usage_loop(usage: Arc<Mutex<ResourceUsage>>) {
    let mut ticker = tokio::time::interval(Duration::from_secs(2));
    loop {
        ticker.tick().await;
        // Best-effort: read /proc/self/status for VmRSS. Anything more
        // sophisticated (cgroup stats, net iface counters) lives in a
        // future cgroup-v2 helper.
        if let Ok(s) = tokio::fs::read_to_string("/proc/self/status").await {
            for line in s.lines() {
                if let Some(rest) = line.strip_prefix("VmRSS:") {
                    let kb: i64 = rest
                        .split_whitespace()
                        .next()
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0);
                    usage.lock().await.memory_bytes = kb * 1024;
                }
            }
        }
    }
}
