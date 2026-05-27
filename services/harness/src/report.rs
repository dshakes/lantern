// Report stream forwarder: drains the harness-wide MPSC of HarnessReport
// messages and pushes them to runtime-manager via the Report RPC.
//
// On manager outage the channel keeps draining (we don't want unbounded
// memory growth); reports are dropped with a counter so we know.

use tokio::sync::mpsc;

use crate::manager_client::ManagerClient;
use crate::proto::HarnessReport;

const CHANNEL_CAPACITY: usize = 1024;

pub fn channel() -> (mpsc::Sender<HarnessReport>, mpsc::Receiver<HarnessReport>) {
    mpsc::channel(CHANNEL_CAPACITY)
}

/// Drain the channel forever. The actual RPC stream wiring is stubbed
/// today and replaced by tonic codegen later. Until then we log each
/// report at trace level so end-to-end behaviour is observable on
/// developer hosts.
pub async fn run(manager: ManagerClient, mut rx: mpsc::Receiver<HarnessReport>) {
    let mut dropped: u64 = 0;
    while let Some(rep) = rx.recv().await {
        // TODO: regenerate from runtime.proto — call the streaming Report
        // RPC on the generated client. For now: per-message log + an
        // attempt to confirm manager is reachable.
        if let Err(e) = forward_one(&manager, &rep).await {
            dropped = dropped.saturating_add(1);
            if dropped.is_power_of_two() {
                tracing::warn!(
                    dropped,
                    error = %e,
                    "report: manager unreachable; dropped reports (logged at trace)"
                );
            }
            tracing::trace!(?rep, "dropped report");
            continue;
        }
        tracing::trace!(?rep, "forwarded report");
    }
}

async fn forward_one(manager: &ManagerClient, rep: &HarnessReport) -> anyhow::Result<()> {
    // TODO: regenerate from runtime.proto.
    //
    // Stub: probe the manager TCP socket. Real impl serializes `rep` and
    // pushes it down the Report stream. We DO NOT block on the probe
    // failing — the caller treats any error as a drop and continues.
    let _ = tokio::net::TcpStream::connect(&manager.manager_addr)
        .await
        .map_err(|e| anyhow::anyhow!("manager unreachable: {e}"))?;
    let _ = rep;
    Ok(())
}
