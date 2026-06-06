// Proto types for the harness.
//
// Two layers:
//
// 1. `pb` — tonic-generated wire types from `lantern.v1` (client-only).
//    Used in `manager_client.rs` for the actual gRPC calls.
//
// 2. Hand-defined internal types at the module root — richer/simpler shapes
//    that the rest of the harness (`secrets.rs`, `heartbeat.rs`, etc.)
//    consume. `manager_client.rs` converts between these and `pb` types.

use serde::{Deserialize, Serialize};

/// Generated tonic client types — `lantern.v1` package from runtime.proto.
///
/// Only the client stubs are compiled (build_server = false). The harness
/// never serves RPCs; it only calls the manager.
#[allow(
    clippy::enum_variant_names,
    clippy::large_enum_variant,
    clippy::doc_markdown,
    clippy::derive_partial_eq_without_eq
)]
pub mod pb {
    tonic::include_proto!("lantern.v1");
}

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ResourceUsage {
    pub vcpu_ms_used: i64,
    pub memory_bytes: i64,
    pub network_bytes_in: i64,
    pub network_bytes_out: i64,
    pub disk_bytes: i64,
    pub cost_usd_accumulated: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EgressRule {
    pub pattern: String,
    pub http_methods: Vec<String>,
    pub rate_bps: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ResourceLimits {
    pub vcpu: String,
    pub memory: String,
    pub gpu: String,
    pub timeout_secs: i64,
    pub max_steps: i64,
    pub max_tokens: i64,
    pub max_cost_usd: f64,
    pub scratch_size: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SecretRef {
    pub env_name: String,
    pub secret_uri: String,
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HeartbeatRequest {
    pub vm_id: String,
    pub at_unix_ms: i64,
    pub usage: ResourceUsage,
    pub worker_pid: i32,
    pub restart_count: i32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HeartbeatAck {
    pub egress_overrides: Vec<EgressRule>,
    pub limits_override: Option<ResourceLimits>,
    pub drain: bool,
    pub snapshot: bool,
}

// ---------------------------------------------------------------------------
// VendSecret
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct VendSecretRequest {
    pub vm_id: String,
    pub secret_uri: String,
    pub ttl_secs: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct VendSecretResponse {
    pub value: String,
    pub expires_at_unix_ms: i64,
}

// ---------------------------------------------------------------------------
// HarnessReport
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HarnessReport {
    Log(LogLine),
    OtlpTraces { bytes: Vec<u8> },
    PrometheusMetrics { bytes: Vec<u8> },
    Audit(AuditEvent),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LogLine {
    pub vm_id: String,
    pub at_unix_ms: i64,
    /// "stdout", "stderr", "harness", "audit".
    pub stream: String,
    pub text: String,
    pub attrs: std::collections::HashMap<String, String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AuditEvent {
    pub vm_id: String,
    pub action: String,
    pub at_unix_ms: i64,
    pub attrs: std::collections::HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
