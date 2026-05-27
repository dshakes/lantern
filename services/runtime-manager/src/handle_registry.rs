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
