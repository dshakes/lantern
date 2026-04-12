/// Hand-defined prost types matching engine.proto RuntimeManagerService definitions.
/// These mirror the protobuf messages in `packages/proto/lantern/v1/engine.proto`.
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(i32)]
pub enum IsolationClass {
    Unspecified = 0,
    Trusted = 1,
    Standard = 2,
    Untrusted = 3,
    Hostile = 4,
    Wasm = 5,
    Devcontainer = 6,
}

impl IsolationClass {
    pub fn from_i32(v: i32) -> Self {
        match v {
            1 => IsolationClass::Trusted,
            2 => IsolationClass::Standard,
            3 => IsolationClass::Untrusted,
            4 => IsolationClass::Hostile,
            5 => IsolationClass::Wasm,
            6 => IsolationClass::Devcontainer,
            _ => IsolationClass::Unspecified,
        }
    }
}

// ---------------------------------------------------------------------------
// Request / Response messages
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResourceLimits {
    pub cpu: String,
    pub memory: String,
    pub gpu: String,
    pub timeout: String,
    pub max_steps: i64,
    pub max_tokens: i64,
    pub max_cost_usd: f64,
    pub scratch_size: String,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            cpu: "1".to_string(),
            memory: "512Mi".to_string(),
            gpu: String::new(),
            timeout: "300s".to_string(),
            max_steps: 100,
            max_tokens: 100_000,
            max_cost_usd: 1.0,
            scratch_size: "1Gi".to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SecretRef {
    pub alias: String,
    pub vault_ref: String,
    pub env_var: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleRequest {
    pub run_id: String,
    pub bundle_uri: String,
    pub bundle_digest: Vec<u8>,
    pub isolation_class: IsolationClass,
    pub limits: ResourceLimits,
    pub env: std::collections::HashMap<String, String>,
    pub secrets: Vec<SecretRef>,
    pub input: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleResponse {
    pub handle_id: String,
    pub node_name: String,
    pub cold_start_ms: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeCancelRequest {
    pub handle_id: String,
    pub reason: String,
    pub grace_period_seconds: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeCancelResponse {}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeStreamRequest {
    pub handle_id: String,
}

// ---------------------------------------------------------------------------
// RuntimeEvent and its oneof variants
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StepRequest {
    pub step_id: String,
    pub kind: String,
    pub payload: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StepResponse {
    pub step_id: String,
    pub result: serde_json::Value,
    pub error: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LlmRequest {
    pub step_id: String,
    pub capability: String,
    pub optimize: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LlmDelta {
    pub step_id: String,
    pub delta: String,
    pub finish_reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LogLine {
    pub level: String,
    pub message: String,
    pub timestamp: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeExited {
    pub exit_code: i32,
    pub error: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RuntimeEvent {
    StepRequest(StepRequest),
    StepResponse(StepResponse),
    LlmRequest(LlmRequest),
    LlmDelta(LlmDelta),
    Log(LogLine),
    ScreenFrame { data: Vec<u8> },
    Exited(RuntimeExited),
}

// ---------------------------------------------------------------------------
// Snapshot / Restore
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SnapshotRequest {
    pub handle_id: String,
    pub bundle_digest: Vec<u8>,
    pub isolation_class: IsolationClass,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SnapshotResponse {
    pub snapshot_uri: String,
    pub size_bytes: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RestoreRequest {
    pub snapshot_uri: String,
    pub run_id: String,
    pub input: serde_json::Value,
    pub env: std::collections::HashMap<String, String>,
    pub secrets: Vec<SecretRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RestoreResponse {
    pub handle_id: String,
    pub restore_ms: f64,
}
