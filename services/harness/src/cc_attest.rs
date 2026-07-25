// Confidential-compute attestation: on boot, read the CC launch measurement
// (SEV-SNP report / TDX quote), sha256 it, and forward ONE `cc_attestation`
// audit frame through the existing report pipeline.
//
// placement + measurement recording implemented and unit-tested; attestation
// UNVERIFIED — not validated on SEV-SNP/TDX hardware; not a confidentiality
// guarantee.
//
// Design notes:
//   * Gated on LANTERN_CONFIDENTIAL — a no-op when not running in a CC context.
//   * Best-effort throughout: any I/O failure skips the measurement (never
//     fabricates a hash); the frame is always emitted regardless.
//   * Raw measurement bytes are NEVER logged (invariant #10); only the sha256
//     hex appears in the audit attrs.
//   * `verified = "false"` is a hard constant — the harness never validates the
//     measurement against a reference or a remote verifier.

use std::collections::HashMap;

use ring::digest;

use crate::manager_client::ManagerClient;
use crate::proto::{AuditEvent, HarnessReport, now_unix_ms};

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/// True when the harness should emit a cc_attestation frame.
///
/// Pure fn — takes the raw `LANTERN_CONFIDENTIAL` env value so the logic is
/// unit-testable without `setenv` (mirrors `resolve_fail_closed` in egress.rs).
pub fn should_attest(confidential_var: Option<&str>) -> bool {
    confidential_var
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("on"))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// cc_tech resolution
// ---------------------------------------------------------------------------

/// Resolve `cc_tech`: env override first, then device-presence detection.
///
/// Returns "sev-snp", "tdx", or "" (unknown / no device).
fn resolve_cc_tech() -> String {
    if let Ok(v) = std::env::var("LANTERN_CC_TECH")
        && !v.is_empty()
    {
        return v;
    }
    if std::path::Path::new("/dev/sev-guest").exists() {
        return "sev-snp".into();
    }
    if std::path::Path::new("/dev/tdx_guest").exists() {
        return "tdx".into();
    }
    String::new()
}

// ---------------------------------------------------------------------------
// Measurement read
// ---------------------------------------------------------------------------

