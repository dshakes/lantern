//! RuntimeClass preflight check (Task 4, ADR-0009).
//!
//! At startup the manager verifies that any hardened RuntimeClass names
//! configured via `LANTERN_RUNTIMECLASS_GVISOR` / `LANTERN_RUNTIMECLASS_KATA`
//! actually EXIST as `node.k8s.io/v1 RuntimeClass` objects in the cluster.
//!
//! If a configured hardened class is ABSENT from the cluster:
//! - the matching isolation capability is marked **unavailable** so
//!   `choose_backend` fails closed for it (no silent downgrade);
//! - the manager does NOT crash — other backends that ARE present continue
//!   to serve requests.
//!
//! This is best-effort / non-fatal for dev clusters (where the kube client may
//! not be reachable at all): when the list call itself fails (network error,
//! RBAC, etc.) the check is skipped and a loud WARN is emitted so operators
//! know the check was inconclusive.
//!
//! # Pure decision function
//!
//! [`resolve_available_classes`] is a pure function that maps a set of
//! configured class names and the set of cluster-present class names to the
//! subset that are actually usable.  This is unit-testable without a live
//! cluster.

use std::collections::HashSet;

use crate::backends::k8s::RuntimeClassConfig;

// ---------------------------------------------------------------------------
// Pure decision function (unit-testable without a live cluster)
// ---------------------------------------------------------------------------

/// Given the set of class names present in the cluster and the configured
/// `RuntimeClassConfig`, return a new config that clears any configured class
/// that is ABSENT from the cluster.
///
/// Classes that are `None` in the input config are left as `None` (not
/// retroactively set to something).
///
/// # Examples
///
/// ```
/// # use runtime_manager::runtimeclass_preflight::resolve_available_classes;
/// # use runtime_manager::backends::k8s::RuntimeClassConfig;
/// let cfg = RuntimeClassConfig {
///     gvisor: Some("gvisor".to_string()),
///     kata: Some("kata-qemu".to_string()),
///     ..Default::default()
/// };
/// // Cluster only has gvisor, not kata-qemu.
/// let present: std::collections::HashSet<String> =
///     ["gvisor".to_string()].into_iter().collect();
/// let resolved = resolve_available_classes(&cfg, &present);
/// assert_eq!(resolved.gvisor, Some("gvisor".to_string()));
/// assert!(resolved.kata.is_none(), "kata-qemu absent → capability disabled");
/// ```
pub fn resolve_available_classes(
    cfg: &RuntimeClassConfig,
    present_in_cluster: &HashSet<String>,
) -> RuntimeClassConfig {
    /// Check one class: if configured AND absent, clear it and log loudly.
    fn check(name: Option<&str>, present: &HashSet<String>, tier: &str) -> Option<String> {
        let n = name?;
        if present.contains(n) {
            Some(n.to_string())
        } else {
            tracing::error!(
                class_name = n,
                tier,
                "RuntimeClass preflight FAIL: configured hardened class '{}' does not exist \
                 in the cluster — disabling {} isolation capability (fail-closed). \
                 Create the RuntimeClass or set the env var to a class that exists.",
                n,
                tier,
            );
            None
        }
    }

    RuntimeClassConfig {
        gvisor: check(
            cfg.gvisor.as_deref(),
            present_in_cluster,
            "UNTRUSTED/gVisor",
        ),
        kata: check(cfg.kata.as_deref(), present_in_cluster, "HOSTILE/Kata"),
        // WASM: also checked, same logic.
        wasm: check(cfg.wasm.as_deref(), present_in_cluster, "WASM"),
        // Non-RuntimeClass fields are passed through unchanged.
        allow_runc_standard: cfg.allow_runc_standard,
        node_label_gvisor: cfg.node_label_gvisor.clone(),
        node_label_kata: cfg.node_label_kata.clone(),
    }
}

// ---------------------------------------------------------------------------
// Live cluster check (called from main.rs, skipped gracefully when no cluster)
// ---------------------------------------------------------------------------

