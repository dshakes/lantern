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

use regex::bytes::Regex;

/// Default cap on bytes inspected per request (64 KiB).
pub const DEFAULT_MAX_INSPECT_BYTES: usize = 64 * 1024;
/// Ceiling on a policy's `max_inspect_bytes`: the broker buffers this much of
/// a guest-controlled body per connection, so it is never left unbounded.
pub const MAX_INSPECT_BYTES_CEILING: usize = 1024 * 1024;

/// Every detector the engine knows. The wire/API name of the caller-supplied
/// pattern detector is `custom_regex` (the control-plane, the DB CHECK and the
/// REST API all use it). Parity with the control-plane is pinned by
/// `services/testdata/dlp_detectors.json`.
pub const DETECTORS: &[&str] = &[
    "card_number",
    "secret_key",
    "email",
    "phone",
    "custom_regex",
];

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

/// Unknown (or empty) modes are an error, never a silent downgrade to
/// `audit`: a tenant that wrote `block` must not get less than it asked for.
impl std::str::FromStr for DlpMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "block" => Ok(DlpMode::Block),
            "audit" => Ok(DlpMode::Audit),
            "off" => Ok(DlpMode::Off),
            other => Err(format!("unknown DLP mode {other:?} (want off|audit|block)")),
        }
    }
}

impl DlpMode {
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
    /// Detector to run: one of [`DETECTORS`]. Unknown → compile error.
    pub detector: String,
    /// For `custom_regex`: the pattern. Ignored for built-ins.
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
    /// Override default inspect cap. 0 → [`DEFAULT_MAX_INSPECT_BYTES`];
    /// clamped to [`MAX_INSPECT_BYTES_CEILING`].
    #[serde(default)]
    pub max_inspect_bytes: usize,
}

impl DlpPolicy {
    pub fn effective_max(&self) -> usize {
        match self.max_inspect_bytes {
            0 => DEFAULT_MAX_INSPECT_BYTES,
            n => n.min(MAX_INSPECT_BYTES_CEILING),
        }
    }

    /// True if there is at least one non-Off rule (engine worth compiling).
    pub fn has_active_rules(&self) -> bool {
        self.rules.iter().any(|r| r.mode != DlpMode::Off)
    }

