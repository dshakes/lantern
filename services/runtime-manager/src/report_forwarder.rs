//! Report forwarder (Task 5).
//!
//! The `RuntimeHarness.Report` RPC is client-streaming: the in-VM harness
//! sends a stream of [`pb::HarnessReport`] messages (logs, OTLP traces,
//! Prometheus metrics, audit events).  The manager's job is to forward them
//! to the control-plane.
//!
//! # Forwarding contract
//!
//! Each received message is forwarded via:
//!
//! ```text
//! POST {LANTERN_CONTROL_PLANE_URL}/v1/runtime/report
//! X-Lantern-Runtime-Token: {LANTERN_RUNTIME_SECRET_TOKEN}
//! Content-Type: application/json
//! ```
//!
//! Body JSON shape (all fields from the registry + message payload):
//!
//! ```json
//! {
//!   "vm_id":              "vm-abc123",
//!   "tenant_id":          "acme",
//!   "run_id":             "run-xyz",
//!   "kind":               "log" | "otlp_traces" | "prometheus_metrics" | "audit",
//!   "log":                { "vm_id": "...", "stream": "stdout", "text": "..." },
//!   "otlp_traces_b64":    "<base64>",
//!   "prometheus_b64":     "<base64>",
//!   "audit":              { "vm_id": "...", "action": "egress", "attrs": {} }
//! }
//! ```
//!
//! Only the field matching `kind` is populated; the others are absent.
//!
//! # Fail-graceful policy
//!
//! - On forward failure: log with `tracing::error!`; DO NOT crash the workload,
//!   DO NOT return an error to the harness (which would cause the harness to
//!   reconnect and replay).
//! - Audit events that fail to forward are logged at ERROR level so they appear
//!   in the manager's own log trail — never silently dropped.
//! - When `LANTERN_CONTROL_PLANE_URL` / `LANTERN_RUNTIME_SECRET_TOKEN` are
//!   unset (dev), messages are logged locally instead of forwarded.
//!
//! # Pure request-construction function
//!
//! [`build_report_request`] constructs the [`ReportPayload`] from registry
//! info + a proto message; it is pure and unit-testable without a live HTTP
//! server or cluster.

use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;

use crate::proto::pb;

/// Environment variables used to configure forwarding.
/// Re-export from `secret_resolver` so callers have one import.
pub use crate::secret_resolver::{ENV_CONTROL_PLANE_URL, ENV_RUNTIME_SECRET_TOKEN};

/// HTTP timeout for each report forward call.
const FORWARD_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

