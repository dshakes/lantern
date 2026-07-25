use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use dashmap::DashMap;
use tokio::sync::Mutex;

use crate::backend::{Handle, RuntimeBackend};
use crate::proto::{IsolationClass, ScheduleRequest};

/// A warm handle held in the pool, with creation timestamp for TTL reaping.
///
/// `image` and `size_key` are carried so the pool can publish an inventory in
/// the shape the SCHEDULER scores against. The internal `PoolKey` is keyed by
/// bundle_digest, which the scheduler has never seen — reporting that would be
/// useless to it.
#[derive(Debug)]
struct WarmHandle {
    handle: Handle,
    created_at: Instant,
    /// `ScheduleRequest.image` — matches `AgentSpec.image_digest` on the wire.
    image: String,
    /// Canonical `"{vcpu}/{memory}"` size key. MUST stay byte-identical to
    /// `cluster.SizeKey` in the scheduler or warm-pool scoring silently misses.
    size_key: String,
}

/// Key for indexing warm handles: (isolation_class, hex-encoded bundle_digest).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PoolKey {
    isolation_class: IsolationClass,
    bundle_digest: String,
}

impl PoolKey {
    fn new(isolation_class: IsolationClass, bundle_digest: &[u8]) -> Self {
        Self {
            isolation_class,
            bundle_digest: hex::encode(bundle_digest),
        }
    }
}

/// Canonical size key, mirroring `cluster.SizeKey` on the scheduler side.
pub fn size_key(limits: &crate::proto::ResourceLimits) -> String {
    format!("{}/{}", limits.cpu, limits.memory)
}

/// Wire name for an isolation class, matching the Go protobuf `String()`
/// output the scheduler builds its composite key from.
fn isolation_wire_name(class: IsolationClass) -> &'static str {
    match class {
        IsolationClass::Unspecified => "ISOLATION_UNSPECIFIED",
        IsolationClass::Trusted => "ISOLATION_TRUSTED",
        IsolationClass::Standard => "ISOLATION_STANDARD",
        IsolationClass::Untrusted => "ISOLATION_UNTRUSTED",
        IsolationClass::Hostile => "ISOLATION_HOSTILE",
        IsolationClass::Wasm => "ISOLATION_WASM",
        IsolationClass::Devcontainer => "ISOLATION_DEVCONTAINER",
    }
}

/// Build the composite warm-pool key the scheduler's `warmPoolExactKey`
/// produces: `<image>@<ISOLATION_NAME>@<vcpu>/<memory>`.
fn exact_key(image: &str, class: IsolationClass, size: &str) -> String {
    format!("{}@{}@{}", image, isolation_wire_name(class), size)
}

/// The node's warm-pool inventory, in the two shapes the scheduler scores on.
#[derive(Debug, Default, Clone)]
pub struct WarmInventory {
    /// `<image>@<class>@<size>` → count.
    pub exact: std::collections::HashMap<String, i32>,
    /// `<image>` → count.
    pub image_only: std::collections::HashMap<String, i32>,
}

/// Hex-encode bytes without pulling in the `hex` crate.
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Configuration for the warm pool.
#[derive(Clone, Debug)]
pub struct PoolConfig {
    /// Maximum number of warm handles to keep per (isolation_class, bundle_digest).
    pub max_warm_per_key: usize,
    /// How long a warm handle can sit idle before being reaped.
    pub idle_ttl: Duration,
    /// How often the reaper runs.
    pub reap_interval: Duration,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            max_warm_per_key: 3,
            idle_ttl: Duration::from_secs(300),
            reap_interval: Duration::from_secs(30),
        }
    }
}

/// Manages a pool of pre-warmed sandbox instances to reduce cold start latency.
///
/// The pool is keyed by `(IsolationClass, bundle_digest)`. When a schedule
/// request comes in, we first check if a matching warm handle exists; if so,
/// we return it immediately (near-zero cold start). Otherwise, we fall back
/// to a cold start through the backend.
pub struct WarmPool {
    pool: DashMap<PoolKey, Vec<WarmHandle>>,
    config: PoolConfig,
    backend: Arc<dyn RuntimeBackend>,
    /// Guards pre-warm operations so we don't spawn duplicates.
    prewarm_lock: Mutex<()>,
}

impl WarmPool {
    pub fn new(backend: Arc<dyn RuntimeBackend>, config: PoolConfig) -> Self {
        Self {
            pool: DashMap::new(),
            config,
            backend,
            prewarm_lock: Mutex::new(()),
        }
    }

