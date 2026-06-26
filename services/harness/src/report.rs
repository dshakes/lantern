// Report stream forwarder: drains the harness-wide MPSC of HarnessReport
// messages and pushes them to runtime-manager via the real client-streaming
// `RuntimeHarness.Report` RPC.
//
// Fail-safe for security audit events (P2-B7):
// -------------------------------------------
// Egress-denial and secret-vend audit events are SECURITY-CRITICAL — they are
// the local forensic trail for "what did this VM try to reach / which secrets
// did it pull". Before this change they were silently dropped (the RPC was a
// permanent `Err` stub). Now:
//
//   1. Every security-critical audit (`action == "egress"` with a deny, or
//      `action == "secret_vend"`) is logged locally at WARN *before* any
//      forward attempt. This guarantees a local trail in the VM's stdio/journal
//      even if the manager is unreachable.
//   2. The frames are forwarded to the manager over the real Report RPC.
//   3. On transport failure the forwarder reconnects with bounded backoff; the
//      in-flight frame is preserved (re-queued at the front) so a single
//      transient manager outage does not lose an audit event.
//
// Non-security reports (stdout/stderr logs, OTLP, Prometheus) are best-effort:
// they are forwarded when the stream is healthy and dropped (with a counter)
// when the buffer would block, because they must never back-pressure the
// workload's progress.

use std::time::Duration;

use tokio::sync::mpsc;

use crate::manager_client::ManagerClient;
use crate::proto::HarnessReport;

/// Capacity of the harness-wide report fan-in channel.
const CHANNEL_CAPACITY: usize = 1024;
/// Capacity of the internal forwarding channel handed to the Report RPC.
const FORWARD_CHANNEL_CAPACITY: usize = 256;

/// Construct the harness-wide report fan-in channel. Every subsystem enqueues
/// `HarnessReport` values on the sender; [`run`] drains the receiver.
pub fn channel() -> (mpsc::Sender<HarnessReport>, mpsc::Receiver<HarnessReport>) {
    mpsc::channel(CHANNEL_CAPACITY)
}
/// Reconnect backoff bounds for the Report RPC.
const RECONNECT_MIN: Duration = Duration::from_millis(500);
const RECONNECT_MAX: Duration = Duration::from_secs(15);

/// Is this report security-critical and therefore must leave a local WARN
/// trail even if forwarding fails? True for secret vends and egress *denials*.
fn is_security_audit(rep: &HarnessReport) -> bool {
    match rep {
        HarnessReport::Audit(a) => {
            a.action == "secret_vend"
                || (a.action == "egress"
                    && a.attrs.get("decision").map(String::as_str) == Some("deny"))
        }
        _ => false,
    }
}

/// Emit the guaranteed local trail for a security-critical audit. NEVER logs
/// secret values — `AuditEvent.attrs` for `secret_vend` carry only env_name /
/// secret_uri / expiry (see `secrets.rs`), never the material.
fn log_security_audit(rep: &HarnessReport) {
    if let HarnessReport::Audit(a) = rep {
        tracing::warn!(
            target: "lantern_audit",
            vm_id = %a.vm_id,
            action = %a.action,
            attrs = ?a.attrs,
            "security audit event (local trail; also forwarded to manager)"
        );
    }
}

