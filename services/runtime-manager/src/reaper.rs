//! Registry reaper — notices workloads that exited on their own.
//!
//! # Why this exists
//!
//! `HandleRegistry::deregister` had exactly zero callers outside an explicit
//! `Stop` RPC. A workload that ran to completion — the normal case for a
//! headless batch agent — stayed registered forever. That stale entry then
//! propagated: it inflated the node inventory sent to the scheduler, which
//! inflated `running_vms`, which fed both the placement scoring and the
//! per-tenant concurrency quota. The observable symptom was a node reporting
//! N running VMs with zero running containers, and tenants hitting HTTP 402
//! for capacity consumed by workloads that had finished hours earlier.
//!
//! Exit detection deliberately does NOT ride `RuntimeBackend::stream()`: that
//! stream is consumed lazily by the Logs/Stream RPCs and is single-consumer on
//! several backends, so a background subscriber would steal frames from a
//! client tailing logs. Polling liveness is slower but cannot interfere.
//!
//! # Safety
//!
//! Reaping a LIVE workload is much worse than carrying a stale entry — it
//! orphans a running container with no way to stop, bill, or terminate it. So
//! the reaper only removes a handle when the backend affirmatively answers
//! "not running". `Err` (docker unreachable, timeout) means unknown and the
//! handle is kept. Backends that cannot answer inherit the conservative
//! `is_alive` default of `Ok(true)` and are never reaped by this loop.

use std::sync::Arc;
use std::time::Duration;

use crate::backend::RuntimeBackend;
use crate::handle_registry::HandleRegistry;

/// How often to sweep the registry.
const DEFAULT_INTERVAL: Duration = Duration::from_secs(15);

/// Grace period after registration before a handle is eligible for reaping.
///
/// A container can be registered a beat before the backend reports it running.
/// Without this window a fast sweep could observe `running == false` on a
/// still-starting workload and reap it mid-spawn.
const SPAWN_GRACE: Duration = Duration::from_secs(30);

/// Read the sweep interval from `LANTERN_REAPER_INTERVAL_SECS`.
/// Values below 1s are ignored so a typo cannot spin the loop hot.
fn interval_from_env() -> Duration {
    std::env::var("LANTERN_REAPER_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|&n| n >= 1)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_INTERVAL)
}

/// Spawn the reaper loop. Runs until process exit.
pub fn spawn(registry: Arc<HandleRegistry>, backend: Arc<dyn RuntimeBackend>) {
    let interval = interval_from_env();
    tracing::info!(
        interval_secs = interval.as_secs(),
        backend = backend.name(),
        "starting registry reaper"
    );

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // A slow sweep must not cause a burst of catch-up ticks.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let reaped = sweep_once(&registry, backend.as_ref()).await;
            if reaped > 0 {
                tracing::info!(
                    reaped,
                    remaining = registry.len(),
                    "reaper: swept exited VMs"
                );
            }
        }
    });
}