/// Best-effort measurement read. Returns raw bytes, or `None` when no candidate
/// path yields non-empty content.
///
/// Ordered candidates:
///   1. `LANTERN_CC_MEASUREMENT_PATH` (if set and non-empty)
///   2. TSM configfs glob `/sys/kernel/config/tsm/report/*/outblob`
///   3. Raw device nodes `/dev/sev-guest`, `/dev/tdx_guest` as last resort
///
/// Any I/O error is silently skipped — the caller treats `None` as
/// "measurement unavailable" and still emits the frame with
/// `measurement_present = "false"`.
fn read_measurement() -> Option<Vec<u8>> {
    // 1. Explicit path override.
    if let Ok(path) = std::env::var("LANTERN_CC_MEASUREMENT_PATH")
        && !path.is_empty()
        && let Ok(b) = std::fs::read(&path)
        && !b.is_empty()
    {
        return Some(b);
    }

    // 2. TSM configfs glob: /sys/kernel/config/tsm/report/*/outblob
    let tsm_dir = std::path::Path::new("/sys/kernel/config/tsm/report");
    if tsm_dir.is_dir()
        && let Ok(entries) = std::fs::read_dir(tsm_dir)
    {
        for entry in entries.flatten() {
            let candidate = entry.path().join("outblob");
            if let Ok(b) = std::fs::read(&candidate)
                && !b.is_empty()
            {
                return Some(b);
            }
        }
    }

    // 3. Raw device nodes as last resort.
    for dev in ["/dev/sev-guest", "/dev/tdx_guest"] {
        if let Ok(b) = std::fs::read(dev)
            && !b.is_empty()
        {
            return Some(b);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Frame builder (pure — no I/O, fully testable)
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            use std::fmt::Write as _;
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// Build the `cc_attestation` audit frame. Pure fn — no I/O.
///
/// `measurement` is the raw bytes from the CC device (or `None` when
/// unavailable). The sha256 hex is computed here; raw bytes are never stored
/// in the frame (invariant #10).
pub fn build_frame(
    vm_id: &str,
    cc_tech: &str,
    runtime_class: &str,
    measurement: Option<&[u8]>,
) -> HarnessReport {
    let mut attrs: HashMap<String, String> = HashMap::new();
    attrs.insert("cc_tech".into(), cc_tech.to_string());
    attrs.insert("runtime_class".into(), runtime_class.to_string());
    // HARD RULE: verified is always "false" — the harness never validates the
    // measurement against a reference value or a remote attestation service.
    attrs.insert("verified".into(), "false".into());

    match measurement {
        Some(bytes) => {
            let hash = digest::digest(&digest::SHA256, bytes);
            attrs.insert("measurement_present".into(), "true".into());
            attrs.insert("measurement_sha256".into(), hex_encode(hash.as_ref()));
        }
        None => {
            attrs.insert("measurement_present".into(), "false".into());
            // measurement_sha256 key is intentionally absent when no measurement was read.
        }
    }

    HarnessReport::Audit(AuditEvent {
        vm_id: vm_id.to_string(),
        action: "cc_attestation".into(),
        at_unix_ms: now_unix_ms(),
        attrs,
    })
}

// ---------------------------------------------------------------------------
// Boot step
// ---------------------------------------------------------------------------

/// Emit the cc_attestation audit frame. Best-effort — never panics, never
/// blocks boot on I/O failure.
pub async fn run(manager: &ManagerClient) {
    let confidential = std::env::var("LANTERN_CONFIDENTIAL").ok();
    if !should_attest(confidential.as_deref()) {
        return;
    }

    let cc_tech = resolve_cc_tech();
    let runtime_class = std::env::var("LANTERN_RUNTIME_CLASS").unwrap_or_default();
    let measurement = read_measurement();
    let measurement_present = measurement.is_some();

    // Log at INFO — raw bytes stay out of the log (invariant #10); sha256 hex is safe.
    tracing::info!(
        cc_tech = %cc_tech,
        runtime_class = %runtime_class,
        measurement_present,
        "cc_attest: recording attestation frame \
         (UNVERIFIED — not validated on SEV-SNP/TDX hardware)"
    );

    let frame = build_frame(
        &manager.vm_id,
        &cc_tech,
        &runtime_class,
        measurement.as_deref(),
    );
    manager.enqueue_report(frame).await;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- should_attest --------------------------------------------------------

    #[test]
    fn should_attest_false_when_unset() {
        assert!(!should_attest(None));
    }

    #[test]
    fn should_attest_false_when_empty() {
        assert!(!should_attest(Some("")));
    }

    #[test]
    fn should_attest_true_when_one() {
        assert!(should_attest(Some("1")));
    }

    #[test]
    fn should_attest_true_when_true() {
        assert!(should_attest(Some("true")));
        assert!(should_attest(Some("True")));
        assert!(should_attest(Some("TRUE")));
    }

    #[test]
    fn should_attest_true_when_on() {
        assert!(should_attest(Some("on")));
        assert!(should_attest(Some("ON")));
    }

    #[test]
    fn should_attest_false_for_other_values() {
        assert!(!should_attest(Some("0")));
        assert!(!should_attest(Some("false")));
        assert!(!should_attest(Some("yes")));
    }

    // ---- build_frame: with measurement ----------------------------------------

    #[test]
    fn build_frame_with_measurement_sets_present_and_sha256() {
        let bytes = b"fake-measurement-data";
        let frame = build_frame("vm-abc", "sev-snp", "kata-cc", Some(bytes));
        let HarnessReport::Audit(a) = frame else {
            panic!("expected Audit variant");
        };
        assert_eq!(a.vm_id, "vm-abc");
        assert_eq!(a.action, "cc_attestation");
        assert_eq!(
            a.attrs.get("measurement_present").map(String::as_str),
            Some("true")
        );
        // sha256 must match the ring computation of the same bytes.
        let expected = {
            let h = digest::digest(&digest::SHA256, bytes);
            hex_encode(h.as_ref())
        };
        assert_eq!(
            a.attrs.get("measurement_sha256").map(String::as_str),
            Some(expected.as_str())
        );
        // 64 hex chars = 32 bytes of SHA-256
        assert_eq!(expected.len(), 64);
        assert_eq!(
            a.attrs.get("verified").map(String::as_str),
            Some("false"),
            "verified must always be false"
        );
    }

    // ---- build_frame: without measurement -------------------------------------

    #[test]
    fn build_frame_without_measurement_omits_sha_key() {
        let frame = build_frame("vm-xyz", "tdx", "kata-tdx", None);
        let HarnessReport::Audit(a) = frame else {
            panic!("expected Audit variant");
        };
        assert_eq!(
            a.attrs.get("measurement_present").map(String::as_str),
            Some("false")
        );
        assert!(
            !a.attrs.contains_key("measurement_sha256"),
            "measurement_sha256 key must be absent when no measurement was read"
        );
        assert_eq!(a.attrs.get("verified").map(String::as_str), Some("false"));
    }

    // ---- build_frame: field propagation --------------------------------------

    #[test]
    fn build_frame_cc_tech_and_runtime_class_propagate() {
        let frame = build_frame("vm-1", "sev-snp", "kata-cc-2024", Some(b"x"));
        let HarnessReport::Audit(a) = frame else {
            panic!("expected Audit variant");
        };
        assert_eq!(a.attrs.get("cc_tech").map(String::as_str), Some("sev-snp"));
        assert_eq!(
            a.attrs.get("runtime_class").map(String::as_str),
            Some("kata-cc-2024")
        );
    }

    #[test]
    fn build_frame_empty_cc_tech_and_runtime_class() {
        let frame = build_frame("vm-2", "", "", None);
        let HarnessReport::Audit(a) = frame else {
            panic!("expected Audit variant");
        };
        assert_eq!(a.attrs.get("cc_tech").map(String::as_str), Some(""));
        assert_eq!(a.attrs.get("runtime_class").map(String::as_str), Some(""));
    }
}
