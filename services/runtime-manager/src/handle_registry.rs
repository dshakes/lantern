use chrono::{DateTime, Utc};
use dashmap::DashMap;

use crate::proto::{IsolationClass, ResourceLimits};

/// Metadata about an active sandbox handle.
#[derive(Clone, Debug)]
pub struct HandleInfo {
    pub handle_id: String,
    pub run_id: String,
    pub tenant_id: String,
    pub backend: String,
    pub isolation_class: IsolationClass,
    pub created_at: DateTime<Utc>,
    pub resource_limits: ResourceLimits,
    pub node_name: String,
}

/// Thread-safe registry of all active sandbox handles.
///
/// Tracks every handle the runtime manager has scheduled, enabling
/// queries by handle ID or tenant.
pub struct HandleRegistry {
    handles: DashMap<String, HandleInfo>,
}

impl HandleRegistry {
    pub fn new() -> Self {
        Self {
            handles: DashMap::new(),
        }
    }

    /// Register a new active handle.
    pub fn register(&self, info: HandleInfo) {
        tracing::info!(
            handle_id = %info.handle_id,
            run_id = %info.run_id,
            tenant_id = %info.tenant_id,
            backend = %info.backend,
            "registering handle"
        );
        self.handles.insert(info.handle_id.clone(), info);
    }

    /// Reassign the public key under which a handle is registered. The
    /// backend's container/VM id stays in `HandleInfo.handle_id` so cancel
    /// can forward it; the public key becomes the wire-level vm_id minted
    /// by the scheduler.
    pub fn rekey(&self, old_id: &str, new_id: &str) -> bool {
        if old_id == new_id {
            return true;
        }
        if let Some((_, info)) = self.handles.remove(old_id) {
            tracing::info!(
                old_id = %old_id,
                new_id = %new_id,
                backend_handle = %info.handle_id,
                "rekeyed handle to wire vm_id"
            );
            self.handles.insert(new_id.to_string(), info);
            true
        } else {
            false
        }
    }

    /// Remove a handle from the registry, returning its info if it existed.
    pub fn deregister(&self, handle_id: &str) -> Option<HandleInfo> {
        let removed = self.handles.remove(handle_id).map(|(_, v)| v);
        if let Some(ref info) = removed {
            tracing::info!(
                handle_id = %info.handle_id,
                run_id = %info.run_id,
                "deregistered handle"
            );
        }
        removed
    }

    /// Look up a handle by ID.
    pub fn get(&self, handle_id: &str) -> Option<HandleInfo> {
        self.handles.get(handle_id).map(|r| r.clone())
    }

    /// List all handles belonging to a specific tenant.
    pub fn list_by_tenant(&self, tenant_id: &str) -> Vec<HandleInfo> {
        self.handles
            .iter()
            .filter(|entry| entry.value().tenant_id == tenant_id)
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Total number of active handles.
    pub fn len(&self) -> usize {
        self.handles.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.handles.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn make_info(handle_id: &str, run_id: &str, tenant_id: &str) -> HandleInfo {
        HandleInfo {
            handle_id: handle_id.to_string(),
            run_id: run_id.to_string(),
            tenant_id: tenant_id.to_string(),
            backend: "docker".to_string(),
            isolation_class: IsolationClass::Standard,
            created_at: Utc::now(),
            resource_limits: ResourceLimits::default(),
            node_name: "node-1".to_string(),
        }
    }

    #[test]
    fn new_registry_is_empty() {
        let reg = HandleRegistry::new();
        assert!(reg.is_empty());
        assert_eq!(reg.len(), 0);
    }

    #[test]
    fn register_and_get_roundtrip() {
        let reg = HandleRegistry::new();
        let info = make_info("h-1", "run-1", "tenant-a");
        reg.register(info.clone());

        assert_eq!(reg.len(), 1);
        let got = reg.get("h-1").expect("should find registered handle");
        assert_eq!(got.handle_id, "h-1");
        assert_eq!(got.run_id, "run-1");
        assert_eq!(got.tenant_id, "tenant-a");
    }

    #[test]
    fn get_missing_returns_none() {
        let reg = HandleRegistry::new();
        assert!(reg.get("does-not-exist").is_none());
    }

    #[test]
    fn deregister_removes_and_returns_info() {
        let reg = HandleRegistry::new();
        reg.register(make_info("h-2", "run-2", "tenant-b"));
        let removed = reg.deregister("h-2");
        assert!(removed.is_some());
        assert_eq!(removed.unwrap().handle_id, "h-2");
        assert!(reg.is_empty());
    }

    #[test]
    fn deregister_missing_returns_none() {
        let reg = HandleRegistry::new();
        assert!(reg.deregister("phantom").is_none());
    }

    #[test]
    fn list_by_tenant_filters_correctly() {
        let reg = HandleRegistry::new();
        reg.register(make_info("h-a1", "run-a1", "tenant-a"));
        reg.register(make_info("h-a2", "run-a2", "tenant-a"));
        reg.register(make_info("h-b1", "run-b1", "tenant-b"));

        let tenant_a = reg.list_by_tenant("tenant-a");
        assert_eq!(tenant_a.len(), 2);
        assert!(tenant_a.iter().all(|h| h.tenant_id == "tenant-a"));

        let tenant_b = reg.list_by_tenant("tenant-b");
        assert_eq!(tenant_b.len(), 1);

        let tenant_c = reg.list_by_tenant("tenant-c");
        assert!(tenant_c.is_empty());
    }

    #[test]
    fn rekey_changes_lookup_key() {
        let reg = HandleRegistry::new();
        reg.register(make_info("backend-id", "run-x", "tenant-x"));

        let ok = reg.rekey("backend-id", "wire-vm-id");
        assert!(ok);

        // Old key is gone.
        assert!(reg.get("backend-id").is_none());
        // New key works.
        let got = reg
            .get("wire-vm-id")
            .expect("rekeyed handle must be accessible");
        assert_eq!(got.handle_id, "backend-id"); // HandleInfo.handle_id unchanged
        assert_eq!(got.run_id, "run-x");
    }

    #[test]
    fn rekey_same_id_is_noop() {
        let reg = HandleRegistry::new();
        reg.register(make_info("same-id", "run-y", "tenant-y"));
        let ok = reg.rekey("same-id", "same-id");
        assert!(ok);
        assert!(reg.get("same-id").is_some());
    }

    #[test]
    fn rekey_missing_returns_false() {
        let reg = HandleRegistry::new();
        assert!(!reg.rekey("non-existent", "new-id"));
    }

    #[test]
    fn len_tracks_registrations_and_removals() {
        let reg = HandleRegistry::new();
        assert_eq!(reg.len(), 0);
        reg.register(make_info("h1", "r1", "t1"));
        assert_eq!(reg.len(), 1);
        reg.register(make_info("h2", "r2", "t1"));
        assert_eq!(reg.len(), 2);
        reg.deregister("h1");
        assert_eq!(reg.len(), 1);
    }
}
