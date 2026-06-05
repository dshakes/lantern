// Supervisor: spawns the workload binary as a child process, tails stdio,
// restarts on crash up to N times, and exits cleanly when the workload
// exits successfully.
//
// PID 1 contract: the harness is the init process. Linux gives PID 1 the
// responsibility of reaping orphaned zombies — we do that in a separate
// task in `signals.rs`. The supervisor itself only `wait`s on its direct
// child.

use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use anyhow::{Context, Result};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::Mutex;

use crate::manager_client::ManagerClient;
use crate::proto::{AuditEvent, HarnessReport, now_unix_ms};

const DEFAULT_MAX_RESTARTS: i32 = 5;

#[derive(Clone)]
pub struct Supervisor {
    workload_cmd: Vec<String>,
    max_restarts: i32,
    manager: ManagerClient,

    restart_count: Arc<AtomicI32>,
    worker_pid: Arc<AtomicI32>,
    draining: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

/// Handles the supervisor exposes so other subsystems can read live state.
#[derive(Clone)]
pub struct SupervisorHandles {
    pub restart_count: Arc<AtomicI32>,
    pub worker_pid: Arc<AtomicI32>,
    pub draining: Arc<AtomicBool>,
    pub child: Arc<Mutex<Option<Child>>>,
}

/// Stdio handles for the log forwarder. Re-issued on every restart.
pub struct WorkloadStdio {
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

impl Supervisor {
    pub fn new(workload_cmd: Vec<String>, manager: ManagerClient) -> Self {
        Self {
            workload_cmd,
            max_restarts: std::env::var("LANTERN_MAX_RESTARTS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(DEFAULT_MAX_RESTARTS),
            manager,
            restart_count: Arc::new(AtomicI32::new(0)),
            worker_pid: Arc::new(AtomicI32::new(0)),
            draining: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
        }
    }

    pub fn handles(&self) -> SupervisorHandles {
        SupervisorHandles {
            restart_count: Arc::clone(&self.restart_count),
            worker_pid: Arc::clone(&self.worker_pid),
            draining: Arc::clone(&self.draining),
            child: Arc::clone(&self.child),
        }
    }

    /// Spawn the workload. Returns the stdio handles to feed the log
    /// forwarder. Subsequent restarts re-issue fresh handles via the
    /// `stdio_tx` channel.
    pub async fn run(self, stdio_tx: tokio::sync::mpsc::Sender<WorkloadStdio>) -> Result<i32> {
        if self.workload_cmd.is_empty() {
            anyhow::bail!("LANTERN_WORKLOAD_CMD is empty — nothing to supervise");
        }

        loop {
            if self.draining.load(Ordering::SeqCst) {
                tracing::info!("supervisor: draining, not restarting workload");
                return Ok(0);
            }

            let attempt = self.restart_count.load(Ordering::SeqCst);
            tracing::info!(
                attempt,
                cmd = ?self.workload_cmd,
                "supervisor: spawning workload"
            );

            let mut cmd = Command::new(&self.workload_cmd[0]);
            cmd.args(&self.workload_cmd[1..])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null())
                .kill_on_drop(true);

            let mut child = cmd
                .spawn()
                .with_context(|| format!("failed to spawn {:?}", self.workload_cmd))?;

            let pid = child.id().map(|p| p as i32).unwrap_or(-1);
            self.worker_pid.store(pid, Ordering::SeqCst);

            // Emit an audit event for the exec.
            self.manager
                .enqueue_report(HarnessReport::Audit(AuditEvent {
                    vm_id: self.manager.vm_id.clone(),
                    action: "exec".into(),
                    at_unix_ms: now_unix_ms(),
                    attrs: [
                        ("pid".into(), pid.to_string()),
                        ("cmd".into(), self.workload_cmd.join(" ")),
                        ("attempt".into(), attempt.to_string()),
                    ]
                    .into_iter()
                    .collect(),
                }))
                .await;

            // Hand stdio off to the log forwarder.
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let _ = stdio_tx.send(WorkloadStdio { stdout, stderr }).await;

            // Park the child so signal handlers + other subsystems can see it.
            {
                let mut slot = self.child.lock().await;
                *slot = Some(child);
            }

            // Wait on the child without holding the mutex for the await.
            // We pop the child out of the slot so other subsystems that
            // only need the pid can still observe it via `worker_pid`.
            let mut child_opt = {
                let mut slot = self.child.lock().await;
                slot.take()
            };
            let status = if let Some(c) = child_opt.as_mut() {
                c.wait().await.context("waiting on workload")?
            } else {
                // Drained between spawn and wait.
                return Ok(0);
            };

            tracing::info!(?status, "workload exited");
            let exit_code = status.code().unwrap_or(-1);

            if status.success() {
                tracing::info!("supervisor: workload exited successfully, harness shutting down");
                return Ok(exit_code);
            }

            let next = self.restart_count.fetch_add(1, Ordering::SeqCst) + 1;
            if next > self.max_restarts {
                tracing::error!(
                    next,
                    max = self.max_restarts,
                    "supervisor: workload exhausted restart budget"
                );
                return Ok(exit_code);
            }

            // Linear-ish backoff. Avoid hammering the system on crash loops.
            let backoff_ms = (next as u64).saturating_mul(500).min(10_000);
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
        }
    }
}
