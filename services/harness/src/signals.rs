// Signal handling + PID 1 zombie reaping + drain logic.
//
// SIGTERM  -> drain. Forward SIGTERM to the workload, wait N seconds, then
//             SIGKILL. Harness exits 0.
// SIGUSR1  -> snapshot prep. Flush log buffers, signal the workload via
//             SIGUSR1 (workloads that implement checkpointing handle it),
//             then ack.
// SIGCHLD  -> reap zombies. Linux gives PID 1 the responsibility of
//             reaping orphaned children whose parents have died.

use std::sync::atomic::Ordering;
use std::time::Duration;

use nix::sys::signal::{Signal, kill};
use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
use nix::unistd::Pid;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::mpsc::Receiver as MpscReceiver;

use crate::manager_client::ManagerClient;
use crate::proto::{AuditEvent, HarnessReport, now_unix_ms};
use crate::supervisor::SupervisorHandles;

const DEFAULT_DRAIN_GRACE_SECS: u64 = 25;

#[derive(Debug, Clone, Copy)]
pub enum ControlSignal {
    Drain,
    Snapshot,
}

/// Spawn all signal-handling tasks. Returns immediately.
pub fn install(
    manager: ManagerClient,
    supervisor: SupervisorHandles,
) -> tokio::sync::mpsc::Sender<ControlSignal> {
    let (tx, rx) = tokio::sync::mpsc::channel(8);

    // SIGTERM listener.
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut s = match signal(SignalKind::terminate()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "signals: SIGTERM install failed");
                    return;
                }
            };
            while s.recv().await.is_some() {
                tracing::info!("signals: SIGTERM received");
                let _ = tx.send(ControlSignal::Drain).await;
            }
        });
    }

    // SIGUSR1 listener.
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut s = match signal(SignalKind::user_defined1()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "signals: SIGUSR1 install failed");
                    return;
                }
            };
            while s.recv().await.is_some() {
                tracing::info!("signals: SIGUSR1 received");
                let _ = tx.send(ControlSignal::Snapshot).await;
            }
        });
    }

    // SIGCHLD reaper: drain zombies that orphan to us as PID 1. Note the
    // supervisor's direct child is also reaped here when it exits because
    // `tokio::process::Child::wait` plays nicely with our nonblocking
    // waitpid (it relies on a sigchld-driven mailbox internally).
    tokio::spawn(zombie_reaper());

    // Reactor for ControlSignals (from this module *and* from heartbeat).
    tokio::spawn(handle_control(rx, manager, supervisor));

    tx
}

async fn zombie_reaper() {
    let Ok(mut sigchld) = signal(SignalKind::child()) else {
        tracing::error!("signals: SIGCHLD install failed; zombie reaping disabled");
        return;
    };
    while sigchld.recv().await.is_some() {
        loop {
            match waitpid(Pid::from_raw(-1), Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::StillAlive) => break,
                Ok(WaitStatus::Exited(pid, code)) => {
                    tracing::debug!(?pid, code, "reaped child");
                }
                Ok(WaitStatus::Signaled(pid, sig, _)) => {
                    tracing::debug!(?pid, ?sig, "reaped child (signaled)");
                }
                Ok(_) => {}
                Err(nix::errno::Errno::ECHILD) => break,
                Err(e) => {
                    tracing::debug!(error = %e, "waitpid error");
                    break;
                }
            }
        }
    }
}

async fn handle_control(
    mut rx: MpscReceiver<ControlSignal>,
    manager: ManagerClient,
    supervisor: SupervisorHandles,
) {
    while let Some(sig) = rx.recv().await {
        match sig {
            ControlSignal::Drain => drain(&manager, &supervisor).await,
            ControlSignal::Snapshot => snapshot(&manager, &supervisor).await,
        }
    }
}

async fn drain(manager: &ManagerClient, supervisor: &SupervisorHandles) {
    if supervisor.draining.swap(true, Ordering::SeqCst) {
        tracing::info!("drain: already in progress");
        return;
    }
    let grace = std::env::var("LANTERN_DRAIN_GRACE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_DRAIN_GRACE_SECS);

    manager
        .enqueue_report(HarnessReport::Audit(AuditEvent {
            vm_id: manager.vm_id.clone(),
            action: "drain_start".into(),
            at_unix_ms: now_unix_ms(),
            attrs: [("grace_secs".into(), grace.to_string())]
                .into_iter()
                .collect(),
        }))
        .await;

    // 1. SIGTERM the workload.
    let pid = supervisor.worker_pid.load(Ordering::SeqCst);
    if pid > 0 {
        let _ = kill(Pid::from_raw(pid), Signal::SIGTERM);
    }

    // 2. Wait up to `grace` seconds for it to exit.
    let deadline = std::time::Instant::now() + Duration::from_secs(grace);
    loop {
        if std::time::Instant::now() >= deadline {
            break;
        }
        let still_running = supervisor.child.lock().await.is_some()
            && supervisor.worker_pid.load(Ordering::SeqCst) > 0;
        if !still_running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // 3. SIGKILL anything that hasn't exited.
    let pid = supervisor.worker_pid.load(Ordering::SeqCst);
    if pid > 0 {
        let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
    }

    crate::logs::flush();
    manager
        .enqueue_report(HarnessReport::Audit(AuditEvent {
            vm_id: manager.vm_id.clone(),
            action: "drain_complete".into(),
            at_unix_ms: now_unix_ms(),
            attrs: Default::default(),
        }))
        .await;
}

async fn snapshot(manager: &ManagerClient, supervisor: &SupervisorHandles) {
    manager
        .enqueue_report(HarnessReport::Audit(AuditEvent {
            vm_id: manager.vm_id.clone(),
            action: "snapshot".into(),
            at_unix_ms: now_unix_ms(),
            attrs: Default::default(),
        }))
        .await;
    crate::logs::flush();
    let pid = supervisor.worker_pid.load(Ordering::SeqCst);
    if pid > 0 {
        // Workloads that implement checkpointing observe SIGUSR1 and
        // checkpoint themselves. Workloads that don't simply ignore it.
        let _ = kill(Pid::from_raw(pid), Signal::SIGUSR1);
    }
}
