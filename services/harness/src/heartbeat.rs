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
///
/// Strategy:
///  1. Try to locate the cgroup v2 unified-hierarchy path for the harness
///     from `/proc/self/cgroup`, then read `memory.current`, `memory.max`,
///     and `cpu.stat` from `/sys/fs/cgroup/<path>/`.
///  2. Fall back to `/proc/self/status` (VmRSS) when cgroup files are absent
///     (macOS dev, cgroup v1, or environments without cgroup v2 mounted).
pub async fn sample_usage_loop(usage: Arc<Mutex<ResourceUsage>>) {
    let mut ticker = tokio::time::interval(Duration::from_secs(2));
    loop {
        ticker.tick().await;

        // Attempt cgroup v2 first (Linux production path).
        #[cfg(target_os = "linux")]
        {
            if let Some(snap) = cgroup_v2::sample().await {
                let mut u = usage.lock().await;
                u.memory_bytes = snap.memory_bytes;
                u.vcpu_ms_used = snap.cpu_usage_usec / 1000; // µs → ms
                continue;
            }
        }

        // Fallback: /proc/self/status VmRSS.
        if let Ok(s) = tokio::fs::read_to_string("/proc/self/status").await
            && let Some(kb) = parse_vmrss(&s)
        {
            usage.lock().await.memory_bytes = kb * 1024;
        }
    }
}

// ---------------------------------------------------------------------------
// Pure parsing helpers — unit-tested on all platforms.
// ---------------------------------------------------------------------------

/// Parse `VmRSS` from the contents of `/proc/self/status`.
/// Returns the value in kilobytes, or `None` if the line is absent/malformed.
pub fn parse_vmrss(status: &str) -> Option<i64> {
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            return rest
                .split_whitespace()
                .next()
                .and_then(|v| v.parse::<i64>().ok());
        }
    }
    None
}

