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
