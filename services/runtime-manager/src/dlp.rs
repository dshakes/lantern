//! Data-loss prevention (DLP) detectors and policy engine for the egress
//! broker (ADR 0030).
//!
//! # What is inspectable
//!
//! * **TLS-terminated injecting hosts and plain-HTTP allowlisted hosts** —
//!   request headers + up to [`DlpEngine::max_inspect_bytes`] of body.
//! * **Opaque CONNECT tunnels** — NOT inspected here; host/port/byte-rate only.
//!
//! # Invariant #10
//!
//! The matched bytes are **never** included in audit events, logs, or errors.
//! [`DlpMatch`] carries only offset/count, rule id, and detector name.

use regex::Regex;

/// Default cap on bytes inspected per request (64 KiB).
pub const DEFAULT_MAX_INSPECT_BYTES: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// Policy types (serialised in the proto/ScheduleRequest path)
// ---------------------------------------------------------------------------

/// Operating mode for one DLP rule.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DlpMode {
    Off,
    #[default]
    Audit,
    Block,
}

impl DlpMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "block" => DlpMode::Block,
            "off" => DlpMode::Off,
            _ => DlpMode::Audit,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DlpMode::Off => "off",
            DlpMode::Audit => "audit",
            DlpMode::Block => "block",
        }
    }
}

/// One DLP rule.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct DlpRule {
    /// Tenant-assigned stable identifier for this rule.
    pub rule_id: String,
    /// Detector to run: `card_number` | `secret_key` | `email` | `phone` | `regex`.
    pub detector: String,
    /// For `regex` detector: the RE2 pattern. Ignored for built-ins.
    #[serde(default)]
    pub pattern: String,
    /// Operating mode.
    pub mode: DlpMode,
    /// For `email` and `phone`: minimum match count before triggering (default 1).
    #[serde(default = "default_threshold")]
    pub threshold: u32,
}

fn default_threshold() -> u32 {
    1
}

/// Per-tenant DLP policy shipped in the spawn spec.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct DlpPolicy {
    pub rules: Vec<DlpRule>,
    /// Override default inspect cap. 0 → [`DEFAULT_MAX_INSPECT_BYTES`].
    #[serde(default)]
    pub max_inspect_bytes: usize,
}

impl DlpPolicy {
    pub fn effective_max(&self) -> usize {
        if self.max_inspect_bytes == 0 {
            DEFAULT_MAX_INSPECT_BYTES
        } else {
            self.max_inspect_bytes
        }
    }

    /// True if there is at least one non-Off rule (engine worth compiling).
    pub fn has_active_rules(&self) -> bool {
        self.rules.iter().any(|r| r.mode != DlpMode::Off)
    }
}

// ---------------------------------------------------------------------------
// Match / verdict types
// ---------------------------------------------------------------------------

/// A triggered rule (matched value **excluded** — invariant #10).
#[derive(Debug, Clone)]
pub struct DlpMatch {
    pub rule_id: String,
    pub detector: String,
    /// Byte offset of the FIRST match within the inspected data.
    pub byte_offset: usize,
    /// Byte span of the first match.
    pub byte_count: usize,
}

/// Result of running all rules over an inspected chunk.
#[derive(Debug)]
pub enum DlpVerdict {
    /// No rule triggered.
    Clean,
    /// At least one Audit rule triggered; no Block rule.
    Audit(DlpMatch),
    /// At least one Block rule triggered (may co-occur with Audit rules).
    Block(DlpMatch),
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

struct CompiledRule {
    base: DlpRule,
    /// Compiled for `regex` detector only.
    compiled: Option<Regex>,
}

/// Immutable compiled engine; one per VM lifetime.
pub struct DlpEngine {
    rules: Vec<CompiledRule>,
    pub max_inspect_bytes: usize,
}

impl DlpEngine {
    /// Compile a policy into an engine. Returns an error if any `regex` rule
    /// has an invalid pattern (compilation happens here, not at scan time).
    pub fn compile(policy: DlpPolicy) -> Result<Self, String> {
        let max_inspect_bytes = policy.effective_max();
        let mut rules = Vec::with_capacity(policy.rules.len());
        for r in policy.rules {
            if r.mode == DlpMode::Off {
                continue;
            }
            let compiled = if r.detector == "regex" {
                if r.pattern.is_empty() {
                    return Err(format!(
                        "dlp rule '{}': regex detector requires a pattern",
                        r.rule_id
                    ));
                }
                Some(
                    Regex::new(&r.pattern)
                        .map_err(|e| format!("dlp rule '{}': invalid regex: {e}", r.rule_id))?,
                )
            } else {
                None
            };
            rules.push(CompiledRule { base: r, compiled });
        }
        Ok(Self {
            rules,
            max_inspect_bytes,
        })
    }

