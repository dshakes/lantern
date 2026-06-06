// Egress: an in-VM HTTP CONNECT proxy at 127.0.0.1:3128 that enforces the
// AgentSpec.egress_rules allowlist.
//
// Production setup (documented for the VM image builder):
//
//   1. Host firewall (nftables on the worker node) DROPs all outbound
//      traffic from the VM's tap interface EXCEPT to 127.0.0.1:3128.
//
//   2. Inside the VM, iptables redirects all outbound TCP to 3128:
//        iptables -t nat -A OUTPUT -p tcp -m owner ! --uid-owner harness \
//                 -j REDIRECT --to-ports 3128
//      (the harness runs as uid `harness` so its own RPC calls bypass.)
//
//   3. DNS goes through a stub resolver bound to 127.0.0.1:53 that only
//      resolves names matching the allowlist patterns.
//
// v1 implements HTTP CONNECT termination + pattern matching. Full L7
// (header/method enforcement, per-rule rate buckets) is wired as the
// `EgressPolicy::evaluate` decision point — extend that and the rest of
// the pipeline keeps working.

use std::net::IpAddr;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;

use crate::manager_client::ManagerClient;
use crate::proto::{AuditEvent, EgressRule, HarnessReport, now_unix_ms};

#[derive(Clone, Debug)]
pub enum Decision {
    Allow,
    Deny(&'static str),
}

// ---------------------------------------------------------------------------
// H4 (a): port allowlist
//
// Default: only port 443 is permitted.  The operator may widen this via
// `LANTERN_EGRESS_ALLOWED_PORTS` (comma-separated list of u16).  An empty
// env var re-applies the default (443 only).
// ---------------------------------------------------------------------------

/// Parse the allowed-ports configuration from the environment.
/// Returns a `Vec` of allowed ports; default is `[443]`.
fn allowed_ports_from_env() -> Vec<u16> {
    match std::env::var("LANTERN_EGRESS_ALLOWED_PORTS") {
        Ok(raw) if !raw.trim().is_empty() => raw
            .split(',')
            .filter_map(|s| s.trim().parse::<u16>().ok())
            .collect(),
        _ => vec![443],
    }
}

// ---------------------------------------------------------------------------
// H4 (b): private / metadata IP rejection
//
// Any target that resolves to (or is written as) a private, link-local,
// loopback, or multicast address is unconditionally denied.  This prevents
// SSRF via an allow-listed hostname that has been poisoned to point at the
// EC2 / GCP metadata endpoint (169.254.169.254) or any RFC-1918 range.
// ---------------------------------------------------------------------------

/// Return true if the address falls within any range that must never be
/// reachable from a workload: RFC 1918, link-local (169.254.0.0/16 incl.
/// 169.254.169.254), loopback, IPv6 loopback / ULA / link-local.
pub fn is_private_or_metadata(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            // 10.0.0.0/8
            o[0] == 10
            // 172.16.0.0/12
            || (o[0] == 172 && (o[1] & 0xf0) == 16)
            // 192.168.0.0/16
            || (o[0] == 192 && o[1] == 168)
            // 127.0.0.0/8 loopback
            || o[0] == 127
            // 169.254.0.0/16 link-local (includes 169.254.169.254 metadata)
            || (o[0] == 169 && o[1] == 254)
            // 100.64.0.0/10 (CGNAT / shared address space)
            || (o[0] == 100 && (o[1] & 0xc0) == 64)
            // 0.0.0.0/8
            || o[0] == 0
            // 240.0.0.0/4 reserved
            || (o[0] & 0xf0) == 240
            // 224.0.0.0/4 multicast
            || (o[0] & 0xf0) == 224
        }
        IpAddr::V6(v6) => {
            // ::1 loopback
            v6.is_loopback()
            // fc00::/7 ULA
            || (v6.segments()[0] & 0xfe00) == 0xfc00
            // fe80::/10 link-local
            || (v6.segments()[0] & 0xffc0) == 0xfe80
            // ::ffff:0:0/96 IPv4-mapped — re-check the embedded IPv4 part
            || v6.to_ipv4().map(|v4| is_private_or_metadata(IpAddr::V4(v4))).unwrap_or(false)
        }
    }
}

