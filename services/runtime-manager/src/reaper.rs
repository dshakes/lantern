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

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use crate::backend::{Liveness, RuntimeBackend};
use crate::handle_registry::HandleRegistry;

/// How often to sweep the registry.
const DEFAULT_INTERVAL: Duration = Duration::from_secs(15);

/// Grace period after registration before a handle the backend has NEVER
/// reported alive becomes eligible for reaping.
///
/// A container is registered before the backend reports it running, so a fast
/// sweep could otherwise observe `running == false` on a still-starting
/// workload and reap it mid-spawn.
///
/// The grace applies ONLY until the backend confirms the handle alive once.
/// After that a `running == false` is a genuine exit and is acted on
/// immediately — a 2-second agent should not sit "running" cluster-wide for
/// 30 seconds just because it finished faster than its own start-up window.
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
///
/// Reaping publishes immediately: `HandleRegistry::deregister` signals the
/// registry's change notifier, which wakes the heartbeat, so the scheduler
/// learns of an exit within the sweep interval rather than up to a full
/// heartbeat later.
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
        // handle_ids the backend has confirmed alive at least once. These no
        // longer need the spawn grace.
        let mut confirmed: HashSet<String> = HashSet::new();
        loop {
            ticker.tick().await;
            let reaped = sweep_once(&registry, backend.as_ref(), &mut confirmed).await;
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
///
/// `confirmed` accumulates handle_ids the backend has reported alive at least
/// once; those skip the spawn grace on later sweeps. Callers own the set so it
/// persists across sweeps.
pub async fn sweep_once(
    registry: &HandleRegistry,
    backend: &dyn RuntimeBackend,
    confirmed: &mut HashSet<String>,
) -> usize {
    let now = chrono::Utc::now();
    let mut reaped = 0;
    let live: HashSet<String> = registry
        .list_all()
        .iter()
        .map(|(_, i)| i.handle_id.clone())
        .collect();
    // Do not grow without bound as handles come and go.
    confirmed.retain(|h| live.contains(h));

    for (vm_id, info) in registry.list_all() {
        // Liveness is asked of the BACKEND handle, not the wire vm_id.
        match backend.liveness(&info.handle_id).await {
            Ok(Liveness::Alive) => {
                confirmed.insert(info.handle_id.clone());
            }
            Ok(state @ (Liveness::Exited | Liveness::Starting)) => {
                let age = now.signed_duration_since(info.created_at);
                // The grace covers exactly one uncertainty: a handle that may
                // not have started yet. A confirmed EXIT carries no such
                // doubt, and neither does a handle the backend previously
                // reported alive — both are reaped at once. Without this a
                // workload finishing faster than one sweep interval sat
                // "running" cluster-wide for the whole grace window.
                let certain = state == Liveness::Exited || confirmed.contains(&info.handle_id);
                if !certain && age.num_seconds() < SPAWN_GRACE.as_secs() as i64 {
                    continue;
                }
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
    pub(super) struct ScriptedBackend {
        dead: HashSet<String>,
        unknown: HashSet<String>,
        exited: HashSet<String>,
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

        /// `dead` handles report Starting by default so the pre-existing
        /// grace-window tests keep exercising the grace path. Tests that want
        /// a definitive exit use `exited()`.
        async fn liveness(&self, handle_id: &str) -> Result<crate::backend::Liveness> {
            if self.unknown.contains(handle_id) {
                anyhow::bail!("liveness unknown for {handle_id}");
            }
            if self.exited.contains(handle_id) {
                return Ok(crate::backend::Liveness::Exited);
            }
            Ok(if self.dead.contains(handle_id) {
                crate::backend::Liveness::Starting
            } else {
                crate::backend::Liveness::Alive
            })
        }
    }

    pub(super) fn info(handle_id: &str, age_secs: i64) -> HandleInfo {
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

    pub(super) fn scripted(dead: &[&str], unknown: &[&str]) -> ScriptedBackend {
        ScriptedBackend {
            dead: dead.iter().map(|s| s.to_string()).collect(),
            unknown: unknown.iter().map(|s| s.to_string()).collect(),
            exited: HashSet::new(),
        }
    }

    /// Backend reporting these handles as DEFINITIVELY exited.
    pub(super) fn exited(ids: &[&str]) -> ScriptedBackend {
        ScriptedBackend {
            dead: ids.iter().map(|s| s.to_string()).collect(),
            unknown: HashSet::new(),
            exited: ids.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[tokio::test]
    async fn reaps_exited_but_keeps_running() {
        let reg = HandleRegistry::new();
        reg.register(info("c-alive", 120));
        reg.register(info("c-dead", 120));

        let reaped = sweep_once(&reg, &scripted(&["c-dead"], &[]), &mut HashSet::new()).await;

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

        let reaped = sweep_once(&reg, &scripted(&[], &["c-1", "c-2"]), &mut HashSet::new()).await;

        assert_eq!(reaped, 0, "unknown liveness must never reap");
        assert_eq!(reg.len(), 2, "registry must be untouched on error");
    }

    /// A just-spawned container may not report running yet.
    #[tokio::test]
    async fn respects_spawn_grace_window() {
        let reg = HandleRegistry::new();
        reg.register(info("c-new", 2)); // 2s old, inside the grace window

        let reaped = sweep_once(&reg, &scripted(&["c-new"], &[]), &mut HashSet::new()).await;

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
        assert_eq!(
            sweep_once(&reg, &SilentBackend, &mut HashSet::new()).await,
            0
        );
        assert_eq!(reg.len(), 1);
    }
}

#[cfg(test)]
mod confirm_once_tests {
    use super::tests::{info, scripted};
    use super::*;

    /// The latency bug: a 2-second agent had to wait out the full 30s spawn
    /// grace before the reaper would touch it, so the whole cluster believed
    /// it was still running. Once the backend has confirmed a handle alive,
    /// a later "not running" is a genuine exit and is acted on at once.
    #[tokio::test]
    async fn confirmed_handle_is_reaped_immediately_after_exit() {
        let reg = HandleRegistry::new();
        reg.register(info("c-fast", 2)); // 2s old — deep inside the grace
        let mut confirmed = HashSet::new();

        // Sweep 1: backend reports it alive → confirmed, nothing reaped.
        let reaped = sweep_once(&reg, &scripted(&[], &[]), &mut confirmed).await;
        assert_eq!(reaped, 0);
        assert!(
            confirmed.contains("c-fast"),
            "alive handle must be confirmed"
        );

        // Sweep 2: it exited. Still young, but previously confirmed.
        let reaped = sweep_once(&reg, &scripted(&["c-fast"], &[]), &mut confirmed).await;
        assert_eq!(
            reaped, 1,
            "a confirmed handle must reap without waiting out the grace"
        );
        assert!(reg.get("c-fast").is_none());
    }

    /// The grace must still protect a handle the backend has never confirmed —
    /// the create-then-start window it exists for.
    #[tokio::test]
    async fn never_confirmed_handle_still_gets_grace() {
        let reg = HandleRegistry::new();
        reg.register(info("c-starting", 2));
        let mut confirmed = HashSet::new();

        let reaped = sweep_once(&reg, &scripted(&["c-starting"], &[]), &mut confirmed).await;

        assert_eq!(reaped, 0, "a never-confirmed, young handle must survive");
        assert!(reg.get("c-starting").is_some());
    }

    /// Past the grace, a never-confirmed handle is reaped — a spawn that never
    /// came up must not leak forever.
    #[tokio::test]
    async fn never_confirmed_handle_is_reaped_after_grace() {
        let reg = HandleRegistry::new();
        reg.register(info("c-stillborn", 120));
        let mut confirmed = HashSet::new();

        let reaped = sweep_once(&reg, &scripted(&["c-stillborn"], &[]), &mut confirmed).await;

        assert_eq!(reaped, 1);
    }

    /// The confirmed set must not grow without bound as handles come and go.
    #[tokio::test]
    async fn confirmed_set_is_pruned_to_live_handles() {
        let reg = HandleRegistry::new();
        reg.register(info("c-1", 60));
        let mut confirmed = HashSet::new();

        sweep_once(&reg, &scripted(&[], &[]), &mut confirmed).await;
        assert!(confirmed.contains("c-1"));

        reg.deregister("c-1");
        sweep_once(&reg, &scripted(&[], &[]), &mut confirmed).await;

        assert!(
            confirmed.is_empty(),
            "entries for gone handles must be pruned"
        );
    }
}

#[cfg(test)]
mod exited_fast_path_tests {
    use super::tests::{exited, info, scripted};
    use super::*;

    /// The latency bug, root cause. A workload can finish faster than one
    /// sweep interval, so the reaper NEVER observes it alive and
    /// confirm-once cannot help. Measured live: a ~1s agent took 35s to be
    /// reaped (30s grace + one 5s sweep) and stayed "running" cluster-wide
    /// for all of it. A backend-confirmed EXIT has no start-up ambiguity, so
    /// it skips the grace outright.
    #[tokio::test]
    async fn definitive_exit_skips_the_grace_entirely() {
        let reg = HandleRegistry::new();
        reg.register(info("c-fast", 1)); // 1s old, never seen alive
        let mut confirmed = HashSet::new();

        let reaped = sweep_once(&reg, &exited(&["c-fast"]), &mut confirmed).await;

        assert_eq!(
            reaped, 1,
            "a confirmed exit must be reaped on the first sweep"
        );
        assert!(reg.get("c-fast").is_none());
    }

    /// `Starting` keeps the grace — that is the create-then-start window and
    /// reaping there would kill a workload mid-spawn.
    #[tokio::test]
    async fn starting_still_waits_out_the_grace() {
        let reg = HandleRegistry::new();
        reg.register(info("c-starting", 1));
        let mut confirmed = HashSet::new();

        let reaped = sweep_once(&reg, &scripted(&["c-starting"], &[]), &mut confirmed).await;

        assert_eq!(reaped, 0, "a maybe-starting handle must not be reaped");
        assert!(reg.get("c-starting").is_some());
    }

    /// Unknown is still never fatal, even on the fast path.
    #[tokio::test]
    async fn unknown_liveness_is_never_reaped() {
        let reg = HandleRegistry::new();
        reg.register(info("c-1", 1));
        let mut confirmed = HashSet::new();

        let reaped = sweep_once(&reg, &scripted(&[], &["c-1"]), &mut confirmed).await;

        assert_eq!(reaped, 0);
        assert!(reg.get("c-1").is_some());
    }
}
