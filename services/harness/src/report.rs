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
    // The manager-side Report ingestion RPC is not yet wired (see forward_one),
    // so reports are dropped today. Warn ONCE — not per power-of-two — and never
    // claim "manager unreachable", because the manager may be perfectly healthy;
    // the RPC simply doesn't exist yet.
    let mut warned = false;
    let mut dropped: u64 = 0;
    while let Some(rep) = rx.recv().await {
        if let Err(e) = forward_one(&manager, &rep).await {
            dropped = dropped.saturating_add(1);
            if !warned {
                warned = true;
                tracing::warn!(
                    error = %e,
                    "report: Report RPC not yet wired on the manager side — \
                     dropping observability reports (individual drops at trace)"
                );
            }
            tracing::trace!(?rep, dropped, "dropped report");
            continue;
        }
        tracing::trace!(?rep, "forwarded report");
    }
}

async fn forward_one(_manager: &ManagerClient, _rep: &HarnessReport) -> anyhow::Result<()> {
    // TODO(report-rpc): wire the real `RuntimeHarness.Report` client-streaming
    // RPC once the manager side is ready.
    //
    // Current state: `RuntimeHarnessGrpc::report` in
    // `services/runtime-manager/src/service.rs` returns
    // `Status::unimplemented("report: log/trace ingestion pipeline not yet
    // wired on the manager side")`. Calling the RPC today would surface that
    // error on every report message and cause spurious reconnect noise.
    //
    // When the manager's ingestion pipeline is wired:
    //   1. Open a `RuntimeHarnessClient::report(req_stream)` channel (same
    //      mTLS setup as `open_heartbeat_stream`).
    //   2. Convert each `HarnessReport` variant to `pb::HarnessReport` (a
    //      oneof over RuntimeLogLine / otlp_traces / prometheus_metrics /
    //      AuditEvent) and send it down the stream.
    //   3. On stream error, return Err so the caller's drop-and-warn logic
    //      fires (same pattern as today).
    //
    // The proto conversions for HarnessReport are not yet in proto.rs; add
    // them alongside the RPC wiring.
    Err(anyhow::anyhow!(
        "report: manager-side ingestion not yet implemented; dropping report"
    ))
}