pub struct EgressPolicy {
    rules: RwLock<Vec<EgressRule>>,
    manager: ManagerClient,
    /// Allowed destination ports; populated once at construction from the env.
    allowed_ports: Vec<u16>,
}

impl EgressPolicy {
    pub fn new(initial: Vec<EgressRule>, manager: ManagerClient) -> Self {
        Self {
            rules: RwLock::new(initial),
            manager,
            allowed_ports: allowed_ports_from_env(),
        }
    }

    pub async fn replace_rules(&self, new_rules: Vec<EgressRule>) {
        let mut g = self.rules.write().await;
        *g = new_rules;
    }

    /// Decision point: host-pattern matching + port allowlist + IP-literal /
    /// private-range denial.
    ///
    /// `host` is the bare hostname from the CONNECT target (no port).
    /// `port` is the destination port parsed from the CONNECT target.
    pub async fn evaluate(&self, host: &str, port: u16, _method: Option<&str>) -> Decision {
        // H4 (a): port allowlist — checked first, cheapest rejection.
        if !self.allowed_ports.contains(&port) {
            tracing::warn!(
                host = host,
                port = port,
                allowed = ?self.allowed_ports,
                "egress: CONNECT rejected — port not in allowlist"
            );
            return Decision::Deny("port not in allowlist");
        }

        // H4 (b): reject IP-literal CONNECT targets unconditionally unless
        // they are explicitly in the rules AND pass the private-range check.
        if let Ok(ip) = host.parse::<IpAddr>() {
            if is_private_or_metadata(ip) {
                tracing::warn!(
                    host = host,
                    port = port,
                    "egress: CONNECT rejected — IP literal resolves to private/metadata range"
                );
                return Decision::Deny("IP literal in private/metadata range");
            }
            // Public IP literal: allow only if explicitly listed in a rule
            // (exact match, not wildcard). Wildcard patterns are for hostnames.
            let g = self.rules.read().await;
            for rule in g.iter() {
                if rule.pattern == host {
                    return Decision::Allow;
                }
            }
            return Decision::Deny("IP literal not explicitly allowlisted");
        }

        // Hostname path.
        let g = self.rules.read().await;
        if g.is_empty() {
            // Default-deny when no rules configured. Manager pushes overrides
            // via Heartbeat acks; an empty rule set means "no egress yet".
            return Decision::Deny("no rules configured");
        }
        for rule in g.iter() {
            if pattern_matches(&rule.pattern, host) {
                // TODO: rate-limit using rule.rate_bps + a per-rule token bucket.
                // TODO: filter by rule.http_methods (requires L7 inspection,
                //       which we don't do for CONNECT tunnels — would need
                //       MITM termination).
                return Decision::Allow;
            }
        }
        Decision::Deny("no matching allowlist rule")
    }

    /// Post-connect DNS-rebinding guard: resolve the target and verify the
    /// resolved IP is not in a private/metadata range.
    ///
    /// Called after `evaluate()` allows the connection but before the TCP
    /// splice begins.  Prevents an allow-listed hostname from being resolved
    /// at connect time to a private IP (DNS rebinding / SSRF).
    pub async fn check_resolved_ip(&self, target: &str) -> Decision {
        // Resolve the target.  `target` is "host:port" suitable for
        // `tokio::net::lookup_host`.
        let addrs = match tokio::net::lookup_host(target).await {
            Ok(a) => a.collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(target = target, error = %e, "egress: DNS resolution failed");
                return Decision::Deny("DNS resolution failed");
            }
        };

        for sa in &addrs {
            if is_private_or_metadata(sa.ip()) {
                tracing::warn!(
                    target = target,
                    ip = %sa.ip(),
                    "egress: CONNECT rejected — allowlisted hostname resolves to \
                     private/metadata IP (DNS rebinding / SSRF attempt)"
                );
                return Decision::Deny("hostname resolves to private/metadata IP");
            }
        }