    /// True if any rule blocks (needs an enforcing broker).
    pub fn has_block_rules(&self) -> bool {
        self.rules.iter().any(|r| r.mode == DlpMode::Block)
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
    /// Compiled for `custom_regex` only.
    compiled: Option<Regex>,
}

/// Immutable compiled engine; one per VM lifetime.
pub struct DlpEngine {
    rules: Vec<CompiledRule>,
    pub max_inspect_bytes: usize,
}

impl DlpEngine {
    /// Compile a policy into an engine. Fails closed: an unknown detector or
    /// an empty/invalid `custom_regex` pattern is an error (the spawn fails),
    /// never a rule that silently matches nothing.
    pub fn compile(policy: DlpPolicy) -> Result<Self, String> {
        let max_inspect_bytes = policy.effective_max();
        let mut rules = Vec::with_capacity(policy.rules.len());
        for r in policy.rules {
            if !DETECTORS.contains(&r.detector.as_str()) {
                return Err(format!(
                    "dlp rule '{}': unknown detector {:?}",
                    r.rule_id, r.detector
                ));
            }
            if r.mode == DlpMode::Off {
                continue;
            }
            let compiled = if r.detector == "custom_regex" {
                if r.pattern.is_empty() {
                    return Err(format!(
                        "dlp rule '{}': custom_regex detector requires a pattern",
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

    /// True if any compiled rule blocks: the broker then fails closed when it
    /// cannot inspect a body completely.
    pub fn has_block_rules(&self) -> bool {
        self.rules.iter().any(|r| r.base.mode == DlpMode::Block)
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
        "custom_regex" => find_regex(compiled_regex?, data),
        // Unreachable: `compile` rejects unknown detectors.
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

/// Issuer plausibility on top of Luhn (1 in 10 random digit strings passes
/// Luhn alone): 13 digits = Visa (`4`), 14 = Diners (`30`/`36`/`38`), 15–19 =
/// major-industry identifier 2–6 (Mastercard 2/5, Amex/JCB 3, Visa 4,
/// Discover/UnionPay/Maestro 6). This drops epoch-ms / epoch-µs timestamps
/// (leading `1`), the commonest 13–16 digit false positive in API traffic.
fn plausible_card(d: &[u8]) -> bool {
    let issuer = match d.len() {
        13 => d[0] == b'4',
        14 => d.starts_with(b"30") || d.starts_with(b"36") || d.starts_with(b"38"),
        15..=19 => (b'2'..=b'6').contains(&d[0]),
        _ => false,
    };
    issuer && luhn_check(d)
}

/// Find the first plausible card number. A digit run is a sequence of digit
/// groups joined by a SINGLE space or dash; every window of whole groups that
/// holds 13–19 digits is checked, so trailing data in the same run
/// (`4532015112830366 12/30`) cannot hide the card. Returns (offset, len) in
/// bytes within `data` (raw text, including separators).
pub fn find_card_number(data: &[u8]) -> Option<(usize, usize)> {
    let n = data.len();
    let mut i = 0;
    while i < n {
        if !data[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        // Byte spans (start, end) of each digit group in this run.
        let mut groups: Vec<(usize, usize)> = Vec::new();
        let mut j = i;
        loop {
            let s = j;
            while j < n && data[j].is_ascii_digit() {
                j += 1;
            }
            groups.push((s, j));
            if j + 1 < n && matches!(data[j], b' ' | b'-') && data[j + 1].is_ascii_digit() {
                j += 1;
            } else {
                break;
            }
        }
        let mut digits: Vec<u8> = Vec::with_capacity(19);
        for a in 0..groups.len() {
            digits.clear();
            for &(s, e) in &groups[a..] {
                if digits.len() + (e - s) > 19 {
                    break;
                }
                digits.extend_from_slice(&data[s..e]);
                if digits.len() >= 13 && plausible_card(&digits) {
                    return Some((groups[a].0, e - groups[a].0));
                }
            }
        }
        i = j;
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
// custom_regex — caller-supplied compiled byte Regex
// ---------------------------------------------------------------------------

/// Byte regex: a body that is not valid UTF-8 is still scanned.
pub fn find_regex(re: &Regex, data: &[u8]) -> Option<(usize, usize)> {
    let m = re.find(data)?;
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
                detector: "custom_regex".to_string(),
                pattern: "[invalid".to_string(),
                mode: DlpMode::Block,
                threshold: 1,
            }],
            max_inspect_bytes: 0,
        });
        assert!(res.is_err());
    }

    // --- review fixes (ADR 0030 hardening) ---

    fn rule(id: &str, detector: &str, pattern: &str, mode: DlpMode) -> DlpRule {
        DlpRule {
            rule_id: id.into(),
            detector: detector.into(),
            pattern: pattern.into(),
            mode,
            threshold: 1,
        }
    }

    fn policy(rules: Vec<DlpRule>) -> DlpPolicy {
        DlpPolicy {
            rules,
            max_inspect_bytes: 0,
        }
    }

    /// #1: the detector set is pinned against the control-plane's, and every
    /// name the API accepts compiles here (custom_regex was inert before).
    #[test]
    fn detector_names_match_control_plane_fixture() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../testdata/dlp_detectors.json")).unwrap();
        let want: Vec<&str> = v["detectors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d.as_str().unwrap())
            .collect();
        assert_eq!(want, DETECTORS);
        for d in want {
            let pat = if d == "custom_regex" { "x" } else { "" };
            DlpEngine::compile(policy(vec![rule("r", d, pat, DlpMode::Block)]))
                .unwrap_or_else(|e| panic!("{d} must compile: {e}"));
        }
    }

    #[test]
    fn custom_regex_blocks() {
        let e = DlpEngine::compile(policy(vec![rule(
            "ssn",
            "custom_regex",
            r"SSN-\d{3}-\d{2}-\d{4}",
            DlpMode::Block,
        )]))
        .unwrap();
        assert!(matches!(
            e.scan(b"x SSN-123-45-6789 y"),
            DlpVerdict::Block(_)
        ));
    }

    /// #1: an unknown detector fails the compile (and so the spawn) instead
    /// of being a rule that never matches.
    #[test]
    fn unknown_detector_rejected_at_compile() {
        for d in ["regex", "credit_card", ""] {
            let res = DlpEngine::compile(policy(vec![rule("r", d, "x", DlpMode::Block)]));
            assert!(res.is_err(), "detector {d:?} accepted");
        }
        // Even on an `off` rule: a typo is a typo.
        assert!(DlpEngine::compile(policy(vec![rule("r", "nope", "", DlpMode::Off)])).is_err());
    }

    /// #6: unknown/empty modes are errors, never a silent `audit`.
    #[test]
    fn unknown_mode_is_an_error() {
        assert_eq!("block".parse::<DlpMode>(), Ok(DlpMode::Block));
        assert_eq!("audit".parse::<DlpMode>(), Ok(DlpMode::Audit));
        assert_eq!("off".parse::<DlpMode>(), Ok(DlpMode::Off));
        for m in ["", "Block", "enforce", "deny"] {
            assert!(m.parse::<DlpMode>().is_err(), "mode {m:?} accepted");
        }
    }

    /// #5: a body that is not valid UTF-8 is still scanned by custom_regex.
    #[test]
    fn custom_regex_scans_non_utf8() {
        let re = Regex::new(r"SECRET-\d+").unwrap();
        let mut data = vec![0xff, 0xfe, b' '];
        data.extend_from_slice(b"SECRET-42");
        assert_eq!(find_regex(&re, &data), Some((3, 9)));
    }

    /// #8: trailing data in the same digit run cannot hide a card.
    #[test]
    fn card_followed_by_more_digits_is_found() {
        for data in [
            &b"card 4532015112830366 12/30"[..],
            b"4532015112830366 1",
            b"4532 0151 1283 0366 7",
            b"ref 99 4532015112830366",
            b"4532-0151-1283-0366-12",
        ] {
            assert!(
                find_card_number(data).is_some(),
                "{}",
                String::from_utf8_lossy(data)
            );
        }
        // A double space ends the run: still found as its own run.
        assert!(find_card_number(b"12  4532015112830366").is_some());
    }

    /// #9: epoch-ms (13 digits) and epoch-µs (16 digits) timestamps are not
    /// cards, even when they pass Luhn.
    #[test]
    fn timestamps_are_not_cards() {
        let mut luhn_passing = 0;
        for k in 0..20_000u64 {
            for v in [1_730_000_000_000 + k * 7, 1_730_000_000_000_000 + k * 13] {
                let s = v.to_string();
                luhn_passing += usize::from(luhn_check(s.as_bytes()));
                let body = format!("{{\"ts\":{s},\"at\":\"{s}\"}}");
                assert!(find_card_number(body.as_bytes()).is_none(), "{s}");
            }
        }
        assert!(
            luhn_passing > 1000,
            "test must include Luhn-valid timestamps"
        );
        // Real issuers still match at 13/14 digits.
        assert!(find_card_number(b"4222222222222").is_some()); // Visa-13 test number
        assert!(find_card_number(b"30569309025904").is_some()); // Diners test number
    }

    /// #16: a huge or negative-derived cap is clamped, never trusted.
    #[test]
    fn max_inspect_bytes_is_clamped() {
        let mut p = policy(vec![]);
        assert_eq!(p.effective_max(), DEFAULT_MAX_INSPECT_BYTES);
        p.max_inspect_bytes = usize::MAX;
        assert_eq!(p.effective_max(), MAX_INSPECT_BYTES_CEILING);
        p.max_inspect_bytes = 10;
        assert_eq!(p.effective_max(), 10);
    }

    #[test]
    fn engine_empty_regex_rejected_at_compile() {
        let res = DlpEngine::compile(DlpPolicy {
            rules: vec![DlpRule {
                rule_id: "r1".to_string(),
                detector: "custom_regex".to_string(),
                pattern: String::new(),
                mode: DlpMode::Block,
                threshold: 1,
            }],
            max_inspect_bytes: 0,
        });
        assert!(res.is_err());
    }
}