    /// Try to acquire a warm handle matching the request.
    /// Returns `None` if no warm handle is available (caller should cold-start).
    pub fn acquire(&self, req: &ScheduleRequest) -> Option<Handle> {
        let key = PoolKey::new(req.isolation_class, &req.bundle_digest);

        let mut entry = self.pool.get_mut(&key)?;
        let handles = entry.value_mut();

        // Pop the most recently added (LIFO — most likely to still be warm).
        let warm = handles.pop()?;

        tracing::info!(
            handle_id = %warm.handle.id,
            age_secs = warm.created_at.elapsed().as_secs(),
            "acquired warm handle from pool"
        );

        // Clean up empty vec to save memory.
        if handles.is_empty() {
            drop(entry);
            self.pool.remove(&key);
        }

        Some(warm.handle)
    }

    /// Snapshot the warm pool in the shape the scheduler scores against.
    ///
    /// Warm-pool match is the highest-weighted placement signal (0.40). The
    /// heartbeat used to send empty maps unconditionally, so that entire term
    /// evaluated to zero on every placement — the warm pool existed but never
    /// influenced where anything landed.
    pub fn inventory(&self) -> WarmInventory {
        let mut inv = WarmInventory::default();
        for entry in self.pool.iter() {
            let class = entry.key().isolation_class;
            for wh in entry.value() {
                if wh.image.is_empty() {
                    continue; // nothing the scheduler could match on
                }
                *inv.exact
                    .entry(exact_key(&wh.image, class, &wh.size_key))
                    .or_insert(0) += 1;
                *inv.image_only.entry(wh.image.clone()).or_insert(0) += 1;
            }
        }
        inv
    }

    /// Return a handle to the pool after use, or discard if pool is full.
    ///
    /// Takes the originating request so the warm entry records the image and
    /// size the scheduler will later try to match against.
    pub fn release(&self, req: &ScheduleRequest, handle: Handle) {
        let key = PoolKey::new(req.isolation_class, &req.bundle_digest);
        let warm = WarmHandle {
            handle: handle.clone(),
            created_at: Instant::now(),
            image: req.image.clone(),
            size_key: size_key(&req.limits),
        };

        let mut entry = self.pool.entry(key).or_default();
        let handles = entry.value_mut();

        if handles.len() < self.config.max_warm_per_key {
            tracing::info!(
                handle_id = %handle.id,
                pool_size = handles.len() + 1,
                "returned handle to warm pool"
            );
            handles.push(warm);
        } else {
            tracing::debug!(
                handle_id = %handle.id,
                "warm pool full for key, discarding handle"
            );
            // In a real implementation, we'd clean up the sandbox here.
        }
    }

    /// Acquire a warm handle or fall back to a cold start via the backend.
    pub async fn acquire_or_cold_start(&self, req: &ScheduleRequest) -> Result<Handle> {
        if let Some(handle) = self.acquire(req) {
            return Ok(handle);
        }

        tracing::info!(
            run_id = %req.run_id,
            "no warm handle available, cold starting"
        );
        self.backend.schedule(req).await
    }

    /// Background task: reap warm handles that have exceeded their idle TTL.
    pub async fn reap(&self) {
        let ttl = self.config.idle_ttl;
        let mut reaped = 0usize;

        // Collect keys first to avoid holding refs during mutation.
        let keys: Vec<PoolKey> = self.pool.iter().map(|e| e.key().clone()).collect();

        for key in keys {
            if let Some(mut entry) = self.pool.get_mut(&key) {
                let before = entry.value().len();
                entry.value_mut().retain(|wh| wh.created_at.elapsed() < ttl);
                let after = entry.value().len();
                reaped += before - after;

                if after == 0 {
                    drop(entry);
                    self.pool.remove(&key);
                }
            }
        }

        if reaped > 0 {
            tracing::info!(reaped, "reaped idle warm handles");
        }
    }

    /// Pre-warm a number of instances for a given isolation class and bundle.
    pub async fn prewarm(&self, req: &ScheduleRequest, count: usize) -> Result<usize> {
        let _lock = self.prewarm_lock.lock().await;
        let key = PoolKey::new(req.isolation_class, &req.bundle_digest);

        let current = self.pool.get(&key).map(|e| e.value().len()).unwrap_or(0);

        let needed = count.saturating_sub(current);
        let mut created = 0usize;

        for _ in 0..needed {
            match self.backend.schedule(req).await {
                Ok(handle) => {
                    self.release(req, handle);
                    created += 1;
                }
                Err(e) => {
                    tracing::warn!(error = %e, "failed to pre-warm instance");
                    break;
                }
            }
        }

        tracing::info!(created, needed, "pre-warm complete");
        Ok(created)
    }