        Decision::Allow
    }

    async fn audit(&self, host: &str, port: u16, decision: &Decision) {
        let mut attrs = std::collections::HashMap::new();
        attrs.insert("host".into(), host.to_string());
        attrs.insert("port".into(), port.to_string());
        match decision {
            Decision::Allow => attrs.insert("decision".into(), "allow".into()),
            Decision::Deny(r) => {
                attrs.insert("decision".into(), "deny".into());
                attrs.insert("reason".into(), (*r).into())
            }
        };
        self.manager
            .enqueue_report(HarnessReport::Audit(AuditEvent {
                vm_id: self.manager.vm_id.clone(),
                action: "egress".into(),
                at_unix_ms: now_unix_ms(),
                attrs,
            }))
            .await;
    }
}

// ---------------------------------------------------------------------------
// H4 (c): fix `*.` with empty suffix — pattern_matches must not match
// everything when the suffix is empty.
// ---------------------------------------------------------------------------

/// Returns `true` when `host` matches `pattern`.
///
/// Rules:
/// - Exact match: `"api.openai.com"` matches only `"api.openai.com"`.
/// - Wildcard: `"*.openai.com"` matches any subdomain of `openai.com`
///   (the host must end with `.openai.com` AND have content before it).
/// - Degenerate `"*."` (empty suffix): NEVER matches anything.  A rule with
///   an empty suffix after `*.` is a misconfiguration and must not silently
///   become a wildcard-allow-all.
pub fn pattern_matches(pattern: &str, host: &str) -> bool {
    if let Some(suffix) = pattern.strip_prefix("*.") {
        // H4 (c): empty suffix guard — `*.` alone must not match everything.
        if suffix.is_empty() {
            return false;
        }
        // The host must end with ".<suffix>" and have at least one character
        // before that (i.e. host.len() > suffix.len() + 1 for the dot).
        let dotted = format!(".{suffix}");
        host.ends_with(dotted.as_str()) && host.len() > dotted.len()
    } else {
        pattern == host
    }
}

/// Run the HTTP CONNECT proxy. Binds to 127.0.0.1:3128.
pub async fn run_proxy(policy: Arc<EgressPolicy>) -> anyhow::Result<()> {
    let bind = std::env::var("LANTERN_EGRESS_BIND").unwrap_or_else(|_| "127.0.0.1:3128".into());
    let listener = TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "egress: HTTP CONNECT proxy listening");

    loop {
        let (client, peer) = match listener.accept().await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "egress: accept failed");
                continue;
            }
        };
        let policy = Arc::clone(&policy);
        tokio::spawn(async move {
            if let Err(e) = handle_client(client, policy).await {
                tracing::debug!(?peer, error = %e, "egress: client closed with error");
            }
        });
    }
}