    /// Scan `data` (request headers + early body bytes up to the cap).
    ///
    /// Block rules are evaluated before Audit rules in order; the first Block
    /// match returns immediately.
    pub fn scan(&self, data: &[u8]) -> DlpVerdict {
        let mut first_audit: Option<DlpMatch> = None;
        for rule in &self.rules {
            let Some((off, cnt)) = run_detector(
                &rule.base.detector,
                rule.compiled.as_ref(),
                data,
                rule.base.threshold,
            ) else {
                continue;
            };
            let m = DlpMatch {
                rule_id: rule.base.rule_id.clone(),
                detector: rule.base.detector.clone(),
                byte_offset: off,
                byte_count: cnt,
            };
            match rule.base.mode {
                DlpMode::Block => return DlpVerdict::Block(m),
                DlpMode::Audit => {
                    if first_audit.is_none() {
                        first_audit = Some(m);
                    }
                }
                DlpMode::Off => {}
            }
        }
        match first_audit {
            Some(m) => DlpVerdict::Audit(m),
            None => DlpVerdict::Clean,
        }
    }
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

fn run_detector(
    detector: &str,
    compiled_regex: Option<&Regex>,
    data: &[u8],
    threshold: u32,
) -> Option<(usize, usize)> {
    match detector {
        "card_number" => find_card_number(data),
        "secret_key" => find_secret_key(data),
        "email" => find_email(data, threshold),
        "phone" => find_phone(data, threshold),
        "regex" => find_regex(compiled_regex?, data),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// card_number — Luhn-validated 13–19 digit sequences (spaces/dashes stripped)
// ---------------------------------------------------------------------------

fn luhn_check(digits: &[u8]) -> bool {
    let n = digits.len();
    if !(13..=19).contains(&n) {
        return false;
    }
    let mut sum = 0u32;
    let mut double = false;
    for &d in digits.iter().rev() {
        let mut v = (d - b'0') as u32;
        if double {
            v *= 2;
            if v > 9 {
                v -= 9;
            }
        }
        sum += v;
        double = !double;
    }
    sum.is_multiple_of(10)
}

/// Find the first Luhn-passing card-number sequence. Returns (offset, len)
/// in bytes within `data` (raw text, including any separators).
pub fn find_card_number(data: &[u8]) -> Option<(usize, usize)> {
    let n = data.len();
    let mut i = 0;
    while i < n {
        if !data[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut digits: Vec<u8> = Vec::with_capacity(19);
        let mut j = i;
        while j < n && digits.len() <= 19 {
            match data[j] {
                b if b.is_ascii_digit() => {
                    digits.push(b);
                    j += 1;
                }
                b' ' | b'-' => {
                    j += 1;
                }
                _ => break,
            }
        }
        if (13..=19).contains(&digits.len()) && luhn_check(&digits) {
            return Some((start, j - start));
        }
        i += 1;
    }
    None
}

// ---------------------------------------------------------------------------
// secret_key — common API / private-key token prefixes
//
// These byte-string literals are well-known, publicly documented token shapes
// for each provider, not actual secrets. The detector scans for their presence
// in outbound request bytes.
// ---------------------------------------------------------------------------

// ponytail: memmem over a fixed 15-pattern table is O(n*k) but k=15 and the
// data cap is 64 KiB — no AhoCorasick needed at this scale.
fn secret_key_prefixes() -> &'static [&'static [u8]] {
    &[
        b"AKIA",                            // allowlist secret — AWS permanent access key prefix
        b"ASIA",                            // allowlist secret — AWS STS session key prefix
        b"ghp_",                            // allowlist secret — GitHub PAT v1
        b"gho_",                            // allowlist secret — GitHub OAuth token
        b"ghs_",                            // allowlist secret — GitHub app token
        b"ghr_",                            // allowlist secret — GitHub refresh token
        b"github_pat_",                     // allowlist secret — GitHub PAT v2
        b"xoxb-",                           // allowlist secret — Slack bot token
        b"xoxp-",                           // allowlist secret — Slack user token
        b"xoxa-",                           // allowlist secret — Slack app token
        b"xoxe.",                           // allowlist secret — Slack SCIM/Events token
        b"-----BEGIN PRIVATE KEY-----",     // allowlist secret — PKCS#8 PEM unencrypted
        b"-----BEGIN RSA PRIVATE KEY-----", // allowlist secret — PKCS#1 PEM
        b"-----BEGIN EC PRIVATE KEY-----",  // allowlist secret — SEC1 PEM
        b"-----BEGIN DSA PRIVATE KEY-----", // allowlist secret — DSA PEM
    ]
}

/// GCP service-account JSON marker.
// allowlist secret
const GCP_SA_JSON_FIELD: &[u8] = b"\"private_key\"";

pub fn find_secret_key(data: &[u8]) -> Option<(usize, usize)> {
    for &prefix in secret_key_prefixes() {
        if let Some(off) = memmem(data, prefix) {
            let end = (off + prefix.len() + 4).min(data.len());
            return Some((off, end - off));
        }
    }
    if let Some(off) = memmem(data, GCP_SA_JSON_FIELD) {
        return Some((off, GCP_SA_JSON_FIELD.len()));
    }
    None
}

/// Naive substring search — no external crate for the fixed pattern table.
fn memmem(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ---------------------------------------------------------------------------
// email — RFC-ish `local@domain.tld`
// ---------------------------------------------------------------------------

pub fn find_email(data: &[u8], threshold: u32) -> Option<(usize, usize)> {
    let mut count = 0u32;
    let mut first = None;
    let n = data.len();
    for i in 1..n.saturating_sub(3) {
        if data[i] != b'@' {
            continue;
        }
        if !data[i - 1].is_ascii_alphanumeric() || !data[i + 1].is_ascii_alphanumeric() {
            continue;
        }
        let domain_end = {
            let mut j = i + 1;
            while j < n && (data[j].is_ascii_alphanumeric() || data[j] == b'.' || data[j] == b'-') {
                j += 1;
            }
            j
        };
        let domain = &data[i + 1..domain_end];
        if !domain.contains(&b'.') {
            continue;
        }
        count += 1;
        if first.is_none() {
            let mut start = i;
            while start > 0
                && (data[start - 1].is_ascii_alphanumeric() || b".-_+%".contains(&data[start - 1]))
            {
                start -= 1;
            }
            first = Some((start, domain_end - start));
        }
        if count >= threshold {
            return first;
        }
    }
    None
}

// ---------------------------------------------------------------------------
// phone — E.164 (`+` + 7–15 digits) or North American 10-digit
// ---------------------------------------------------------------------------

pub fn find_phone(data: &[u8], threshold: u32) -> Option<(usize, usize)> {
    let mut count = 0u32;
    let mut first = None;
    let n = data.len();
    let mut i = 0;
    while i < n {
        if data[i] == b'+' {
            let start = i;
            let mut j = i + 1;
            let mut digits = 0usize;
            while j < n && digits <= 15 {
                match data[j] {
                    b if b.is_ascii_digit() => {
                        digits += 1;
                        j += 1;
                    }
                    b' ' | b'-' | b'(' | b')' | b'.' => {
                        j += 1;
                    }
                    _ => break,
                }
            }
            if (7..=15).contains(&digits) {
                count += 1;
                if first.is_none() {
                    first = Some((start, j - start));
                }
                if count >= threshold {
                    return first;
                }
                i = j;
                continue;
            }
        }
        if data[i].is_ascii_digit() {
            let start = i;
            let mut j = i;
            let mut digits = 0usize;
            while j < n && digits <= 10 {
                match data[j] {
                    b if b.is_ascii_digit() => {
                        digits += 1;
                        j += 1;
                    }
                    b' ' | b'-' | b'(' | b')' | b'.' => {
                        j += 1;
                    }
                    _ => break,
                }
            }
            if digits == 10 {
                count += 1;
                if first.is_none() {
                    first = Some((start, j - start));
                }
                if count >= threshold {
                    return first;
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
    None
}

// ---------------------------------------------------------------------------
// regex — caller-supplied compiled Regex
// ---------------------------------------------------------------------------

pub fn find_regex(re: &Regex, data: &[u8]) -> Option<(usize, usize)> {
    let s = std::str::from_utf8(data).ok()?;
    let m = re.find(s)?;
    Some((m.start(), m.end() - m.start()))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- Luhn check ---

    #[test]
    fn luhn_visa() {
        // Luhn test vector — not a real card number.
        let digits = b"4532015112830366";
        assert!(luhn_check(digits));
    }

    #[test]
    fn luhn_invalid() {
        let digits = b"4532015112830367"; // last digit wrong
        assert!(!luhn_check(digits));
    }

    #[test]
    fn luhn_too_short() {
        assert!(!luhn_check(b"453201511283")); // 12 digits
    }

    // --- card_number ---

    #[test]
    fn card_number_found_in_header() {
        let data = b"X-Card: 4532015112830366\r\n";
        assert!(find_card_number(data).is_some());
    }

    #[test]
    fn card_number_dashes_allowed() {
        let data = b"card=4532-0151-1283-0366";
        assert!(find_card_number(data).is_some());
    }

    #[test]
    fn card_number_false_positive_fails_luhn() {
        // 16 repeated 1s: no 13-19-digit subsequence passes Luhn (sum ≡ 2k mod 10, k≤9).
        let data = b"id=1111111111111111";
        assert!(find_card_number(data).is_none());
    }

    // --- secret_key ---

    // Build test vectors at runtime to avoid triggering commit hooks.
    fn aws_key_sample() -> Vec<u8> {
        // allowlist secret
        let mut v = b"key: ".to_vec();
        v.extend_from_slice(b"AKIA"); // allowlist secret
        v.extend_from_slice(b"1234567890ABCDEF");
        v
    }

    fn github_pat_sample() -> Vec<u8> {
        // allowlist secret
        let mut v = b"token: ".to_vec();
        v.extend_from_slice(b"ghp_"); // allowlist secret
        v.extend_from_slice(b"abcdefghijklmnopqrstuvwxyz123456");
        v
    }

    fn slack_sample() -> Vec<u8> {
        // allowlist secret
        let mut v = b"Authorization: Bearer ".to_vec();
        v.extend_from_slice(b"xoxb-"); // allowlist secret
        v.extend_from_slice(b"123-456-abc");
        v
    }

    #[test]
    fn secret_key_aws() {
        assert!(find_secret_key(&aws_key_sample()).is_some());
    }

    #[test]
    fn secret_key_github_pat() {
        assert!(find_secret_key(&github_pat_sample()).is_some());
    }

    #[test]
    fn secret_key_slack() {
        assert!(find_secret_key(&slack_sample()).is_some());
    }

    #[test]
    fn secret_key_not_present() {
        let data = b"GET /api/v1/users HTTP/1.1\r\nHost: api.example.com\r\n\r\n";
        assert!(find_secret_key(data).is_none());
    }

    // --- email ---

    #[test]
    fn email_found() {
        let data = b"to=user@example.com&subject=hi";
        assert!(find_email(data, 1).is_some());
    }

    #[test]
    fn email_threshold() {
        let data = b"a@b.com c@d.com";
        assert!(find_email(data, 2).is_some());
        assert!(find_email(data, 3).is_none());
    }

    #[test]
    fn email_no_dot_domain() {
        let data = b"user@localhost";
        assert!(find_email(data, 1).is_none());
    }

    // --- phone ---

    #[test]
    fn phone_e164() {
        let data = b"call +14155552671";
        assert!(find_phone(data, 1).is_some());
    }

    #[test]
    fn phone_us_10digits() {
        let data = b"tel: (415) 555-2671";
        assert!(find_phone(data, 1).is_some());
    }

    #[test]
    fn phone_threshold() {
        let data = b"+14155552671 +14155552672";
        assert!(find_phone(data, 2).is_some());
        assert!(find_phone(data, 3).is_none());
    }

    #[test]
    fn phone_too_short() {
        let data = b"+12345"; // 5 digits — below minimum
        assert!(find_phone(data, 1).is_none());
    }

    // --- regex ---

    #[test]
    fn regex_match() {
        let re = Regex::new(r"SSN-\d{3}-\d{2}-\d{4}").unwrap();
        let data = b"SSN-123-45-6789";
        assert!(find_regex(&re, data).is_some());
    }

    #[test]
    fn regex_no_match() {
        let re = Regex::new(r"SSN-\d{3}-\d{2}-\d{4}").unwrap();
        let data = b"nothing here";
        assert!(find_regex(&re, data).is_none());
    }

    // --- DlpEngine ---

    fn card_rule(mode: DlpMode) -> DlpRule {
        DlpRule {
            rule_id: "r1".to_string(),
            detector: "card_number".to_string(),
            pattern: String::new(),
            mode,
            threshold: 1,
        }
    }

    fn card_data() -> &'static [u8] {
        b"card=4532015112830366"
    }

    fn clean_data() -> &'static [u8] {
        b"GET /api/health HTTP/1.1\r\nHost: api.example.com\r\n\r\n"
    }

    #[test]
    fn engine_audit_mode() {
        let engine = DlpEngine::compile(DlpPolicy {
            rules: vec![card_rule(DlpMode::Audit)],
            max_inspect_bytes: 0,
        })
        .unwrap();
        assert!(matches!(engine.scan(card_data()), DlpVerdict::Audit(_)));
    }

    #[test]
    fn engine_block_mode() {
        let engine = DlpEngine::compile(DlpPolicy {
            rules: vec![card_rule(DlpMode::Block)],
            max_inspect_bytes: 0,
        })
        .unwrap();
        assert!(matches!(engine.scan(card_data()), DlpVerdict::Block(_)));
    }

    #[test]
    fn engine_clean() {
        let engine = DlpEngine::compile(DlpPolicy {
            rules: vec![card_rule(DlpMode::Block)],
            max_inspect_bytes: 0,
        })
        .unwrap();
        assert!(matches!(engine.scan(clean_data()), DlpVerdict::Clean));
    }

    #[test]
    fn engine_off_rule_ignored() {
        let engine = DlpEngine::compile(DlpPolicy {
            rules: vec![card_rule(DlpMode::Off)],
            max_inspect_bytes: 0,
        })
        .unwrap();
        assert!(matches!(engine.scan(card_data()), DlpVerdict::Clean));
    }

    #[test]
    fn engine_block_beats_audit() {
        let engine = DlpEngine::compile(DlpPolicy {
            rules: vec![
                DlpRule {
                    rule_id: "audit-email".to_string(),
                    detector: "email".to_string(),
                    pattern: String::new(),
                    mode: DlpMode::Audit,
                    threshold: 1,
                },
                DlpRule {
                    rule_id: "block-card".to_string(),
                    detector: "card_number".to_string(),
                    pattern: String::new(),
                    mode: DlpMode::Block,
                    threshold: 1,
                },
            ],
            max_inspect_bytes: 0,
        })
        .unwrap();
        let data = b"email=user@example.com&card=4532015112830366";
        assert!(matches!(engine.scan(data), DlpVerdict::Block(_)));
    }

    #[test]
    fn engine_no_value_in_match() {
        // Invariant #10: DlpMatch must never expose the matched bytes.
        let engine = DlpEngine::compile(DlpPolicy {
            rules: vec![card_rule(DlpMode::Audit)],
            max_inspect_bytes: 0,
        })
        .unwrap();
        if let DlpVerdict::Audit(m) = engine.scan(card_data()) {
            assert_eq!(m.rule_id, "r1");
            assert_eq!(m.detector, "card_number");
            // Only offset + count are available; the value itself is absent.
            let _ = (m.byte_offset, m.byte_count);
        } else {
            panic!("expected Audit verdict");
        }
    }

    #[test]
    fn engine_invalid_regex_rejected_at_compile() {
        let res = DlpEngine::compile(DlpPolicy {
            rules: vec![DlpRule {
                rule_id: "r1".to_string(),
                detector: "regex".to_string(),
                pattern: "[invalid".to_string(),
                mode: DlpMode::Block,
                threshold: 1,
            }],
            max_inspect_bytes: 0,
        });
        assert!(res.is_err());
    }

    #[test]
    fn engine_empty_regex_rejected_at_compile() {
        let res = DlpEngine::compile(DlpPolicy {
            rules: vec![DlpRule {
                rule_id: "r1".to_string(),
                detector: "regex".to_string(),
                pattern: String::new(),
                mode: DlpMode::Block,
                threshold: 1,
            }],
            max_inspect_bytes: 0,
        });
        assert!(res.is_err());
    }
}
