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

/// Generated tonic types — `lantern.v1` package from runtime.proto.
///
/// Client stubs are used by `manager_client.rs` to call the manager;
/// server stubs back the in-guest exec server (`exec.rs`), which serves
/// `RuntimeHarness.Exec` so the manager can dial back into the guest.
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
// Proto conversions — internal ↔ pb wire types
// ---------------------------------------------------------------------------
//
// These are the only two places we translate between the rich internal types
// (used throughout the harness subsystems) and the tonic-generated wire
// types (used only in `manager_client.rs`). Keeping them in one file means
// they're easy to audit when the proto changes.

impl From<HeartbeatRequest> for pb::HeartbeatRequest {
    fn from(r: HeartbeatRequest) -> Self {
        // Use Euclidean div/rem so a negative at_unix_ms (pre-epoch / bug)
        // still yields nanos in [0, 999_999_999] as the protobuf Timestamp
        // contract requires — plain `%` would produce negative nanos.
        let at_secs = r.at_unix_ms.div_euclid(1_000);
        let at_nanos = (r.at_unix_ms.rem_euclid(1_000) * 1_000_000) as i32;
        pb::HeartbeatRequest {
            vm_id: r.vm_id,
            at: Some(prost_types::Timestamp {
                seconds: at_secs,
                nanos: at_nanos,
            }),
            usage: Some(pb::ResourceUsage {
                vcpu_ms_used: r.usage.vcpu_ms_used,
                memory_bytes: r.usage.memory_bytes,
                network_bytes_in: r.usage.network_bytes_in,
                network_bytes_out: r.usage.network_bytes_out,
                disk_bytes: r.usage.disk_bytes,
                cost_usd_accumulated: r.usage.cost_usd_accumulated,
            }),
            worker_pid: r.worker_pid,
            restart_count: r.restart_count,
        }
    }
}

impl From<HarnessReport> for pb::HarnessReport {
    fn from(r: HarnessReport) -> Self {
        use pb::harness_report::Body;
        let body = match r {
            HarnessReport::Log(l) => Body::Log(pb::RuntimeLogLine {
                vm_id: l.vm_id,
                at: Some(unix_ms_to_timestamp(l.at_unix_ms)),
                stream: l.stream,
                text: l.text,
                attrs: l.attrs,
            }),
            HarnessReport::OtlpTraces { bytes } => Body::OtlpTraces(bytes),
            HarnessReport::PrometheusMetrics { bytes } => Body::PrometheusMetrics(bytes),
            HarnessReport::Audit(a) => Body::Audit(pb::AuditEvent {
                vm_id: a.vm_id,
                action: a.action,
                at: Some(unix_ms_to_timestamp(a.at_unix_ms)),
                attrs: a.attrs,
            }),
        };
        pb::HarnessReport { body: Some(body) }
    }
}

impl From<pb::HeartbeatAck> for HeartbeatAck {
    fn from(a: pb::HeartbeatAck) -> Self {
        HeartbeatAck {
            egress_overrides: a
                .egress_overrides
                .into_iter()
                .map(|r| EgressRule {
                    pattern: r.pattern,
                    http_methods: r.http_methods,
                    rate_bps: r.rate_bps,
                })
                .collect(),
            limits_override: a.limits_override.map(|l| ResourceLimits {
                vcpu: l.vcpu,
                memory: l.memory,
                gpu: l.gpu,
                timeout_secs: l.timeout.map(|d| d.seconds).unwrap_or(0),
                max_steps: l.max_steps,
                max_tokens: l.max_tokens,
                max_cost_usd: l.max_cost_usd,
                scratch_size: l.scratch_size,
            }),
            drain: a.drain,
            snapshot: a.snapshot,
        }
    }
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

/// Convert unix-ms to a protobuf Timestamp. Uses Euclidean div/rem so a
/// negative `at_unix_ms` (pre-epoch / bug) still yields nanos in
/// [0, 999_999_999] as the Timestamp contract requires.
pub fn unix_ms_to_timestamp(at_unix_ms: i64) -> prost_types::Timestamp {
    prost_types::Timestamp {
        seconds: at_unix_ms.div_euclid(1_000),
        nanos: (at_unix_ms.rem_euclid(1_000) * 1_000_000) as i32,
    }
}