async fn handle_client(client: TcpStream, policy: Arc<EgressPolicy>) -> anyhow::Result<()> {
    let (read_half, mut write_half) = client.into_split();
    let mut reader = BufReader::new(read_half);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).await?;

    // Drain headers (we only care about the request line for CONNECT).
    let mut hdr = String::new();
    loop {
        hdr.clear();
        let n = reader.read_line(&mut hdr).await?;
        if n == 0 || hdr == "\r\n" || hdr == "\n" {
            break;
        }
    }

    // Parse "CONNECT host:port HTTP/1.1".
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 || !parts[0].eq_ignore_ascii_case("CONNECT") {
        let _ = write_half
            .write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            .await;
        return Ok(());
    }
    let target = parts[1];

    // H4 (a): extract host and port from "host:port".
    // If port is absent or unparseable, default-deny (400).
    let (host, port) = match parse_host_port(target) {
        Some(hp) => hp,
        None => {
            let _ = write_half
                .write_all(b"HTTP/1.1 400 Bad Request\r\nX-Lantern-Reason: missing-port\r\n\r\n")
                .await;
            return Ok(());
        }
    };

    let decision = policy.evaluate(&host, port, None).await;
    policy.audit(&host, port, &decision).await;

    match decision {
        Decision::Deny(reason) => {
            let body = format!("HTTP/1.1 403 Forbidden\r\nX-Lantern-Reason: {reason}\r\n\r\n");
            let _ = write_half.write_all(body.as_bytes()).await;
            return Ok(());
        }
        Decision::Allow => {}
    }

    // H4 (b): post-allowlist DNS-rebinding check — resolve and verify the IP
    // is not in a private/metadata range before opening the connection.
    let ip_decision = policy.check_resolved_ip(target).await;
    policy.audit(&host, port, &ip_decision).await;
    match ip_decision {
        Decision::Deny(reason) => {
            let body = format!("HTTP/1.1 403 Forbidden\r\nX-Lantern-Reason: {reason}\r\n\r\n");
            let _ = write_half.write_all(body.as_bytes()).await;
            return Ok(());
        }
        Decision::Allow => {}
    }

    let upstream = match TcpStream::connect(target).await {
        Ok(s) => s,
        Err(e) => {
            let _ = write_half
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                .await;
            return Err(anyhow::anyhow!("upstream connect failed: {e}"));
        }
    };
    write_half
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;

    // Splice both directions. Forward any bytes the BufReader buffered
    // past the CRLF first so we don't drop the start of the TLS handshake.
    let (mut up_r, mut up_w) = upstream.into_split();
    let buffered = reader.buffer().to_vec();
    let mut client_read = reader.into_inner();
    if !buffered.is_empty() {
        up_w.write_all(&buffered).await?;
    }
    let t1 = tokio::io::copy(&mut client_read, &mut up_w);
    let t2 = tokio::io::copy(&mut up_r, &mut write_half);
    let _ = tokio::join!(t1, t2);
    Ok(())
}

