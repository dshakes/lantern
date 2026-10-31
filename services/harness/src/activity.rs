// ActivityTracker — goroutine-safe counter of running exec/workload children.
//
// The scheduler's idle-sweeper needs two signals from each heartbeat:
//   - `has_active_exec`       — is any exec/workload child alive right now?
//   - `last_activity_unix_ms` — when did the last child exit?
//
// Both live here as atomics so the heartbeat loop can sample them with no lock.
// Two kinds of callers update the tracker:
//
//   1. The supervisor (supervisor.rs): tracks the main workload process.
//   2. The exec server (exec.rs): tracks `pal vm exec` children.
//
// Usage: call `child_started()` when a child is spawned; hold the returned
// `ActiveGuard` until the child exits — drop automatically decrements.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};

use crate::proto::now_unix_ms;

/// Tracks active child count and last-activity timestamp.
#[derive(Clone, Default)]
pub struct ActivityTracker {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Number of currently running children (workload + exec).
    active: AtomicU32,
    /// Unix ms when `active` last dropped to zero. 0 = still active or never ran.
    last_activity_unix_ms: AtomicI64,
}

impl ActivityTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that a child started. Returns a guard that decrements on drop.
    pub fn child_started(&self) -> ActiveGuard {
        self.inner.active.fetch_add(1, Ordering::SeqCst);
        ActiveGuard {
            tracker: self.clone(),
        }
    }

    /// True when at least one child is currently running.
    #[must_use]
    pub fn has_active_exec(&self) -> bool {
        self.inner.active.load(Ordering::SeqCst) > 0
    }

    /// Unix ms of the last child exit; 0 if a child is still running or
    /// none has ever exited.
    #[must_use]
    pub fn last_activity_unix_ms(&self) -> i64 {
        self.inner.last_activity_unix_ms.load(Ordering::SeqCst)
    }

    fn child_stopped(&self) {
        let prev = self.inner.active.fetch_sub(1, Ordering::SeqCst);
        // Saturating: never wrap below zero (defensive; callers always pair
        // started/stopped via the guard).
        if prev == 0 {
            // Mismatched stop — undo the underflow.
            self.inner.active.fetch_add(1, Ordering::SeqCst);
            return;
        }
        if prev == 1 {
            // Transition to idle: stamp the activity timestamp.
            self.inner
                .last_activity_unix_ms
                .store(now_unix_ms(), Ordering::SeqCst);
        }
    }
}

/// RAII guard — decrements the activity counter when dropped.
pub struct ActiveGuard {
    tracker: ActivityTracker,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.tracker.child_stopped();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_inactive() {
        let t = ActivityTracker::new();
        assert!(!t.has_active_exec());
        assert_eq!(t.last_activity_unix_ms(), 0);
    }

    #[test]
    fn single_child_active_then_idle() {
        let t = ActivityTracker::new();
        let g = t.child_started();
        assert!(t.has_active_exec());
        assert_eq!(
            t.last_activity_unix_ms(),
            0,
            "still active — no timestamp yet"
        );
        drop(g);
        assert!(!t.has_active_exec());
        assert!(t.last_activity_unix_ms() > 0, "timestamp set on idle");
    }

    #[test]
    fn two_children_overlap() {
        let t = ActivityTracker::new();
        let g1 = t.child_started();
        let g2 = t.child_started();
        assert!(t.has_active_exec());
        // First child exits — still active because second is alive.
        drop(g1);
        assert!(t.has_active_exec());
        assert_eq!(
            t.last_activity_unix_ms(),
            0,
            "still active — no timestamp yet"
        );
        // Second exits — now idle.
        drop(g2);
        assert!(!t.has_active_exec());
        assert!(t.last_activity_unix_ms() > 0);
    }

    #[test]
    fn mismatched_stop_does_not_underflow() {
        let t = ActivityTracker::new();
        // No guard — directly call child_stopped (simulates a bug).
        t.child_stopped();
        // Must not wrap to u32::MAX.
        assert_eq!(t.inner.active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn second_activity_cycle_updates_timestamp() {
        let t = ActivityTracker::new();
        // First cycle.
        let g1 = t.child_started();
        drop(g1);
        let first_ts = t.last_activity_unix_ms();
        assert!(first_ts > 0);

        // Second cycle.
        let g2 = t.child_started();
        drop(g2);
        let second_ts = t.last_activity_unix_ms();
        // Must be >= first (clocks can be equal in very fast tests).
        assert!(second_ts >= first_ts);
    }
}