/// Drain the harness-wide report channel forever, forwarding to the manager
/// over the real Report RPC with reconnect + a security-audit fail-safe.
pub async fn run(manager: ManagerClient, mut rx: mpsc::Receiver<HarnessReport>) {
    let mut dropped: u64 = 0;
    let mut backoff = RECONNECT_MIN;

    // Carry-over frame preserved across a reconnect so a transient manager
    // outage does not lose the audit event that was in flight.
    let mut pending: Option<HarnessReport> = None;

    loop {
        // (fwd_tx, fwd_rx): the per-connection forwarding channel. The Report
        // RPC consumes fwd_rx; we push frames into fwd_tx. A fresh pair is made
        // for every (re)connection because tonic takes ownership of the stream.
        let (fwd_tx, fwd_rx) = mpsc::channel::<HarnessReport>(FORWARD_CHANNEL_CAPACITY);

        // Drive the Report RPC in the background; it returns when the channel
        // closes (clean) or the transport errors.
        let m = manager.clone();
        let rpc = tokio::spawn(async move { m.report_stream(fwd_rx).await });

        // Forward loop: pull from the main rx (or the carried-over frame) and
        // push into the per-connection channel until the RPC task ends.
        let rpc_failed =
            forward_until_break(&mut rx, &fwd_tx, &mut pending, &mut dropped, &rpc).await;

        // Drop fwd_tx so the RPC stream completes, then observe its outcome.
        drop(fwd_tx);
        match rpc.await {
            Ok(Ok(())) => {
                // Clean completion. If the main channel is closed too, exit.
                if rx.is_closed() && pending.is_none() {
                    return;
                }
                backoff = RECONNECT_MIN; // healthy → reset backoff
            }
            Ok(Err(e)) => {
                tracing::warn!(
                    error = %e, dropped, backoff_ms = backoff.as_millis() as u64,
                    "report: Report RPC failed; reconnecting (security audits already \
                     logged locally at WARN)"
                );
            }
            Err(join_err) => {
                tracing::warn!(error = %join_err, "report: Report RPC task panicked; reconnecting");
            }
        }

        // Exit once the source is drained and nothing is in flight — there is
        // nothing left to forward, whether the last RPC ended cleanly or not.
        let _ = rpc_failed;
        if rx.is_closed() && pending.is_none() {
            return;
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_MAX);
    }
}

