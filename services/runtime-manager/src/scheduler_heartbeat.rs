//! Self-registration + periodic heartbeat to the runtime-scheduler.
//!
//! Posts node capacity + warm-pool state to the scheduler's REST gateway
//! every `INTERVAL`. Used by the scheduler's placement engine to know
//! what nodes exist, how loaded they are, and which images are warm.
//!
//! When `SCHEDULER_URL` is empty the loop short-circuits — useful for
//! standalone dev where the scheduler isn't running.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::handle_registry::HandleRegistry;
use crate::pool::WarmPool;

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
    /// Confidential-compute capability, advertised so the scheduler only places
    /// `confidential` workloads on CC-capable nodes.
    cc_capable: bool,
    cc_tech: String,
    /// Wire-level vm_ids this node currently believes are live.
    ///
    /// This is the node's full inventory, not a delta — the scheduler
    /// reconciles against it, so a lost message self-heals on the next beat.
    /// Sending it is what lets the scheduler notice a workload that exited on
    /// its own; without it the only path to TERMINATED was an explicit
    /// operator Terminate, and every completed batch agent leaked a phantom
    /// RUNNING row into placement and quota accounting forever.
    vms: Vec<String>,
    /// True when `vms` is a real inventory. Absent/false means "no opinion" and
    /// the scheduler must NOT reconcile — this keeps older managers, which do
    /// not send the field at all, from having their VMs mass-terminated.
    reports_inventory: bool,
}

/// Total capacity of this node, measured once at startup.
#[derive(Clone, Copy, Debug)]
struct NodeCapacity {
    vcpu_millis: i64,
    memory_bytes: i64,
}

/// Measure real node capacity, with env overrides for containerised nodes
/// where the host's totals are not the cgroup's.
///
/// This used to be hardcoded to 8 vCPU / 8 GiB regardless of the machine, so
/// the scheduler's capacity filter and bin-packing scored against a constant.
/// On a smaller node that silently oversubscribes until workloads OOM.
fn measure_capacity() -> NodeCapacity {
    let vcpu_millis = std::env::var("LANTERN_NODE_VCPU_MILLIS")
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get() as i64 * 1000)
                .unwrap_or(1000)
        });

    let memory_bytes = std::env::var("LANTERN_NODE_MEMORY_BYTES")
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .filter(|&n| n > 0)
        .or_else(read_total_memory_bytes)
        .unwrap_or_else(|| {
            tracing::warn!(
                "could not determine node memory; falling back to 8GiB. Set \
                 LANTERN_NODE_MEMORY_BYTES so placement does not oversubscribe this node"
            );
            8 * 1024 * 1024 * 1024
        });

    NodeCapacity {
        vcpu_millis,
        memory_bytes,
    }
}

/// Read MemTotal from /proc/meminfo (Linux). `None` elsewhere — macOS is a
/// dev-only host, and the env override covers it.
fn read_total_memory_bytes() -> Option<i64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in meminfo.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: i64 = rest.trim().trim_end_matches(" kB").trim().parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

/// Parse a Kubernetes-style CPU quantity ("500m", "2") into millicores.
fn parse_vcpu_millis(s: &str) -> i64 {
    let s = s.trim();
    if s.is_empty() {
        return 0;
    }
    if let Some(m) = s.strip_suffix('m') {
        return m.trim().parse::<i64>().unwrap_or(0);
    }
    s.parse::<f64>().map(|v| (v * 1000.0) as i64).unwrap_or(0)
}

/// Parse a Kubernetes-style memory quantity ("512Mi", "1Gi", "1000000") to bytes.
fn parse_memory_bytes(s: &str) -> i64 {
    let s = s.trim();
    if s.is_empty() {
        return 0;
    }
    for (suffix, mult) in [
        ("Ki", 1024_i64),
        ("Mi", 1024 * 1024),
        ("Gi", 1024 * 1024 * 1024),
        ("Ti", 1024_i64 * 1024 * 1024 * 1024),
        ("K", 1000),
        ("M", 1000 * 1000),
        ("G", 1000 * 1000 * 1000),
    ] {
        if let Some(v) = s.strip_suffix(suffix) {
            return v
                .trim()
                .parse::<f64>()
                .map(|f| (f * mult as f64) as i64)
                .unwrap_or(0);
        }
    }
    s.parse::<i64>().unwrap_or(0)
}

/// Capacity still free after subtracting what running workloads are committed
/// to. Bin-packing needs committed-vs-total, not raw host idle.
fn free_capacity(total: NodeCapacity, registry: &HandleRegistry) -> (i64, i64) {
    let mut used_vcpu = 0_i64;
    let mut used_mem = 0_i64;
    for (_, info) in registry.list_all() {
        used_vcpu += parse_vcpu_millis(&info.resource_limits.cpu);
        used_mem += parse_memory_bytes(&info.resource_limits.memory);
    }
    (
        (total.vcpu_millis - used_vcpu).max(0),
        (total.memory_bytes - used_mem).max(0),
    )
}

#[derive(Clone)]
pub struct HeartbeatConfig {
    pub scheduler_url: String,
    pub token: String,
    pub node_name: String,
    pub advertise_addr: String,
    pub region: String,
    pub zone: String,
    /// True when this node can run confidential-compute workloads (Kata-CC
    /// RuntimeClass configured + cluster-present). Advertised to the scheduler.
    pub cc_capable: bool,
    /// CC hardware technology this node exposes (e.g. "sev-snp" / "tdx"); "" when
    /// unknown. Advertised alongside `cc_capable` for the receipt/evidence trail.
    pub cc_tech: String,
    /// Live handle registry — source of the VM inventory and of committed
    /// capacity. `None` disables both (inventory is then omitted entirely and
    /// the scheduler will not reconcile).
    pub registry: Option<Arc<HandleRegistry>>,
    /// Warm pool, for the warm-pool inventory the placement engine weights at
    /// 0.40. `None` reports an empty pool.
    pub pool: Option<Arc<WarmPool>>,
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
        let capacity = measure_capacity();
        tracing::info!(
            vcpu_millis = capacity.vcpu_millis,
            memory_bytes = capacity.memory_bytes,
            "measured node capacity for placement"
        );

        loop {
            // Resource accounting: in real prod we'd read /proc/meminfo,
            // cgroups, and per-backend warm-pool counts. For now we report
            // sane single-node defaults so the scheduler will place onto us.
            let (free_vcpu_millis, free_memory_bytes) = match cfg.registry.as_ref() {
                Some(reg) => free_capacity(capacity, reg),
                None => (capacity.vcpu_millis, capacity.memory_bytes),
            };
            let warm = cfg.pool.as_ref().map(|p| p.inventory()).unwrap_or_default();

            let body = HeartbeatBody {
                name: cfg.node_name.clone(),
                address: cfg.advertise_addr.clone(),
                region: cfg.region.clone(),
                continent: cfg.region.clone(),
                availability_zone: cfg.zone.clone(),
                is_spot: false,
                is_arm: cfg!(target_arch = "aarch64"),
                free_vcpu_millis,
                free_memory_bytes,
                warm_pool_exact: warm.exact,
                warm_pool_image_only: warm.image_only,
                recent_oom_count: 0,
                recent_kernel_events: 0,
                cc_capable: cfg.cc_capable,
                cc_tech: cfg.cc_tech.clone(),
                vms: cfg
                    .registry
                    .as_ref()
                    .map(|r| r.live_vm_ids())
                    .unwrap_or_default(),
                reports_inventory: cfg.registry.is_some(),
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