/// JSON body sent to `POST /v1/runtime/report`.
#[derive(Debug, Serialize, PartialEq)]
pub struct ReportPayload {
    pub vm_id: String,
    pub tenant_id: String,
    pub run_id: String,
    /// Discriminator: `"log"`, `"otlp_traces"`, `"prometheus_metrics"`, or
    /// `"audit"`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<LogPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub otlp_traces_b64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prometheus_b64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audit: Option<AuditPayload>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct LogPayload {
    pub vm_id: String,
    pub stream: String,
    pub text: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct AuditPayload {
    pub vm_id: String,
    pub action: String,
    pub attrs: std::collections::HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Pure builder (unit-testable without network or cluster)
// ---------------------------------------------------------------------------

/// Build the [`ReportPayload`] for one [`pb::HarnessReport`] message.
///
/// **Caller's responsibility:** the `vm_id`, `tenant_id`, and `run_id` passed
/// here must already be cert-bound by the RPC handler (via
/// `crate::tls::authorize_vm_cert`) before calling this function.  The builder
/// itself is a pure data transformer and does not perform authentication.
///
/// Returns `None` when the message body is unset / unrecognised (defensive;
/// the proto `oneof body` should always have exactly one variant set).
pub fn build_report_request(
    vm_id: &str,
    tenant_id: &str,
    run_id: &str,
    report: &pb::HarnessReport,
) -> Option<ReportPayload> {
    use pb::harness_report::Body;

    let body = report.body.as_ref()?;

    let payload = match body {
        Body::Log(log_line) => ReportPayload {
            vm_id: vm_id.to_string(),
            tenant_id: tenant_id.to_string(),
            run_id: run_id.to_string(),
            kind: "log".to_string(),
            log: Some(LogPayload {
                vm_id: log_line.vm_id.clone(),
                stream: log_line.stream.clone(),
                text: log_line.text.clone(),
            }),
            otlp_traces_b64: None,
            prometheus_b64: None,
            audit: None,
        },
        Body::OtlpTraces(bytes) => ReportPayload {
            vm_id: vm_id.to_string(),
            tenant_id: tenant_id.to_string(),
            run_id: run_id.to_string(),
            kind: "otlp_traces".to_string(),
            log: None,
            otlp_traces_b64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            prometheus_b64: None,
            audit: None,
        },
        Body::PrometheusMetrics(bytes) => ReportPayload {
            vm_id: vm_id.to_string(),
            tenant_id: tenant_id.to_string(),
            run_id: run_id.to_string(),
            kind: "prometheus_metrics".to_string(),
            log: None,
            otlp_traces_b64: None,
            prometheus_b64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            audit: None,
        },
        Body::Audit(audit) => ReportPayload {
            vm_id: vm_id.to_string(),
            tenant_id: tenant_id.to_string(),
            run_id: run_id.to_string(),
            kind: "audit".to_string(),
            log: None,
            otlp_traces_b64: None,
            prometheus_b64: None,
            audit: Some(AuditPayload {
                vm_id: audit.vm_id.clone(),
                action: audit.action.clone(),
                attrs: audit.attrs.clone(),
            }),
        },
    };

    Some(payload)
}

// ---------------------------------------------------------------------------
// Forwarding decision
// ---------------------------------------------------------------------------

/// Whether forwarding to the control-plane is configured in this process.
///
/// Returns `Some((url, token))` when both env vars are set and non-empty.
/// Returns `None` (dev/local mode) when either is absent.
pub fn forward_config() -> Option<(String, String)> {
    let url = std::env::var(ENV_CONTROL_PLANE_URL)
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    let token = std::env::var(ENV_RUNTIME_SECRET_TOKEN)
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    Some((url, token))
}

// ---------------------------------------------------------------------------
// Async forwarder (requires network; not unit-tested directly)
// ---------------------------------------------------------------------------

/// Forward a single [`ReportPayload`] to the control-plane.
///
/// - On HTTP success (2xx): logs at DEBUG.
/// - On forward failure: logs at ERROR, does NOT panic.
/// - Audit payloads that fail are additionally logged at ERROR so the audit
///   record is preserved in the manager's own log trail.
pub async fn forward_report(
    client: &reqwest::Client,
    control_plane_url: &str,
    token: &str,
    payload: &ReportPayload,
) {
    let url = format!("{control_plane_url}/v1/runtime/report");

    let result = client
        .post(&url)
        .header("X-Lantern-Runtime-Token", token)
        .header("Content-Type", "application/json")
        .json(payload)
        .send()
        .await;

    match result {
        Ok(resp) if resp.status().is_success() => {
            tracing::debug!(
                vm_id = %payload.vm_id,
                kind = %payload.kind,
                "report: forwarded to control-plane"
            );
        }
        Ok(resp) => {
            let status = resp.status().as_u16();
            tracing::error!(
                vm_id = %payload.vm_id,
                kind = %payload.kind,
                http_status = status,
                "report: forward returned non-2xx; message NOT re-queued"
            );
            if payload.kind == "audit" {
                // Audit events must never be silently dropped.
                tracing::error!(
                    vm_id = %payload.vm_id,
                    audit_action = payload
                        .audit
                        .as_ref()
                        .map(|a| a.action.as_str())
                        .unwrap_or("unknown"),
                    "AUDIT DROP: failed to forward audit event to control-plane (http {status})"
                );
            }
        }
        Err(e) => {
            tracing::error!(
                vm_id = %payload.vm_id,
                kind = %payload.kind,
                error = %e,
                "report: HTTP send failed; message NOT re-queued"
            );
            if payload.kind == "audit" {
                tracing::error!(
                    vm_id = %payload.vm_id,
                    audit_action = payload
                        .audit
                        .as_ref()
                        .map(|a| a.action.as_str())
                        .unwrap_or("unknown"),
                    "AUDIT DROP: failed to forward audit event to control-plane ({e})"
                );
            }
        }
    }
}

/// Build a shared reqwest client for report forwarding (5 s timeout).
pub fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(FORWARD_TIMEOUT)
        .build()
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tests for the pure builder
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn log_report(vm_id: &str, stream: &str, text: &str) -> pb::HarnessReport {
        pb::HarnessReport {
            body: Some(pb::harness_report::Body::Log(pb::RuntimeLogLine {
                vm_id: vm_id.to_string(),
                stream: stream.to_string(),
                text: text.to_string(),
                at: None,
                attrs: Default::default(),
            })),
        }
    }

    fn audit_report(vm_id: &str, action: &str) -> pb::HarnessReport {
        pb::HarnessReport {
            body: Some(pb::harness_report::Body::Audit(pb::AuditEvent {
                vm_id: vm_id.to_string(),
                action: action.to_string(),
                at: None,
                attrs: Default::default(),
            })),
        }
    }

    fn otlp_report(bytes: Vec<u8>) -> pb::HarnessReport {
        pb::HarnessReport {
            body: Some(pb::harness_report::Body::OtlpTraces(bytes)),
        }
    }

    fn prom_report(bytes: Vec<u8>) -> pb::HarnessReport {
        pb::HarnessReport {
            body: Some(pb::harness_report::Body::PrometheusMetrics(bytes)),
        }
    }

    // --- identity fields come from registry, not harness ---

    #[test]
    fn log_payload_carries_registry_identity() {
        let report = log_report("harness-vm-id", "stdout", "hello from agent");
        let payload =
            build_report_request("registry-vm", "acme", "run-001", &report).expect("Some");

        assert_eq!(
            payload.vm_id, "registry-vm",
            "vm_id from registry, not harness"
        );
        assert_eq!(payload.tenant_id, "acme");
        assert_eq!(payload.run_id, "run-001");
        assert_eq!(payload.kind, "log");
        let log = payload.log.expect("log field set");
        assert_eq!(log.text, "hello from agent");
        assert_eq!(log.stream, "stdout");
        assert!(payload.audit.is_none());
        assert!(payload.otlp_traces_b64.is_none());
        assert!(payload.prometheus_b64.is_none());
    }

    #[test]
    fn audit_payload_correct_kind() {
        let report = audit_report("vm-1", "egress");
        let payload = build_report_request("vm-1", "t1", "r1", &report).expect("Some");

        assert_eq!(payload.kind, "audit");
        let audit = payload.audit.expect("audit field set");
        assert_eq!(audit.action, "egress");
        assert!(payload.log.is_none());
    }

    #[test]
    fn otlp_payload_is_base64_encoded() {
        let raw = b"fake-otlp-bytes";
        let report = otlp_report(raw.to_vec());
        let payload = build_report_request("vm-1", "t1", "r1", &report).expect("Some");

        assert_eq!(payload.kind, "otlp_traces");
        let b64 = payload.otlp_traces_b64.expect("otlp field set");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .expect("valid base64");
        assert_eq!(decoded, raw);
        assert!(payload.log.is_none());
        assert!(payload.audit.is_none());
    }

    #[test]
    fn prometheus_payload_is_base64_encoded() {
        let raw = b"# HELP my_metric\nmy_metric 42\n";
        let report = prom_report(raw.to_vec());
        let payload = build_report_request("vm-1", "t1", "r1", &report).expect("Some");

        assert_eq!(payload.kind, "prometheus_metrics");
        let b64 = payload.prometheus_b64.expect("prom field set");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .expect("valid base64");
        assert_eq!(decoded, raw);
        assert!(payload.log.is_none());
        assert!(payload.audit.is_none());
    }

    #[test]
    fn empty_body_returns_none() {
        let report = pb::HarnessReport { body: None };
        let result = build_report_request("vm-1", "t1", "r1", &report);
        assert!(result.is_none(), "None body must return None");
    }

    // --- forward_config reads from env ---

    #[test]
    fn forward_config_returns_none_when_vars_absent() {
        // Only reliable when the vars are definitely NOT set in the test env.
        // We don't mutate std::env to avoid thread-safety issues in parallel tests.
        if std::env::var(ENV_CONTROL_PLANE_URL).is_ok()
            && std::env::var(ENV_RUNTIME_SECRET_TOKEN).is_ok()
        {
            // Both vars happen to be set in CI env; skip this assertion.
            return;
        }
        // At least one is absent → forward_config returns None.
        assert!(
            forward_config().is_none(),
            "forward_config must return None when either env var is absent"
        );
    }
}
