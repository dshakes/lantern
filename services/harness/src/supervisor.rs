// Supervisor: spawns the workload binary as a child process, tails stdio,
// restarts on crash up to N times, and exits cleanly when the workload
// exits successfully.
//
// PID 1 contract: the harness is the init process. Linux gives PID 1 the
// responsibility of reaping orphaned zombies — we do that in a separate
// task in `signals.rs`. The supervisor itself only `wait`s on its direct
// child.

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::Mutex;

use crate::manager_client::ManagerClient;
use crate::proto::{now_unix_ms, AuditEvent, HarnessReport};

const DEFAULT_MAX_RESTARTS: i32 = 5;

/// Localhost addresses + suffixes the workload must NOT proxy — the egress
/// proxy itself, the secrets socket host, and link-local metadata are all
/// reached (or blocked) directly, never through the CONNECT proxy.
const DEFAULT_NO_PROXY: &str = "127.0.0.1,localhost,::1,169.254.169.254";

/// Compute the proxy environment to inject into the workload, given the proxy
/// endpoint host:port. Returns the `(KEY, VALUE)` pairs.
///
/// P2-B7 (2): the egress allowlist proxy (`egress.rs`) is only *advisory*
/// unless traffic is forced through it. The harness forces it two ways:
///   1. iptables REDIRECT in the VM image (true enforcement; see egress.rs
///      header + the boot preflight in `main.rs`), and
///   2. proxy env injection here, so well-behaved clients (most HTTP libs,
///      curl, requests, openai-python) honor the allowlist even where the
///      REDIRECT layer is absent (defence in depth, not a substitute).
///
/// We set both upper- and lower-case forms because libraries disagree on which
/// they read (curl reads lower-case `http_proxy`; many read upper-case).
#[must_use]
pub fn proxy_env_pairs(proxy_addr: &str) -> Vec<(String, String)> {
    let url = format!("http://{proxy_addr}");
    let no_proxy =
        std::env::var("LANTERN_NO_PROXY").unwrap_or_else(|_| DEFAULT_NO_PROXY.to_string());
    let mut pairs = Vec::with_capacity(9);
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
        pairs.push((key.to_string(), url.clone()));
        pairs.push((key.to_lowercase(), url.clone()));
    }
    pairs.push(("NO_PROXY".to_string(), no_proxy.clone()));
    pairs.push(("no_proxy".to_string(), no_proxy));
    pairs
}

/// The proxy address the workload should be pointed at — the same bind the
/// egress proxy listens on (`LANTERN_EGRESS_BIND`, default `127.0.0.1:3128`).
fn egress_proxy_addr() -> String {
    std::env::var("LANTERN_EGRESS_BIND").unwrap_or_else(|_| "127.0.0.1:3128".to_string())
}

#[derive(Clone)]
pub struct Supervisor {
    workload_cmd: Vec<String>,
    max_restarts: i32,
    manager: ManagerClient,
    /// When true, inject HTTP(S)_PROXY/ALL_PROXY/NO_PROXY into the workload env
    /// so its HTTP clients route through the egress allowlist proxy. Set when
    /// the AgentSpec declares egress rules (P2-B7 fix #2).
    inject_proxy_env: bool,

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
            inject_proxy_env: false,
            restart_count: Arc::new(AtomicI32::new(0)),
            worker_pid: Arc::new(AtomicI32::new(0)),
            draining: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
        }
    }

    /// Enable proxy-env injection into the workload. Call with `true` when the
    /// AgentSpec declares egress rules so the workload's HTTP clients route
    /// through the allowlist proxy (P2-B7 fix #2).
    #[must_use]
    pub fn with_proxy_env(mut self, enabled: bool) -> Self {
        self.inject_proxy_env = enabled;
        self
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

            // P2-B7 (2): point the workload's HTTP clients at the egress
            // allowlist proxy. Only when egress rules are declared — otherwise
            // there's nothing to enforce and an unset proxy is correct.
            if self.inject_proxy_env {
                let addr = egress_proxy_addr();
                for (k, v) in proxy_env_pairs(&addr) {
                    cmd.env(k, v);
                }
                tracing::info!(
                    proxy = %addr,
                    "supervisor: injected HTTP(S)_PROXY/ALL_PROXY/NO_PROXY into workload env \
                     (egress allowlist)"
                );
            }

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn proxy_env_sets_all_three_proxy_vars_both_cases() {
        let pairs = proxy_env_pairs("127.0.0.1:3128");
        let map: HashMap<_, _> = pairs.into_iter().collect();
        let want = "http://127.0.0.1:3128";
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
            assert_eq!(
                map.get(key).map(String::as_str),
                Some(want),
                "{key} must be set"
            );
            assert_eq!(
                map.get(&key.to_lowercase()).map(String::as_str),
                Some(want),
                "{} (lower-case) must be set",
                key.to_lowercase()
            );
        }
    }

    #[test]
    fn proxy_env_no_proxy_keeps_loopback_and_metadata_direct() {
        let pairs = proxy_env_pairs("127.0.0.1:3128");
        let map: HashMap<_, _> = pairs.into_iter().collect();
        let no_proxy = map.get("NO_PROXY").expect("NO_PROXY must be set");
        // Loopback + metadata must bypass the proxy so the secrets socket host,
        // the proxy itself, and metadata-blocking stay direct.
        assert!(no_proxy.contains("127.0.0.1"));
        assert!(no_proxy.contains("169.254.169.254"));
        assert_eq!(
            map.get("no_proxy").map(String::as_str),
            map.get("NO_PROXY").map(String::as_str),
            "lower-case no_proxy must mirror NO_PROXY"
        );
    }

    #[test]
    fn proxy_env_uses_configured_bind() {
        let pairs = proxy_env_pairs("10.0.0.5:8080");
        let map: HashMap<_, _> = pairs.into_iter().collect();
        assert_eq!(
            map.get("HTTP_PROXY").map(String::as_str),
            Some("http://10.0.0.5:8080")
        );
    }
}