/// Split "host:port" into (host, port). Returns `None` if the port is absent
/// or not a valid u16.  Handles IPv6 bracketed addresses `[::1]:443`.
fn parse_host_port(target: &str) -> Option<(String, u16)> {
    if let Some(rest) = target.strip_prefix('[') {
        // IPv6: "[::1]:443"
        let close = rest.find(']')?;
        let host = rest[..close].to_string();
        let after = &rest[close + 1..];
        let port_str = after.strip_prefix(':')?;
        let port = port_str.parse::<u16>().ok()?;
        Some((host, port))
    } else {
        let mut parts = target.rsplitn(2, ':');
        let port_str = parts.next()?;
        let host = parts.next()?.to_string();
        let port = port_str.parse::<u16>().ok()?;
        Some((host, port))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager_client::ManagerClient;
    use crate::proto::EgressRule;

    // ---- pattern_matches (pure) ----

    #[test]
    fn exact_match_same_host() {
        assert!(pattern_matches("api.openai.com", "api.openai.com"));
    }

    #[test]
    fn exact_match_different_host_fails() {
        assert!(!pattern_matches("api.openai.com", "api.anthropic.com"));
    }

    #[test]
    fn wildcard_matches_subdomain() {
        assert!(pattern_matches("*.openai.com", "api.openai.com"));
        assert!(pattern_matches("*.openai.com", "files.openai.com"));
    }

    #[test]
    fn wildcard_does_not_match_bare_domain() {
        // "*.openai.com" must NOT match "openai.com" — no prefix part
        assert!(!pattern_matches("*.openai.com", "openai.com"));
    }

    #[test]
    fn wildcard_does_not_match_different_domain() {
        assert!(!pattern_matches("*.openai.com", "api.anthropic.com"));
    }

    #[test]
    fn wildcard_matches_deep_subdomain() {
        // "deep.sub.openai.com" ends with ".openai.com" and is longer
        assert!(pattern_matches("*.openai.com", "deep.sub.openai.com"));
    }

    #[test]
    fn empty_pattern_only_matches_empty_host() {
        assert!(pattern_matches("", ""));
        assert!(!pattern_matches("", "anything"));
    }

    // H4 (c): degenerate "*." with empty suffix must never match anything.
    #[test]
    fn wildcard_empty_suffix_never_matches() {
        assert!(!pattern_matches("*.", "example.com"));
        assert!(!pattern_matches("*.", "anything"));
        assert!(!pattern_matches("*.", ""));
    }

    // ---- parse_host_port ----

    #[test]
    fn parse_host_port_normal() {
        assert_eq!(
            parse_host_port("api.openai.com:443"),
            Some(("api.openai.com".to_string(), 443))
        );
    }

    #[test]
    fn parse_host_port_missing_port_returns_none() {
        assert_eq!(parse_host_port("api.openai.com"), None);
    }

    #[test]
    fn parse_host_port_invalid_port_returns_none() {
        assert_eq!(parse_host_port("api.openai.com:notaport"), None);
    }

    #[test]
    fn parse_host_port_ipv6_bracketed() {
        assert_eq!(parse_host_port("[::1]:443"), Some(("::1".to_string(), 443)));
    }

    // ---- is_private_or_metadata ----

    #[test]
    fn rfc1918_10_is_private() {
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        assert!(is_private_or_metadata(ip));
    }

    #[test]
    fn rfc1918_172_16_is_private() {
        let ip: IpAddr = "172.16.5.1".parse().unwrap();
        assert!(is_private_or_metadata(ip));
    }

    #[test]
    fn rfc1918_192_168_is_private() {
        let ip: IpAddr = "192.168.1.1".parse().unwrap();
        assert!(is_private_or_metadata(ip));
    }

    #[test]
    fn metadata_169_254_169_254_is_private() {
        let ip: IpAddr = "169.254.169.254".parse().unwrap();
        assert!(is_private_or_metadata(ip));
    }

    #[test]
    fn loopback_127_is_private() {
        let ip: IpAddr = "127.0.0.1".parse().unwrap();
        assert!(is_private_or_metadata(ip));
    }

    #[test]
    fn public_ip_is_not_private() {
        let ip: IpAddr = "8.8.8.8".parse().unwrap();
        assert!(!is_private_or_metadata(ip));
    }

    #[test]
    fn ipv6_loopback_is_private() {
        let ip: IpAddr = "::1".parse().unwrap();
        assert!(is_private_or_metadata(ip));
    }

    #[test]
    fn ipv6_ula_is_private() {
        let ip: IpAddr = "fd00::1".parse().unwrap();
        assert!(is_private_or_metadata(ip));
    }

    #[test]
    fn ipv6_link_local_is_private() {
        let ip: IpAddr = "fe80::1".parse().unwrap();
        assert!(is_private_or_metadata(ip));
    }

    #[test]
    fn ipv6_public_is_not_private() {
        let ip: IpAddr = "2001:4860:4860::8888".parse().unwrap();
        assert!(!is_private_or_metadata(ip));
    }

    // ---- EgressPolicy::evaluate ----

    fn rule(pattern: &str) -> EgressRule {
        EgressRule {
            pattern: pattern.to_string(),
            http_methods: vec![],
            rate_bps: 0,
        }
    }

    fn make_policy(rules: Vec<EgressRule>) -> EgressPolicy {
        // ManagerClient::new requires an addr + vm_id; enqueue_report is
        // fire-and-forget and silently drops when no channel is registered,
        // so a disconnected address is fine for unit tests.
        let manager = ManagerClient::new("127.0.0.1:0".to_string(), "vm-test".to_string());
        EgressPolicy::new(rules, manager)
    }

    #[tokio::test]
    async fn empty_rules_denies_everything() {
        let policy = make_policy(vec![]);
        assert!(matches!(
            policy.evaluate("api.openai.com", 443, None).await,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn matching_exact_rule_allows() {
        let policy = make_policy(vec![rule("api.openai.com")]);
        assert!(matches!(
            policy.evaluate("api.openai.com", 443, None).await,
            Decision::Allow
        ));
    }

    #[tokio::test]
    async fn non_matching_rule_denies() {
        let policy = make_policy(vec![rule("api.openai.com")]);
        assert!(matches!(
            policy.evaluate("evil.com", 443, None).await,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn wildcard_rule_allows_subdomain() {
        let policy = make_policy(vec![rule("*.anthropic.com")]);
        assert!(matches!(
            policy.evaluate("api.anthropic.com", 443, None).await,
            Decision::Allow
        ));
    }

    #[tokio::test]
    async fn wildcard_rule_denies_bare_domain() {
        let policy = make_policy(vec![rule("*.anthropic.com")]);
        assert!(matches!(
            policy.evaluate("anthropic.com", 443, None).await,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn multiple_rules_all_tried() {
        let policy = make_policy(vec![rule("api.openai.com"), rule("*.anthropic.com")]);
        assert!(matches!(
            policy.evaluate("api.openai.com", 443, None).await,
            Decision::Allow
        ));
        assert!(matches!(
            policy.evaluate("api.anthropic.com", 443, None).await,
            Decision::Allow
        ));
        assert!(matches!(
            policy.evaluate("evil.com", 443, None).await,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn replace_rules_takes_effect_immediately() {
        let policy = make_policy(vec![rule("old.example.com")]);
        assert!(matches!(
            policy.evaluate("old.example.com", 443, None).await,
            Decision::Allow
        ));
        assert!(matches!(
            policy.evaluate("new.example.com", 443, None).await,
            Decision::Deny(_)
        ));

        policy.replace_rules(vec![rule("new.example.com")]).await;

        assert!(matches!(
            policy.evaluate("old.example.com", 443, None).await,
            Decision::Deny(_)
        ));
        assert!(matches!(
            policy.evaluate("new.example.com", 443, None).await,
            Decision::Allow
        ));
    }

    #[tokio::test]
    async fn replace_with_empty_rules_denies_all() {
        let policy = make_policy(vec![rule("allowed.com")]);
        assert!(matches!(
            policy.evaluate("allowed.com", 443, None).await,
            Decision::Allow
        ));

        policy.replace_rules(vec![]).await;

        assert!(matches!(
            policy.evaluate("allowed.com", 443, None).await,
            Decision::Deny(_)
        ));
    }

    // H4 (a): port allowlist tests

    #[tokio::test]
    async fn non_443_port_denied_by_default() {
        let policy = make_policy(vec![rule("api.openai.com")]);
        // Port 80 is not in the default allowlist [443].
        assert!(matches!(
            policy.evaluate("api.openai.com", 80, None).await,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn port_443_allowed_by_default() {
        let policy = make_policy(vec![rule("api.openai.com")]);
        assert!(matches!(
            policy.evaluate("api.openai.com", 443, None).await,
            Decision::Allow
        ));
    }

    // H4 (b): IP-literal tests

    #[tokio::test]
    async fn ip_literal_private_denied_even_if_rule_matches() {
        // Even if someone adds an explicit rule for 10.0.0.1, the
        // private-range check fires first.
        let policy = make_policy(vec![rule("10.0.0.1")]);
        assert!(matches!(
            policy.evaluate("10.0.0.1", 443, None).await,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn metadata_ip_literal_denied() {
        let policy = make_policy(vec![rule("169.254.169.254")]);
        assert!(matches!(
            policy.evaluate("169.254.169.254", 443, None).await,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn public_ip_literal_denied_without_explicit_rule() {
        // A public IP with no rule → denied.
        let policy = make_policy(vec![rule("api.openai.com")]);
        assert!(matches!(
            policy.evaluate("8.8.8.8", 443, None).await,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn public_ip_literal_allowed_with_explicit_rule() {
        let policy = make_policy(vec![rule("8.8.8.8")]);
        assert!(matches!(
            policy.evaluate("8.8.8.8", 443, None).await,
            Decision::Allow
        ));
    }

    #[tokio::test]
    async fn wildcard_rule_does_not_match_ip_literal() {
        // A wildcard pattern must not cover an IP literal.
        let policy = make_policy(vec![rule("*.openai.com")]);
        assert!(matches!(
            policy.evaluate("1.2.3.4", 443, None).await,
            Decision::Deny(_)
        ));
    }

    // H4 (c): degenerate "*." rule

    #[tokio::test]
    async fn degenerate_star_dot_rule_denies_all() {
        // A misconfigured "*." rule must not become allow-all.
        let policy = make_policy(vec![rule("*.")]);
        assert!(matches!(
            policy.evaluate("anything.com", 443, None).await,
            Decision::Deny(_)
        ));
        assert!(matches!(
            policy.evaluate("evil.com", 443, None).await,
            Decision::Deny(_)
        ));
    }
}
