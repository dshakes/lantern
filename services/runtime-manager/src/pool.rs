use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use dashmap::DashMap;
use tokio::sync::Mutex;

use crate::backend::{Handle, RuntimeBackend};
use crate::proto::{IsolationClass, ScheduleRequest};

/// A warm handle held in the pool, with creation timestamp for TTL reaping.
#[derive(Debug)]
struct WarmHandle {
    handle: Handle,
    created_at: Instant,
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

    /// Return a handle to the pool after use, or discard if pool is full.
    pub fn release(&self, isolation_class: IsolationClass, bundle_digest: &[u8], handle: Handle) {
        let key = PoolKey::new(isolation_class, bundle_digest);
        let warm = WarmHandle {
            handle: handle.clone(),
            created_at: Instant::now(),
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
                    self.release(req.isolation_class, &req.bundle_digest, handle);
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
    use super::*;
    use crate::proto::{IsolationClass, ScheduleRequest};
    use futures::stream::BoxStream;

    // --- minimal stub backend ---

    struct StubBackend {
        call_count: std::sync::atomic::AtomicUsize,
    }

    impl StubBackend {
        fn new() -> Arc<Self> {
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

    fn make_req(run_id: &str, digest: &[u8], iso: IsolationClass) -> ScheduleRequest {
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
        pool.release(req.isolation_class, &req.bundle_digest, handle);
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
                req.isolation_class,
                &req.bundle_digest,
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
                req.isolation_class,
                &req.bundle_digest,
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
            req_a.isolation_class,
            &req_a.bundle_digest,
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
            IsolationClass::Standard,
            digest,
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
            req.isolation_class,
            &req.bundle_digest,
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
            req.isolation_class,
            &req.bundle_digest,
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
            req.isolation_class,
            &req.bundle_digest,
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