    /// Start the background reaper loop. Call this once at startup.
    pub fn start_reaper(self: &Arc<Self>) {
        let pool = Arc::clone(self);
        let interval = pool.config.reap_interval;

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;
                pool.reap().await;
            }
        });
    }

    /// Current total number of warm handles across all keys.
    pub fn total_warm(&self) -> usize {
        self.pool.iter().map(|e| e.value().len()).sum()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    #![allow(dead_code)]
    use super::*;
    use crate::proto::{IsolationClass, ScheduleRequest};
    use futures::stream::BoxStream;

    // --- minimal stub backend ---

    pub(super) struct StubBackend {
        call_count: std::sync::atomic::AtomicUsize,
    }

    impl StubBackend {
        pub(super) fn new() -> Arc<Self> {
            Arc::new(Self {
                call_count: std::sync::atomic::AtomicUsize::new(0),
            })
        }
    }

    #[async_trait::async_trait]
    impl RuntimeBackend for StubBackend {
        async fn schedule(&self, req: &ScheduleRequest) -> anyhow::Result<Handle> {
            self.call_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(Handle {
                id: format!("stub-{}", req.run_id),
                node_name: "node-stub".to_string(),
                cold_start_ms: 50.0,
            })
        }

        async fn cancel(&self, _handle_id: &str, _reason: &str) -> anyhow::Result<()> {
            Ok(())
        }

        async fn stream(
            &self,
            _handle_id: &str,
        ) -> anyhow::Result<BoxStream<'static, crate::proto::RuntimeEvent>> {
            use futures::stream;
            Ok(Box::pin(stream::empty()))
        }

        async fn snapshot(
            &self,
            _req: &crate::proto::SnapshotRequest,
        ) -> anyhow::Result<crate::backend::SnapshotInfo> {
            Ok(crate::backend::SnapshotInfo {
                snapshot_uri: "stub://snapshot".to_string(),
                size_bytes: 0,
            })
        }

        async fn restore(
            &self,
            _snapshot_uri: &str,
            _req: &crate::proto::RestoreRequest,
        ) -> anyhow::Result<Handle> {
            Ok(Handle {
                id: "restored-stub".to_string(),
                node_name: "node-stub".to_string(),
                cold_start_ms: 10.0,
            })
        }

        fn name(&self) -> &'static str {
            "stub"
        }
    }

    pub(super) fn make_req(run_id: &str, digest: &[u8], iso: IsolationClass) -> ScheduleRequest {
        ScheduleRequest {
            run_id: run_id.to_string(),
            tenant_id: "test-tenant".to_string(),
            bundle_uri: String::new(),
            bundle_digest: digest.to_vec(),
            isolation_class: iso,
            limits: crate::proto::ResourceLimits::default(),
            env: std::collections::HashMap::new(),
            secrets: vec![],
            input: serde_json::Value::Null,
            command: vec![],
            args: vec![],
            image: String::new(),
            network_policy: crate::proto::NetworkPolicyClass::default(),
            egress_rules: vec![],
            confidential: false,
        }
    }

    // ---- acquire / release ----

    #[test]
    fn empty_pool_acquire_returns_none() {
        let backend = StubBackend::new();
        let pool = WarmPool::new(backend, PoolConfig::default());
        let req = make_req("r1", b"digest1", IsolationClass::Standard);
        assert!(pool.acquire(&req).is_none());
    }

    #[test]
    fn release_then_acquire_roundtrip() {
        let backend = StubBackend::new();
        let pool = WarmPool::new(backend, PoolConfig::default());
        let req = make_req("r1", b"digest1", IsolationClass::Standard);

        let handle = Handle {
            id: "h-1".to_string(),
            node_name: "node-1".to_string(),
            cold_start_ms: 20.0,
        };
        pool.release(&req, handle);
        assert_eq!(pool.total_warm(), 1);

        let acquired = pool.acquire(&req);
        assert!(acquired.is_some());
        assert_eq!(acquired.unwrap().id, "h-1");
        assert_eq!(pool.total_warm(), 0);
    }

    #[test]
    fn acquire_uses_lifo_order() {
        let backend = StubBackend::new();
        let pool = WarmPool::new(backend, PoolConfig::default());
        let req = make_req("r1", b"dg", IsolationClass::Standard);

        for i in 0..3u32 {
            pool.release(
                &req,
                Handle {
                    id: format!("h-{i}"),
                    node_name: "n".to_string(),
                    cold_start_ms: 10.0,
                },
            );
        }

        // LIFO: last inserted (h-2) comes out first.
        let first = pool.acquire(&req).unwrap();
        assert_eq!(first.id, "h-2");
        let second = pool.acquire(&req).unwrap();
        assert_eq!(second.id, "h-1");
    }

    #[test]
    fn release_at_capacity_discards_extra() {
        let backend = StubBackend::new();
        let config = PoolConfig {
            max_warm_per_key: 2,
            idle_ttl: Duration::from_secs(300),
            reap_interval: Duration::from_secs(30),
        };
        let pool = WarmPool::new(backend, config);
        let req = make_req("r1", b"dg", IsolationClass::Standard);

        for i in 0..5u32 {
            pool.release(
                &req,
                Handle {
                    id: format!("h-{i}"),
                    node_name: "n".to_string(),
                    cold_start_ms: 10.0,
                },
            );
        }

        // Only max_warm_per_key=2 retained.
        assert_eq!(pool.total_warm(), 2);
    }

    #[test]
    fn different_digests_keyed_separately() {
        let backend = StubBackend::new();
        let pool = WarmPool::new(backend, PoolConfig::default());

        let req_a = make_req("r1", b"digest-a", IsolationClass::Standard);
        let req_b = make_req("r2", b"digest-b", IsolationClass::Standard);

        pool.release(
            &req_a,
            Handle {
                id: "for-a".to_string(),
                node_name: "n".to_string(),
                cold_start_ms: 10.0,
            },
        );

        // Acquiring with req_b should not return the handle for digest-a.
        assert!(pool.acquire(&req_b).is_none());
        assert!(pool.acquire(&req_a).is_some());
    }

    #[test]
    fn different_isolation_classes_keyed_separately() {
        let backend = StubBackend::new();
        let pool = WarmPool::new(backend, PoolConfig::default());
        let digest = b"same-digest";

        pool.release(
            &make_req("r1", digest, IsolationClass::Standard),
            Handle {
                id: "standard-h".to_string(),
                node_name: "n".to_string(),
                cold_start_ms: 10.0,
            },
        );

        let hostile_req = make_req("r1", digest, IsolationClass::Hostile);
        assert!(pool.acquire(&hostile_req).is_none());

        let standard_req = make_req("r1", digest, IsolationClass::Standard);
        assert!(pool.acquire(&standard_req).is_some());
    }

    // ---- reap ----

    #[tokio::test]
    async fn reap_removes_expired_handles() {
        let backend = StubBackend::new();
        let config = PoolConfig {
            max_warm_per_key: 10,
            idle_ttl: Duration::from_millis(1), // expire almost immediately
            reap_interval: Duration::from_secs(60),
        };
        let pool = WarmPool::new(backend, config);
        let req = make_req("r1", b"dg", IsolationClass::Standard);

        pool.release(
            &req,
            Handle {
                id: "old-handle".to_string(),
                node_name: "n".to_string(),
                cold_start_ms: 10.0,
            },
        );
        assert_eq!(pool.total_warm(), 1);

        tokio::time::sleep(Duration::from_millis(5)).await;
        pool.reap().await;

        assert_eq!(pool.total_warm(), 0);
    }

    #[tokio::test]
    async fn reap_keeps_fresh_handles() {
        let backend = StubBackend::new();
        let config = PoolConfig {
            max_warm_per_key: 10,
            idle_ttl: Duration::from_secs(300),
            reap_interval: Duration::from_secs(60),
        };
        let pool = WarmPool::new(backend, config);
        let req = make_req("r1", b"dg", IsolationClass::Standard);

        pool.release(
            &req,
            Handle {
                id: "fresh-handle".to_string(),
                node_name: "n".to_string(),
                cold_start_ms: 10.0,
            },
        );
        pool.reap().await;
        assert_eq!(pool.total_warm(), 1);
    }

    // ---- acquire_or_cold_start ----

    #[tokio::test]
    async fn acquire_or_cold_start_uses_warm_handle_when_available() {
        let backend = StubBackend::new();
        let dyn_backend: Arc<dyn RuntimeBackend> = Arc::clone(&backend) as Arc<dyn RuntimeBackend>;
        let pool = WarmPool::new(dyn_backend, PoolConfig::default());
        let req = make_req("r1", b"dg", IsolationClass::Standard);

        pool.release(
            &req,
            Handle {
                id: "warm-h".to_string(),
                node_name: "n".to_string(),
                cold_start_ms: 5.0,
            },
        );

        let h = pool.acquire_or_cold_start(&req).await.unwrap();
        assert_eq!(h.id, "warm-h");
        // Backend should NOT have been called.
        assert_eq!(
            backend.call_count.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
    }

    #[tokio::test]
    async fn acquire_or_cold_start_falls_back_to_backend() {
        let backend = StubBackend::new();
        let dyn_backend: Arc<dyn RuntimeBackend> = Arc::clone(&backend) as Arc<dyn RuntimeBackend>;
        let pool = WarmPool::new(dyn_backend, PoolConfig::default());
        let req = make_req("r1", b"dg", IsolationClass::Standard);

        let h = pool.acquire_or_cold_start(&req).await.unwrap();
        assert_eq!(h.id, "stub-r1");
        assert_eq!(
            backend.call_count.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    // ---- hex encoding (internal) ----

    #[test]
    fn pool_key_hex_encodes_digest() {
        let key = PoolKey::new(IsolationClass::Standard, &[0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(key.bundle_digest, "deadbeef");
    }

    #[test]
    fn pool_key_empty_digest() {
        let key = PoolKey::new(IsolationClass::Standard, &[]);
        assert_eq!(key.bundle_digest, "");
    }
}

// ---------------------------------------------------------------------------
// Cross-service key-parity tests.
//
// The warm-pool inventory only influences placement if the key the MANAGER
// emits is byte-identical to the key the SCHEDULER builds in
// `scoring.warmPoolExactKey`. There is no shared type across the language
// boundary, so both sides pin the same literal; a change to either format
// fails one of the two tests instead of silently zeroing the 0.40-weighted
// warm-pool term.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod key_parity_tests {
    use super::*;
    use crate::proto::ResourceLimits;

    #[test]
    fn exact_key_matches_scheduler_format() {
        // Mirrors scoring_test.go: TestWarmPoolExactKey_ManagerParity
        assert_eq!(
            exact_key("demo:latest", IsolationClass::Trusted, "500m/512Mi"),
            "demo:latest@ISOLATION_TRUSTED@500m/512Mi"
        );
        assert_eq!(
            exact_key("img@sha256:ab", IsolationClass::Untrusted, "1/1Gi"),
            "img@sha256:ab@ISOLATION_UNTRUSTED@1/1Gi"
        );
    }

    #[test]
    fn size_key_matches_cluster_sizekey() {
        let limits = ResourceLimits {
            cpu: "500m".to_string(),
            memory: "512Mi".to_string(),
            ..Default::default()
        };
        assert_eq!(size_key(&limits), "500m/512Mi");
    }

    #[test]
    fn inventory_counts_warm_handles_under_both_keys() {
        let backend = tests::StubBackend::new();
        let pool = WarmPool::new(backend, PoolConfig::default());

        let mut req = tests::make_req("r1", b"dg", IsolationClass::Trusted);
        req.image = "demo:latest".to_string();
        req.limits.cpu = "500m".to_string();
        req.limits.memory = "512Mi".to_string();

        pool.release(
            &req,
            Handle {
                id: "h-1".to_string(),
                node_name: "n".to_string(),
                cold_start_ms: 10.0,
            },
        );

        let inv = pool.inventory();
        assert_eq!(
            inv.exact.get("demo:latest@ISOLATION_TRUSTED@500m/512Mi"),
            Some(&1),
            "exact key must match what the scheduler looks up"
        );
        assert_eq!(inv.image_only.get("demo:latest"), Some(&1));
    }

    /// A warm handle with no image is unmatchable by the scheduler, so it must
    /// not be advertised — advertising it would inflate the warm score for a
    /// slot no workload can actually reuse.
    #[test]
    fn imageless_handles_are_not_advertised() {
        let backend = tests::StubBackend::new();
        let pool = WarmPool::new(backend, PoolConfig::default());
        let req = tests::make_req("r1", b"dg", IsolationClass::Trusted); // image: ""

        pool.release(
            &req,
            Handle {
                id: "h-1".to_string(),
                node_name: "n".to_string(),
                cold_start_ms: 10.0,
            },
        );

        let inv = pool.inventory();
        assert!(
            inv.exact.is_empty(),
            "imageless handle must not be advertised"
        );
        assert!(inv.image_only.is_empty());
    }
}