/// One sweep. Returns how many handles were reaped. Exposed for tests.
pub async fn sweep_once(registry: &HandleRegistry, backend: &dyn RuntimeBackend) -> usize {
    let now = chrono::Utc::now();
    let mut reaped = 0;

    for (vm_id, info) in registry.list_all() {
        // Respect the spawn grace window.
        let age = now.signed_duration_since(info.created_at);
        if age.num_seconds() < SPAWN_GRACE.as_secs() as i64 {
            continue;
        }

        // Liveness is asked of the BACKEND handle, not the wire vm_id.
        match backend.is_alive(&info.handle_id).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::info!(
                    vm_id = %vm_id,
                    handle_id = %info.handle_id,
                    run_id = %info.run_id,
                    tenant_id = %info.tenant_id,
                    age_secs = age.num_seconds(),
                    "reaper: workload exited on its own; deregistering"
                );
                registry.deregister(&vm_id);
                reaped += 1;
            }
            Err(e) => {
                // Unknown ≠ dead. Keep the handle.
                tracing::debug!(
                    vm_id = %vm_id,
                    error = %e,
                    "reaper: liveness unknown, keeping handle"
                );
            }
        }
    }
    reaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{Handle, SnapshotInfo, StatsSample};
    use crate::handle_registry::HandleInfo;
    use crate::proto::{
        IsolationClass, ResourceLimits, RestoreRequest, RuntimeEvent, ScheduleRequest,
        SnapshotRequest,
    };
    use anyhow::Result;
    use async_trait::async_trait;
    use futures::stream::BoxStream;
    use std::collections::HashSet;

    /// Backend whose liveness answer is scripted per handle_id.
    struct ScriptedBackend {
        dead: HashSet<String>,
        unknown: HashSet<String>,
    }

    #[async_trait]
    impl RuntimeBackend for ScriptedBackend {
        async fn schedule(&self, _req: &ScheduleRequest) -> Result<Handle> {
            unimplemented!()
        }
        async fn cancel(&self, _handle_id: &str, _reason: &str) -> Result<()> {
            unimplemented!()
        }
        async fn stream(&self, _handle_id: &str) -> Result<BoxStream<'static, RuntimeEvent>> {
            unimplemented!()
        }
        async fn snapshot(&self, _req: &SnapshotRequest) -> Result<SnapshotInfo> {
            unimplemented!()
        }
        async fn restore(&self, _uri: &str, _req: &RestoreRequest) -> Result<Handle> {
            unimplemented!()
        }
        fn name(&self) -> &'static str {
            "scripted"
        }
        async fn stats_sample(&self, _handle_id: &str) -> Result<StatsSample> {
            unimplemented!()
        }
        async fn is_alive(&self, handle_id: &str) -> Result<bool> {
            if self.unknown.contains(handle_id) {
                anyhow::bail!("liveness unknown for {handle_id}");
            }
            Ok(!self.dead.contains(handle_id))
        }
    }

    fn info(handle_id: &str, age_secs: i64) -> HandleInfo {
        HandleInfo {
            handle_id: handle_id.to_string(),
            run_id: "run-1".to_string(),
            tenant_id: "t1".to_string(),
            backend: "scripted".to_string(),
            isolation_class: IsolationClass::Trusted,
            created_at: chrono::Utc::now() - chrono::Duration::seconds(age_secs),
            resource_limits: ResourceLimits::default(),
            node_name: "n1".to_string(),
            declared_secret_uris: vec![],
        }
    }

    fn scripted(dead: &[&str], unknown: &[&str]) -> ScriptedBackend {
        ScriptedBackend {
            dead: dead.iter().map(|s| s.to_string()).collect(),
            unknown: unknown.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[tokio::test]
    async fn reaps_exited_but_keeps_running() {
        let reg = HandleRegistry::new();
        reg.register(info("c-alive", 120));
        reg.register(info("c-dead", 120));

        let reaped = sweep_once(&reg, &scripted(&["c-dead"], &[])).await;

        assert_eq!(reaped, 1, "exactly the exited handle should be reaped");
        assert!(reg.get("c-alive").is_some(), "running handle must survive");
        assert!(reg.get("c-dead").is_none(), "exited handle must be removed");
    }

    /// The failure this guards: a docker outage answering Err for every handle
    /// must not wipe the registry and orphan every running workload.
    #[tokio::test]
    async fn liveness_error_never_reaps() {
        let reg = HandleRegistry::new();
        reg.register(info("c-1", 120));
        reg.register(info("c-2", 120));

        let reaped = sweep_once(&reg, &scripted(&[], &["c-1", "c-2"])).await;

        assert_eq!(reaped, 0, "unknown liveness must never reap");
        assert_eq!(reg.len(), 2, "registry must be untouched on error");
    }

    /// A just-spawned container may not report running yet.
    #[tokio::test]
    async fn respects_spawn_grace_window() {
        let reg = HandleRegistry::new();
        reg.register(info("c-new", 2)); // 2s old, inside the grace window

        let reaped = sweep_once(&reg, &scripted(&["c-new"], &[])).await;

        assert_eq!(
            reaped, 0,
            "handles inside the spawn grace must not be reaped"
        );
        assert!(reg.get("c-new").is_some());
    }

    /// Backends that cannot answer inherit is_alive() -> Ok(true).
    #[tokio::test]
    async fn conservative_default_is_never_reaped() {
        struct SilentBackend;
        #[async_trait]
        impl RuntimeBackend for SilentBackend {
            async fn schedule(&self, _req: &ScheduleRequest) -> Result<Handle> {
                unimplemented!()
            }
            async fn cancel(&self, _h: &str, _r: &str) -> Result<()> {
                unimplemented!()
            }
            async fn stream(&self, _h: &str) -> Result<BoxStream<'static, RuntimeEvent>> {
                unimplemented!()
            }
            async fn snapshot(&self, _r: &SnapshotRequest) -> Result<SnapshotInfo> {
                unimplemented!()
            }
            async fn restore(&self, _u: &str, _r: &RestoreRequest) -> Result<Handle> {
                unimplemented!()
            }
            fn name(&self) -> &'static str {
                "silent"
            }
        }

        let reg = HandleRegistry::new();
        reg.register(info("c-1", 300));
        assert_eq!(sweep_once(&reg, &SilentBackend).await, 0);
        assert_eq!(reg.len(), 1);
    }
}