/// Parse the cgroup v2 path for the calling process from the contents of
/// `/proc/self/cgroup`.
///
/// The cgroup v2 unified hierarchy always uses `0::` as the hierarchy ID.
/// Returns the path component (e.g. `/system.slice/lantern-harness.service`),
/// or `None` when no `0::` entry is present (cgroup v1 or no cgroup mount).
///
/// Pure function — tested on all platforms.
#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
pub fn parse_cgroup_v2_path(proc_self_cgroup: &str) -> Option<String> {
    for line in proc_self_cgroup.lines() {
        // Format: "hierarchy-id:subsystems:path"  — cgroup v2 is always "0::"
        if let Some(rest) = line.strip_prefix("0::") {
            let path = rest.trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

/// Parse `memory.current` — a single decimal integer (bytes).
/// Returns `None` on parse failure or when the file contains `"max"`.
///
/// Pure function — tested on all platforms.
#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
pub fn parse_memory_current(contents: &str) -> Option<i64> {
    let s = contents.trim();
    if s == "max" {
        return None;
    }
    s.parse::<i64>().ok()
}

/// Parse `cpu.stat` — a newline-separated list of `key value` pairs.
///
/// Returns the `usage_usec` field (cumulative CPU time in microseconds),
/// or `None` if the field is absent.
///
/// Pure function — tested on all platforms.
#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
pub fn parse_cpu_stat_usage_usec(contents: &str) -> Option<i64> {
    for line in contents.lines() {
        if let Some(rest) = line.strip_prefix("usage_usec ") {
            return rest.trim().parse::<i64>().ok();
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Linux-only: async cgroup v2 reader.
// The parsing functions above are pure and tested on all platforms; only the
// file I/O that reads from /sys/fs/cgroup is gated on Linux.
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
pub mod cgroup_v2 {
    use super::{parse_cgroup_v2_path, parse_cpu_stat_usage_usec, parse_memory_current};

    pub struct CgroupSnapshot {
        /// Current memory usage in bytes (`memory.current`).
        pub memory_bytes: i64,
        /// Cumulative CPU time in microseconds (`cpu.stat usage_usec`).
        pub cpu_usage_usec: i64,
    }

    /// Read a cgroup v2 snapshot for the current process.
    ///
    /// Returns `None` when:
    /// - `/proc/self/cgroup` is unreadable or contains no `0::` entry,
    /// - the cgroup directory does not exist under `/sys/fs/cgroup`, or
    /// - neither `memory.current` nor `cpu.stat` is readable.
    pub async fn sample() -> Option<CgroupSnapshot> {
        let proc_cgroup = tokio::fs::read_to_string("/proc/self/cgroup").await.ok()?;
        let cg_path = parse_cgroup_v2_path(&proc_cgroup)?;

        let cg_dir = format!("/sys/fs/cgroup{cg_path}");

        let memory_bytes = tokio::fs::read_to_string(format!("{cg_dir}/memory.current"))
            .await
            .ok()
            .and_then(|s| parse_memory_current(&s))
            .unwrap_or(0);

        let cpu_usage_usec = tokio::fs::read_to_string(format!("{cg_dir}/cpu.stat"))
            .await
            .ok()
            .and_then(|s| parse_cpu_stat_usage_usec(&s))
            .unwrap_or(0);

        Some(CgroupSnapshot {
            memory_bytes,
            cpu_usage_usec,
        })
    }
}

// ---------------------------------------------------------------------------
// Tests — pure parsing functions only; no I/O, runs on all platforms.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- parse_vmrss ----

    #[test]
    fn vmrss_parsed_correctly() {
        let status = "Name:\tlantern-harness\nVmRSS:\t  4096 kB\nVmPeak:\t 8192 kB\n";
        assert_eq!(parse_vmrss(status), Some(4096));
    }

    #[test]
    fn vmrss_absent_returns_none() {
        let status = "Name:\tlantern-harness\nVmPeak:\t 8192 kB\n";
        assert_eq!(parse_vmrss(status), None);
    }

    #[test]
    fn vmrss_malformed_returns_none() {
        let status = "VmRSS:\tnot-a-number kB\n";
        assert_eq!(parse_vmrss(status), None);
    }

    // ---- parse_cgroup_v2_path ----

    #[test]
    fn cgroup_v2_path_extracted() {
        let contents =
            "12:blkio:/system.slice\n0::/system.slice/lantern-harness.service\n1:cpu:/\n";
        assert_eq!(
            parse_cgroup_v2_path(contents),
            Some("/system.slice/lantern-harness.service".to_string())
        );
    }

    #[test]
    fn cgroup_v2_root_path() {
        // A process running at the root cgroup.
        let contents = "0::/\n";
        assert_eq!(parse_cgroup_v2_path(contents), Some("/".to_string()));
    }

    #[test]
    fn cgroup_v2_path_absent_in_v1_only() {
        // cgroup v1 only — no 0:: line.
        let contents = "1:cpu:/\n2:memory:/user.slice\n";
        assert_eq!(parse_cgroup_v2_path(contents), None);
    }

    #[test]
    fn cgroup_v2_empty_path_returns_none() {
        // Malformed: hierarchy 0 with an empty path.
        let contents = "0::\n";
        assert_eq!(parse_cgroup_v2_path(contents), None);
    }

    // ---- parse_memory_current ----

    #[test]
    fn memory_current_parsed() {
        assert_eq!(parse_memory_current("134217728\n"), Some(134_217_728));
    }

    #[test]
    fn memory_current_zero() {
        assert_eq!(parse_memory_current("0\n"), Some(0));
    }

    #[test]
    fn memory_current_max_returns_none() {
        // "max" means no limit is set — treat as no data.
        assert_eq!(parse_memory_current("max\n"), None);
    }

    #[test]
    fn memory_current_malformed_returns_none() {
        assert_eq!(parse_memory_current("not-a-number\n"), None);
    }

    // ---- parse_cpu_stat_usage_usec ----

    #[test]
    fn cpu_stat_usage_usec_parsed() {
        let stat =
            "usage_usec 123456789\nuser_usec 100000000\nsystem_usec 23456789\nnr_periods 0\n";
        assert_eq!(parse_cpu_stat_usage_usec(stat), Some(123_456_789));
    }

    #[test]
    fn cpu_stat_usage_usec_absent_returns_none() {
        let stat = "user_usec 100000000\nsystem_usec 23456789\n";
        assert_eq!(parse_cpu_stat_usage_usec(stat), None);
    }

    #[test]
    fn cpu_stat_usage_usec_zero() {
        let stat = "usage_usec 0\n";
        assert_eq!(parse_cpu_stat_usage_usec(stat), Some(0));
    }

    #[test]
    fn cpu_stat_usage_usec_malformed_returns_none() {
        let stat = "usage_usec bad\n";
        assert_eq!(parse_cpu_stat_usage_usec(stat), None);
    }
}
