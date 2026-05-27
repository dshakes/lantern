//! Self-registration + periodic heartbeat to the runtime-scheduler.
//!
//! Posts node capacity + warm-pool state to the scheduler's REST gateway
//! every `INTERVAL`. Used by the scheduler's placement engine to know
//! what nodes exist, how loaded they are, and which images are warm.
//!
//! When `SCHEDULER_URL` is empty the loop short-circuits — useful for
//! standalone dev where the scheduler isn't running.

use std::time::Duration;

use serde::Serialize;

const INTERVAL: Duration = Duration::from_secs(30);
const FIRST_BEAT_DELAY: Duration = Duration::from_millis(200);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize)]
struct HeartbeatBody {
    name: String,
    address: String,
    region: String,
    continent: String,
    availability_zone: String,
    is_spot: bool,
    is_arm: bool,
    free_vcpu_millis: i64,
    free_memory_bytes: i64,
    warm_pool_exact: std::collections::HashMap<String, i32>,
    warm_pool_image_only: std::collections::HashMap<String, i32>,
    recent_oom_count: i32,
    recent_kernel_events: i32,
}

#[derive(Clone)]
pub struct HeartbeatConfig {
    pub scheduler_url: String,
    pub token: String,
    pub node_name: String,
    pub advertise_addr: String,
    pub region: String,
    pub zone: String,
}

/// Spawn the heartbeat loop. Returns immediately; the loop runs until the
/// process exits (or the scheduler is permanently unreachable — we keep
/// retrying with exponential backoff capped at `INTERVAL * 2`).
pub fn spawn(cfg: HeartbeatConfig) {
    if cfg.scheduler_url.is_empty() {
        tracing::info!("scheduler_url not set; skipping self-register heartbeat");
        return;
    }

    tokio::spawn(async move {
        let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "failed to build heartbeat http client");
                return;
            }
        };

        // Small upfront delay so the gRPC server is reachable before we
        // announce — avoids a window where the scheduler tries to dial us
        // before we're listening.
        tokio::time::sleep(FIRST_BEAT_DELAY).await;

        let endpoint = format!(
            "{}/v1/nodes/heartbeat",
            cfg.scheduler_url.trim_end_matches('/')
        );
        let mut backoff_ms: u64 = 500;

        loop {
            // Resource accounting: in real prod we'd read /proc/meminfo,
            // cgroups, and per-backend warm-pool counts. For now we report
            // sane single-node defaults so the scheduler will place onto us.
            let body = HeartbeatBody {
                name: cfg.node_name.clone(),
                address: cfg.advertise_addr.clone(),
                region: cfg.region.clone(),
                continent: cfg.region.clone(),
                availability_zone: cfg.zone.clone(),
                is_spot: false,
                is_arm: cfg!(target_arch = "aarch64"),
                free_vcpu_millis: 8000,                    // 8 vCPU
                free_memory_bytes: 8 * 1024 * 1024 * 1024, // 8 GiB
                warm_pool_exact: Default::default(),
                warm_pool_image_only: Default::default(),
                recent_oom_count: 0,
                recent_kernel_events: 0,
            };

            let mut req = client.post(&endpoint).json(&body);
            if !cfg.token.is_empty() {
                req = req.header("X-Scheduler-Token", &cfg.token);
            }

            match req.send().await {
                Ok(resp) if resp.status().is_success() => {
                    tracing::debug!(node = %cfg.node_name, "heartbeat ok");
                    backoff_ms = 500;
                    tokio::time::sleep(INTERVAL).await;
                }
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    tracing::warn!(status = %status, body = %body, "heartbeat rejected");
                    let sleep =
                        Duration::from_millis(backoff_ms.min(2 * INTERVAL.as_millis() as u64));
                    backoff_ms = (backoff_ms * 2).min(2 * INTERVAL.as_millis() as u64);
                    tokio::time::sleep(sleep).await;
                }
                Err(e) => {
                    tracing::warn!(error = %e, endpoint = %endpoint, "heartbeat send failed");
                    let sleep =
                        Duration::from_millis(backoff_ms.min(2 * INTERVAL.as_millis() as u64));
                    backoff_ms = (backoff_ms * 2).min(2 * INTERVAL.as_millis() as u64);
                    tokio::time::sleep(sleep).await;
                }
            }
        }
    });
}