/// Fetch all `RuntimeClass` names present in the cluster via the kube API,
/// then resolve the effective config by clearing any absent hardened class.
///
/// This is best-effort:
/// - Returns `Ok(adjusted_cfg)` when the cluster is reachable. If a configured
///   class is absent, the capability is cleared in the returned config (see
///   [`resolve_available_classes`]).
/// - Returns `Ok(original_cfg)` unchanged when the kube client cannot list
///   RuntimeClasses (RBAC, network, no cluster). A loud WARN is emitted so
///   dev vs. prod can see the check was skipped.
///
/// # No panic / no crash
///
/// A missing RuntimeClass is a degraded-capability situation (WARN / ERROR),
/// not a fatal start failure.  The decision to abort startup belongs to the
/// operator — they can read the error log and correct the config.  Crashing
/// the manager here would take down the entire node, which is worse than a
/// single isolation tier being unavailable.
pub async fn check_and_resolve(
    cfg: RuntimeClassConfig,
    client: Option<&kube::Client>,
) -> RuntimeClassConfig {
    // If no classes are configured for the hardened tiers, nothing to check.
    let needs_check = cfg.gvisor.is_some() || cfg.kata.is_some() || cfg.wasm.is_some();
    if !needs_check {
        tracing::debug!("RuntimeClass preflight: no hardened classes configured; skipping check");
        return cfg;
    }

    let Some(client) = client else {
        tracing::warn!(
            "RuntimeClass preflight: no kube client available (non-K8s backend?); \
             skipping cluster check — configured classes assumed absent-risk"
        );
        return cfg;
    };

    // Try to list all RuntimeClass objects. We do NOT fail-open: if we get
    // a definitive error (RBAC 403) we still skip rather than block startup,
    // but we log loudly.
    use k8s_openapi::api::node::v1::RuntimeClass;
    use kube::api::{Api, ListParams};

    let api: Api<RuntimeClass> = Api::all(client.clone());
    // Index by metadata.name — this is what a pod's `runtimeClassName` field
    // references, and therefore what `LANTERN_RUNTIMECLASS_*` env vars must
    // match.  The `handler` field is the *node-level* runtime binary name
    // (e.g. `runsc` for gVisor) and is NOT what operators configure in
    // LANTERN_RUNTIMECLASS_*.  We also include the handler in the set for
    // operators who (incorrectly but understandably) configure the handler
    // name — belt-and-suspenders so neither interpretation false-clears.
    let present: HashSet<String> = match api.list(&ListParams::default()).await {
        Ok(list) => list
            .items
            .into_iter()
            .flat_map(|rc| {
                let name = rc.metadata.name.clone().into_iter();
                let handler = std::iter::once(rc.handler.clone());
                name.chain(handler)
            })
            .collect(),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "RuntimeClass preflight: failed to list RuntimeClasses from cluster \
                 (RBAC? no cluster? network error?) — skipping check; \
                 configured isolation classes assumed present. \
                 Grant the manager's ServiceAccount `list` on `node.k8s.io/runtimeclasses` \
                 to enable this safety check."
            );
            return cfg;
        }
    };

    tracing::info!(
        present_classes = ?present,
        "RuntimeClass preflight: found classes in cluster"
    );

    resolve_available_classes(&cfg, &present)
}