/// Forward frames into `fwd_tx` until the RPC task finishes (i.e. the send
/// fails because the receiver was dropped on transport error) or the main
/// channel closes. Returns `true` if the loop ended because the RPC failed
/// (so the caller should reconnect), `false` if the source channel closed.
async fn forward_until_break(
    rx: &mut mpsc::Receiver<HarnessReport>,
    fwd_tx: &mpsc::Sender<HarnessReport>,
    pending: &mut Option<HarnessReport>,
    dropped: &mut u64,
    rpc: &tokio::task::JoinHandle<anyhow::Result<()>>,
) -> bool {
    loop {
        // Prefer the carried-over frame from a prior failed connection.
        let rep = match pending.take() {
            Some(r) => r,
            None => match rx.recv().await {
                Some(r) => r,
                None => return false, // source closed → caller exits
            },
        };

        // SECURITY: guaranteed local trail BEFORE any forward attempt.
        if is_security_audit(&rep) {
            log_security_audit(&rep);
        }

        if rpc.is_finished() {
            // Transport already gone — preserve this frame for the reconnect.
            *pending = Some(rep);
            return true;
        }

        if is_security_audit(&rep) {
            // Audit events MUST NOT be dropped on a full buffer — block until
            // there's room (or the receiver is gone, signalling reconnect).
            match fwd_tx.send(rep).await {
                Ok(()) => {}
                Err(returned) => {
                    *pending = Some(returned.0);
                    return true;
                }
            }
        } else {
            // Best-effort for observability frames: drop rather than block.
            match fwd_tx.try_send(rep) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    *dropped = dropped.saturating_add(1);
                    tracing::trace!(
                        dropped = *dropped,
                        "report: dropped non-audit frame (buffer full)"
                    );
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    // Receiver gone → transport error; non-audit frame is dropped
                    // but reconnect is triggered so audits keep flowing.
                    return true;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::{now_unix_ms, AuditEvent, LogLine};
    use std::collections::HashMap;

    fn egress_deny() -> HarnessReport {
        let mut attrs = HashMap::new();
        attrs.insert("host".into(), "evil.example.com".into());
        attrs.insert("decision".into(), "deny".into());
        attrs.insert("reason".into(), "no matching allowlist rule".into());
        HarnessReport::Audit(AuditEvent {
            vm_id: "vm-1".into(),
            action: "egress".into(),
            at_unix_ms: now_unix_ms(),
            attrs,
        })
    }

    fn egress_allow() -> HarnessReport {
        let mut attrs = HashMap::new();
        attrs.insert("decision".into(), "allow".into());
        HarnessReport::Audit(AuditEvent {
            vm_id: "vm-1".into(),
            action: "egress".into(),
            at_unix_ms: now_unix_ms(),
            attrs,
        })
    }

    fn secret_vend() -> HarnessReport {
        let mut attrs = HashMap::new();
        attrs.insert("env_name".into(), "OPENAI_API_KEY".into());
        HarnessReport::Audit(AuditEvent {
            vm_id: "vm-1".into(),
            action: "secret_vend".into(),
            at_unix_ms: now_unix_ms(),
            attrs,
        })
    }

    #[test]
    fn secret_vend_is_security_audit() {
        assert!(is_security_audit(&secret_vend()));
    }

    #[test]
    fn egress_deny_is_security_audit() {
        assert!(is_security_audit(&egress_deny()));
    }

    #[test]
    fn egress_allow_is_not_security_audit() {
        // Allowed egress is routine; it does not need the WARN fail-safe trail.
        assert!(!is_security_audit(&egress_allow()));
    }

    #[test]
    fn plain_log_is_not_security_audit() {
        let log = HarnessReport::Log(LogLine {
            vm_id: "vm-1".into(),
            at_unix_ms: now_unix_ms(),
            stream: "stdout".into(),
            text: "hello".into(),
            attrs: HashMap::new(),
        });
        assert!(!is_security_audit(&log));
    }

    /// When the RPC task has already finished (transport gone), a security
    /// audit frame is preserved in `pending` and the loop signals reconnect —
    /// the audit is NOT dropped.
    #[tokio::test]
    async fn security_audit_preserved_when_transport_down() {
        let (tx, mut rx) = mpsc::channel::<HarnessReport>(4);
        let (fwd_tx, _fwd_rx) = mpsc::channel::<HarnessReport>(4);
        // A finished task simulates a dead transport.
        let rpc: tokio::task::JoinHandle<anyhow::Result<()>> = tokio::spawn(async { Ok(()) });
        // Wait until the task is observably finished.
        while !rpc.is_finished() {
            tokio::task::yield_now().await;
        }

        tx.send(secret_vend()).await.unwrap();
        let mut pending: Option<HarnessReport> = None;
        let mut dropped = 0u64;

        let reconnect =
            forward_until_break(&mut rx, &fwd_tx, &mut pending, &mut dropped, &rpc).await;
        assert!(reconnect, "must signal reconnect when transport is down");
        assert!(
            pending.is_some(),
            "security audit must be preserved, not dropped"
        );
        match pending.unwrap() {
            HarnessReport::Audit(a) => assert_eq!(a.action, "secret_vend"),
            other => panic!("expected the preserved secret_vend audit, got {other:?}"),
        }
    }

    /// A security audit blocks for buffer room (is delivered) rather than being
    /// dropped, while the stream is healthy.
    #[tokio::test]
    async fn security_audit_is_delivered_not_dropped() {
        let (tx, mut rx) = mpsc::channel::<HarnessReport>(4);
        let (fwd_tx, mut fwd_rx) = mpsc::channel::<HarnessReport>(1);
        // A never-finishing task simulates a healthy live stream.
        let rpc: tokio::task::JoinHandle<anyhow::Result<()>> = tokio::spawn(async {
            std::future::pending::<()>().await;
            Ok(())
        });

        tx.send(egress_deny()).await.unwrap();
        drop(tx); // close source so the loop returns after draining
        let mut pending: Option<HarnessReport> = None;
        let mut dropped = 0u64;

        let reconnect =
            forward_until_break(&mut rx, &fwd_tx, &mut pending, &mut dropped, &rpc).await;
        assert!(
            !reconnect,
            "healthy stream + closed source → no reconnect signal"
        );
        assert_eq!(dropped, 0, "security audit must never count as dropped");
        let forwarded = fwd_rx.recv().await.expect("audit must be forwarded");
        match forwarded {
            HarnessReport::Audit(a) => assert_eq!(a.action, "egress"),
            other => panic!("expected forwarded egress audit, got {other:?}"),
        }
        rpc.abort();
    }
}