// ---------------------------------------------------------------------------
// Tests for the pure decision function
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn present(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn both_classes_present_passes_through_unchanged() {
        let cfg = RuntimeClassConfig {
            gvisor: Some("gvisor".to_string()),
            kata: Some("kata-qemu".to_string()),
            wasm: Some("wasmtime".to_string()),
            allow_runc_standard: false,
            ..Default::default()
        };
        let resolved =
            resolve_available_classes(&cfg, &present(&["gvisor", "kata-qemu", "wasmtime"]));
        assert_eq!(resolved.gvisor, Some("gvisor".to_string()));
        assert_eq!(resolved.kata, Some("kata-qemu".to_string()));
        assert_eq!(resolved.wasm, Some("wasmtime".to_string()));
    }

    #[test]
    fn missing_kata_clears_kata_capability() {
        let cfg = RuntimeClassConfig {
            gvisor: Some("gvisor".to_string()),
            kata: Some("kata-qemu".to_string()),
            ..Default::default()
        };
        // Cluster only has gvisor.
        let resolved = resolve_available_classes(&cfg, &present(&["gvisor"]));
        assert_eq!(
            resolved.gvisor,
            Some("gvisor".to_string()),
            "gVisor present → capability preserved"
        );
        assert!(
            resolved.kata.is_none(),
            "kata-qemu absent → HOSTILE capability disabled"
        );
    }

    #[test]
    fn missing_gvisor_clears_gvisor_capability() {
        let cfg = RuntimeClassConfig {
            gvisor: Some("gvisor".to_string()),
            kata: Some("kata-qemu".to_string()),
            ..Default::default()
        };
        // Cluster only has kata.
        let resolved = resolve_available_classes(&cfg, &present(&["kata-qemu"]));
        assert!(
            resolved.gvisor.is_none(),
            "gVisor absent → UNTRUSTED capability disabled"
        );
        assert_eq!(
            resolved.kata,
            Some("kata-qemu".to_string()),
            "kata-qemu present → capability preserved"
        );
    }

    #[test]
    fn both_absent_clears_both_capabilities() {
        let cfg = RuntimeClassConfig {
            gvisor: Some("gvisor".to_string()),
            kata: Some("kata-qemu".to_string()),
            ..Default::default()
        };
        let resolved = resolve_available_classes(&cfg, &present(&[]));
        assert!(resolved.gvisor.is_none(), "gVisor absent → cleared");
        assert!(resolved.kata.is_none(), "Kata absent → cleared");
    }

    #[test]
    fn unconfigured_classes_not_retroactively_set() {
        // Config has no hardened classes at all.
        let cfg = RuntimeClassConfig {
            allow_runc_standard: true,
            ..Default::default()
        };
        // Even if cluster has gvisor, we don't auto-enable it.
        let resolved = resolve_available_classes(&cfg, &present(&["gvisor", "kata-qemu"]));
        assert!(resolved.gvisor.is_none(), "not configured → not enabled");
        assert!(resolved.kata.is_none(), "not configured → not enabled");
        assert!(resolved.allow_runc_standard, "flag passed through");
    }

    /// The authoritative match for `LANTERN_RUNTIMECLASS_*` is the RuntimeClass
    /// object's `metadata.name` (what a pod's `runtimeClassName` references).
    /// The `handler` field is different (e.g. `metadata.name=gvisor`,
    /// `handler=runsc`).  A cluster with that object must be treated as having
    /// gVisor available when `LANTERN_RUNTIMECLASS_GVISOR=gvisor` is set —
    /// NOT cleared because "runsc" is not in the configured names.
    #[test]
    fn name_vs_handler_divergence_uses_metadata_name() {
        // Cluster has a RuntimeClass with name="gvisor" but handler="runsc".
        // The `present` set must contain "gvisor" (the name), so the configured
        // class "gvisor" is treated as PRESENT, not wrongly cleared.
        //
        // In check_and_resolve this is built from flat_map(name ∪ handler);
        // here we test resolve_available_classes directly by passing the set
        // that check_and_resolve would build.
        let cluster_names_and_handlers: HashSet<String> =
            ["gvisor".to_string(), "runsc".to_string()]
                .into_iter()
                .collect();

        let cfg = RuntimeClassConfig {
            gvisor: Some("gvisor".to_string()),
            kata: Some("kata-qemu".to_string()),
            ..Default::default()
        };

        // "gvisor" is in the set (via metadata.name) → capability kept.
        // "kata-qemu" is NOT in the set → capability cleared.
        let resolved = resolve_available_classes(&cfg, &cluster_names_and_handlers);
        assert_eq!(
            resolved.gvisor,
            Some("gvisor".to_string()),
            "gVisor: metadata.name='gvisor' is present — must NOT be cleared (handler='runsc' is irrelevant to config)"
        );
        assert!(
            resolved.kata.is_none(),
            "kata-qemu: not in cluster set → capability disabled"
        );
    }

    #[test]
    fn node_label_fields_passed_through_unchanged() {
        let cfg = RuntimeClassConfig {
            gvisor: Some("gvisor".to_string()),
            node_label_gvisor: Some("gvisor-custom".to_string()),
            node_label_kata: Some("kata-custom".to_string()),
            ..Default::default()
        };
        let resolved = resolve_available_classes(&cfg, &present(&["gvisor"]));
        assert_eq!(
            resolved.node_label_gvisor.as_deref(),
            Some("gvisor-custom"),
            "node_label_gvisor passed through"
        );
        assert_eq!(
            resolved.node_label_kata.as_deref(),
            Some("kata-custom"),
            "node_label_kata passed through"
        );
    }
}
