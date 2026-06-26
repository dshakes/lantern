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
// v1 implements HTTP CONNECT termination + pattern matching.
//
// Egress rate limiting (rate_bps): when a rule carries a non-zero rate_bps
// value, a per-CONNECT-tunnel token bucket throttles how many bytes per
// second flow through the splice loop. Burst = 1 second of traffic.
// A rate of 0 means unlimited.
//
// HTTP method filtering (http_methods): applies to PLAIN HTTP requests
// (non-CONNECT). CONNECT tunnels carry opaque TLS; the proxy cannot inspect
// the inner HTTP method without MITM termination, so method filtering is
// NOT applied to CONNECT connections. When the inner protocol is plain HTTP
// the request line is already available, so the rule's http_methods list is
// checked before forwarding.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Instant;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;

use crate::manager_client::ManagerClient;
use crate::proto::{now_unix_ms, AuditEvent, EgressRule, HarnessReport};

#[derive(Clone, Debug)]
pub enum Decision {
    Allow,
    Deny(&'static str),
}

// ---------------------------------------------------------------------------
// Token bucket — per-tunnel byte-rate limiter.
//
// `rate_bps` = bytes per second. Burst capacity = 1 full second.
// A rate of 0 means unlimited (bucket is never consulted).
// ---------------------------------------------------------------------------

/// A simple token-bucket rate limiter for byte streams.
///
/// Tokens are bytes. The bucket is refilled at `rate_bps` bytes/second with
/// a burst cap of `rate_bps` bytes (one second of traffic). The caller calls
/// `consume(n)` before writing `n` bytes; the call sleeps until enough tokens
/// are available.
pub struct TokenBucket {
    /// Bytes per second. 0 = unlimited (all `consume` calls return immediately).
    rate_bps: u64,
    /// Tokens currently available (fractional, stored as f64 for precision).
    tokens: f64,
    /// Wall-clock of last refill.
    last_refill: Instant,
}

impl TokenBucket {
    /// Create a new bucket. `rate_bps == 0` disables throttling.
    #[must_use]
    pub fn new(rate_bps: u64) -> Self {
        Self {
            rate_bps,
            tokens: rate_bps as f64, // start full
            last_refill: Instant::now(),
        }
    }

    /// Consume `n` bytes from the bucket, sleeping until tokens are available.
    /// Returns immediately when `rate_bps` is 0 (unlimited).
    pub async fn consume(&mut self, n: u64) {
        if self.rate_bps == 0 || n == 0 {
            return;
        }
        // Refill based on elapsed time.
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.last_refill = now;
        let burst = self.rate_bps as f64;
        self.tokens = (self.tokens + elapsed * burst).min(burst);

        let needed = n as f64;
        if self.tokens >= needed {
            self.tokens -= needed;
        } else {
            // How long until we have enough tokens?
            let deficit = needed - self.tokens;
            let wait_secs = deficit / burst;
            tokio::time::sleep(tokio::time::Duration::from_secs_f64(wait_secs)).await;
            // After sleeping, tokens are replenished; consume what we need.
            self.tokens = 0.0;
        }
    }
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
    ///
    /// Returns `(Decision, rate_bps)`. `rate_bps` is non-zero only when the
    /// matched rule carries a per-tunnel byte-rate limit; the caller uses it to
    /// construct a `TokenBucket` for the splice loop. For CONNECT tunnels (opaque
    /// TLS), method filtering is not applied here — see `check_method` for the
    /// plain-HTTP path.
    pub async fn evaluate_with_rate(&self, host: &str, port: u16) -> (Decision, u64) {
        self.evaluate_inner(host, port).await
    }

    async fn evaluate_inner(&self, host: &str, port: u16) -> (Decision, u64) {
        // H4 (a): port allowlist — checked first, cheapest rejection.
        if !self.allowed_ports.contains(&port) {
            tracing::warn!(
                host = host,
                port = port,
                allowed = ?self.allowed_ports,
                "egress: CONNECT rejected — port not in allowlist"
            );
            return (Decision::Deny("port not in allowlist"), 0);
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
                return (Decision::Deny("IP literal in private/metadata range"), 0);
            }
            // Public IP literal: allow only if explicitly listed in a rule
            // (exact match, not wildcard). Wildcard patterns are for hostnames.
            let g = self.rules.read().await;
            for rule in g.iter() {
                if rule.pattern == host {
                    let rate = rule.rate_bps.max(0) as u64;
                    return (Decision::Allow, rate);
                }
            }
            return (Decision::Deny("IP literal not explicitly allowlisted"), 0);
        }

        // Hostname path.
        let g = self.rules.read().await;
        if g.is_empty() {
            // Default-deny when no rules configured. Manager pushes overrides
            // via Heartbeat acks; an empty rule set means "no egress yet".
            return (Decision::Deny("no rules configured"), 0);
        }
        for rule in g.iter() {
            if pattern_matches(&rule.pattern, host) {
                let rate = rule.rate_bps.max(0) as u64;
                return (Decision::Allow, rate);
            }
        }
        (Decision::Deny("no matching allowlist rule"), 0)
    }

    /// Check whether `method` is permitted by the first rule matching `host`.
    ///
    /// Only meaningful for PLAIN HTTP (non-CONNECT) requests where the method
    /// is already visible in the request line. CONNECT tunnels carry opaque TLS;
    /// method filtering CANNOT be applied to them without MITM termination.
    ///
    /// Returns `true` (allowed) when:
    ///  - the rule has an empty `http_methods` list (all methods permitted), or
    ///  - `method` appears (case-insensitively) in the list.
    ///
    /// Returns `false` only when the rule explicitly lists methods and `method`
    /// is not among them.
    pub async fn check_method(&self, host: &str, method: &str) -> bool {
        let g = self.rules.read().await;
        for rule in g.iter() {
            if pattern_matches(&rule.pattern, host) || rule.pattern == host {
                if rule.http_methods.is_empty() {
                    return true;
                }
                return rule
                    .http_methods
                    .iter()
                    .any(|m| m.eq_ignore_ascii_case(method));
            }
        }
        // No rule matched — decision should already be deny from evaluate;
        // treat as allowed here so the deny path surfaces the right reason.
        true
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

// ---------------------------------------------------------------------------
// P2-B7 (2): boot-time egress enforcement preflight.
//
// The CONNECT proxy is only advisory unless something FORCES the workload's
// traffic through it. The two enforcement layers are:
//   * proxy env injection (supervisor.rs) — honored by well-behaved clients,
//   * iptables REDIRECT in the VM image — the only layer that catches a client
//     that ignores proxy env (the real boundary).
//
// At boot, when egress rules are declared, we verify the REDIRECT layer is
// present. If it is absent the workload could bypass the allowlist entirely, so
// we either FAIL CLOSED (refuse to start; default in production) or log a
// prominent SECURITY warning + audit event (dev override).
// ---------------------------------------------------------------------------

/// Outcome of the egress enforcement preflight.
#[derive(Debug, PartialEq, Eq)]
pub enum PreflightOutcome {
    /// Enforcement present, or no egress rules to enforce — safe to proceed.
    Ok,
    /// Enforcement absent but the operator opted to proceed (dev). Warn loudly.
    WarnOnly,
    /// Enforcement absent and fail-closed is required — refuse to start.
    FailClosed,
}

/// Pure decision: given whether egress is configured, whether the iptables
/// REDIRECT layer was detected, and the fail-closed policy, decide the outcome.
///
/// Separated from the syscall/exec so it is unit-testable.
#[must_use]
pub fn preflight_decision(
    egress_configured: bool,
    redirect_present: bool,
    fail_closed: bool,
) -> PreflightOutcome {
    if !egress_configured || redirect_present {
        return PreflightOutcome::Ok;
    }
    if fail_closed {
        PreflightOutcome::FailClosed
    } else {
        PreflightOutcome::WarnOnly
    }
}

/// Default fail-closed policy from the environment. Defaults to FALSE (warn
/// only) so the dev path and images that haven't yet wired iptables keep
/// booting; production images set `LANTERN_EGRESS_FAIL_CLOSED=1`.
fn egress_fail_closed_from_env() -> bool {
    std::env::var("LANTERN_EGRESS_FAIL_CLOSED")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Detect whether the in-VM iptables REDIRECT-to-proxy rule is present.
///
/// Linux: shell out to `iptables-save -t nat` and look for a REDIRECT rule
/// targeting the proxy port. Best-effort: if iptables is missing or errors,
/// we report `false` (treated as "enforcement absent"). Non-Linux dev hosts:
/// always `false` (there's no microVM netfilter to inspect).
#[cfg(target_os = "linux")]
fn redirect_rule_present(proxy_port: u16) -> bool {
    use std::process::Command as StdCommand;
    let out = match StdCommand::new("iptables-save")
        .arg("-t")
        .arg("nat")
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!(error = %e, "egress: iptables-save not available for preflight");
            return false;
        }
    };
    if !out.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let needle = format!("--to-ports {proxy_port}");
    text.lines()
        .any(|l| l.contains("REDIRECT") && l.contains(&needle))
}

#[cfg(not(target_os = "linux"))]
fn redirect_rule_present(_proxy_port: u16) -> bool {
    false
}

/// Run the boot-time egress enforcement preflight.
///
/// `egress_configured` is true when the AgentSpec declared any egress rules.
/// Returns `Err` only in the FailClosed outcome, so the caller refuses to spawn
/// the workload. Emits an audit event on every non-Ok outcome.
pub async fn enforcement_preflight(
    manager: &ManagerClient,
    egress_configured: bool,
) -> anyhow::Result<()> {
    let proxy_port = std::env::var("LANTERN_EGRESS_BIND")
        .ok()
        .and_then(|b| b.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()))
        .unwrap_or(3128);
    let redirect_present = redirect_rule_present(proxy_port);
    let fail_closed = egress_fail_closed_from_env();
    let outcome = preflight_decision(egress_configured, redirect_present, fail_closed);

    match outcome {
        PreflightOutcome::Ok => {
            if egress_configured {
                tracing::info!(
                    proxy_port,
                    "egress: enforcement preflight OK (iptables REDIRECT present)"
                );
            }
        }
        PreflightOutcome::WarnOnly => {
            tracing::warn!(
                proxy_port,
                "egress: SECURITY — egress rules are declared but the iptables REDIRECT \
                 enforcement layer was NOT detected. The allowlist is ADVISORY only: a workload \
                 that ignores HTTP(S)_PROXY can bypass it. Install the REDIRECT rule in the VM \
                 image (see egress.rs header) or set LANTERN_EGRESS_FAIL_CLOSED=1 to refuse to \
                 start without it."
            );
            audit_preflight(manager, proxy_port, "warn_only").await;
        }
        PreflightOutcome::FailClosed => {
            audit_preflight(manager, proxy_port, "fail_closed").await;
            anyhow::bail!(
                "egress: refusing to start — egress rules declared but iptables REDIRECT \
                 enforcement absent and LANTERN_EGRESS_FAIL_CLOSED is set. Install the REDIRECT \
                 rule in the VM image (see egress.rs header)."
            );
        }
    }
    Ok(())
}

async fn audit_preflight(manager: &ManagerClient, proxy_port: u16, decision: &str) {
    let mut attrs = std::collections::HashMap::new();
    attrs.insert("decision".into(), "deny".into());
    attrs.insert(
        "reason".into(),
        "iptables REDIRECT enforcement absent".into(),
    );
    attrs.insert("preflight".into(), decision.to_string());
    attrs.insert("proxy_port".into(), proxy_port.to_string());
    manager
        .enqueue_report(HarnessReport::Audit(AuditEvent {
            vm_id: manager.vm_id.clone(),
            action: "egress_preflight".into(),
            at_unix_ms: now_unix_ms(),
            attrs,
        }))
        .await;
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

    // Collect all headers into a buffer so we can forward them for plain HTTP.
    let mut raw_headers: Vec<String> = Vec::new();
    let mut hdr = String::new();
    loop {
        hdr.clear();
        let n = reader.read_line(&mut hdr).await?;
        if n == 0 || hdr == "\r\n" || hdr == "\n" {
            break;
        }
        raw_headers.push(hdr.clone());
    }

    // Extract method and target as owned strings before moving request_line.
    let (method, request_target) = {
        let parts: Vec<&str> = request_line.split_whitespace().collect();
        if parts.len() < 2 {
            let _ = write_half
                .write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n")
                .await;
            return Ok(());
        }
        (parts[0].to_string(), parts[1].to_string())
    };

    if method.eq_ignore_ascii_case("CONNECT") {
        handle_connect(&request_target, reader, write_half, policy).await
    } else {
        // Plain HTTP (non-CONNECT) — method filtering applies here because the
        // request line is visible in plaintext.
        handle_plain_http(
            &method,
            &request_target,
            request_line,
            raw_headers,
            reader,
            write_half,
            policy,
        )
        .await
    }
}

/// Handle an HTTP CONNECT tunnel.
///
/// NOTE: method filtering is NOT applied to CONNECT tunnels. The tunnel
/// carries opaque TLS; we cannot inspect the inner HTTP method without MITM
/// termination. Rate limiting via `rate_bps` IS applied to the byte stream.
async fn handle_connect(
    target: &str,
    reader: BufReader<tokio::net::tcp::OwnedReadHalf>,
    mut write_half: tokio::net::tcp::OwnedWriteHalf,
    policy: Arc<EgressPolicy>,
) -> anyhow::Result<()> {
    // H4 (a): extract host and port from "host:port".
    let (host, port) = match parse_host_port(target) {
        Some(hp) => hp,
        None => {
            let _ = write_half
                .write_all(b"HTTP/1.1 400 Bad Request\r\nX-Lantern-Reason: missing-port\r\n\r\n")
                .await;
            return Ok(());
        }
    };

    let (decision, rate_bps) = policy.evaluate_with_rate(&host, port).await;
    policy.audit(&host, port, &decision).await;

    match decision {
        Decision::Deny(reason) => {
            let body = format!("HTTP/1.1 403 Forbidden\r\nX-Lantern-Reason: {reason}\r\n\r\n");
            let _ = write_half.write_all(body.as_bytes()).await;
            return Ok(());
        }
        Decision::Allow => {}
    }

    // H4 (b): post-allowlist DNS-rebinding check.
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

    // Splice both directions. Forward any bytes the BufReader already consumed
    // past the CRLF so we don't drop the start of the TLS handshake.
    let (mut up_r, mut up_w) = upstream.into_split();
    let buffered = reader.buffer().to_vec();
    let mut client_read = reader.into_inner();
    if !buffered.is_empty() {
        up_w.write_all(&buffered).await?;
    }

    if rate_bps == 0 {
        // Unlimited — use the fast tokio::io::copy path.
        let t1 = tokio::io::copy(&mut client_read, &mut up_w);
        let t2 = tokio::io::copy(&mut up_r, &mut write_half);
        let _ = tokio::join!(t1, t2);
    } else {
        // Rate-limited — run both halves concurrently, each with its own
        // token bucket seeded at rate_bps bytes/s, burst = 1 second.
        let t1 = throttled_copy(client_read, up_w, rate_bps);
        let t2 = throttled_copy(up_r, write_half, rate_bps);
        let _ = tokio::join!(t1, t2);
    }
    Ok(())
}

/// Handle a plain (non-CONNECT) HTTP request.
///
/// Method filtering IS enforced here because the method is visible in the
/// request line. The full request (line + headers + body) is forwarded to
/// the upstream after the checks pass.
async fn handle_plain_http(
    method: &str,
    request_target: &str,
    request_line: String,
    raw_headers: Vec<String>,
    mut body_reader: BufReader<tokio::net::tcp::OwnedReadHalf>,
    mut write_half: tokio::net::tcp::OwnedWriteHalf,
    policy: Arc<EgressPolicy>,
) -> anyhow::Result<()> {
    // Derive host from the absolute-form URI or the Host header.
    let host = extract_host_for_plain_http(request_target, &raw_headers);
    // Default to port 80 for plain HTTP.
    let (hostname, port) = if let Some(h) = &host {
        parse_host_port_with_default(h, 80)
    } else {
        let _ = write_half
            .write_all(b"HTTP/1.1 400 Bad Request\r\nX-Lantern-Reason: missing-host\r\n\r\n")
            .await;
        return Ok(());
    };

    let (decision, _rate_bps) = policy.evaluate_with_rate(&hostname, port).await;
    policy.audit(&hostname, port, &decision).await;
    match decision {
        Decision::Deny(reason) => {
            let body = format!("HTTP/1.1 403 Forbidden\r\nX-Lantern-Reason: {reason}\r\n\r\n");
            let _ = write_half.write_all(body.as_bytes()).await;
            return Ok(());
        }
        Decision::Allow => {}
    }

    // Method filtering — checked after the allowlist so the deny reason is
    // specific (403 Method Not Allowed vs. 403 Forbidden).
    if !policy.check_method(&hostname, method).await {
        tracing::warn!(
            host = %hostname,
            method = method,
            "egress: plain HTTP request rejected — method not permitted by rule"
        );
        let _ = write_half
            .write_all(b"HTTP/1.1 403 Forbidden\r\nX-Lantern-Reason: method-not-allowed\r\n\r\n")
            .await;
        return Ok(());
    }

    let target = format!("{hostname}:{port}");
    // Post-allowlist DNS-rebinding guard.
    let ip_decision = policy.check_resolved_ip(&target).await;
    policy.audit(&hostname, port, &ip_decision).await;
    match ip_decision {
        Decision::Deny(reason) => {
            let body = format!("HTTP/1.1 403 Forbidden\r\nX-Lantern-Reason: {reason}\r\n\r\n");
            let _ = write_half.write_all(body.as_bytes()).await;
            return Ok(());
        }
        Decision::Allow => {}
    }

    let mut upstream = match TcpStream::connect(&target).await {
        Ok(s) => s,
        Err(e) => {
            let _ = write_half
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                .await;
            return Err(anyhow::anyhow!("upstream connect failed: {e}"));
        }
    };

    // Forward the original request to the upstream verbatim.
    upstream.write_all(request_line.as_bytes()).await?;
    for h in &raw_headers {
        upstream.write_all(h.as_bytes()).await?;
    }
    upstream.write_all(b"\r\n").await?;

    // Pipe the rest of the request body + the response back.
    let (mut up_r, mut up_w) = upstream.into_split();
    let t1 = tokio::io::copy(&mut body_reader, &mut up_w);
    let t2 = tokio::io::copy(&mut up_r, &mut write_half);
    let _ = tokio::join!(t1, t2);
    Ok(())
}

/// Copy bytes from `reader` to `writer` with token-bucket throttling at
/// `rate_bps` bytes/second. Burst = 1 second. Used for both halves of a
/// rate-limited CONNECT tunnel concurrently.
async fn throttled_copy<R, W>(mut reader: R, mut writer: W, rate_bps: u64) -> std::io::Result<u64>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut bucket = TokenBucket::new(rate_bps);
    let mut buf = vec![0u8; 16 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        bucket.consume(n as u64).await;
        writer.write_all(&buf[..n]).await?;
        total += n as u64;
    }
    Ok(total)
}

/// Extract the hostname (with optional port) for a plain HTTP request.
///
/// Tries, in order:
/// 1. Absolute-form URI: `GET http://api.example.com/path HTTP/1.1`
/// 2. `Host:` header.
fn extract_host_for_plain_http(request_target: &str, headers: &[String]) -> Option<String> {
    // Absolute-form URI.
    if let Some(after) = request_target
        .strip_prefix("http://")
        .or_else(|| request_target.strip_prefix("https://"))
    {
        let authority = after.split('/').next().unwrap_or("");
        if !authority.is_empty() {
            return Some(authority.to_string());
        }
    }
    // Host header.
    for h in headers {
        if let Some(val) = h.strip_prefix("Host:").or_else(|| h.strip_prefix("host:")) {
            let v = val.trim().trim_end_matches('\r').trim_end_matches('\n');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Parse "host:port" returning (host, port). Falls back to `default_port`
/// when no colon is present. Handles IPv6 `[::1]:80`.
fn parse_host_port_with_default(s: &str, default_port: u16) -> (String, u16) {
    if let Some((h, p)) = parse_host_port(s) {
        (h, p)
    } else {
        // No port in the string — strip any trailing brackets for IPv6.
        let host = s.trim_matches('[').trim_matches(']').to_string();
        (host, default_port)
    }
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
            policy.evaluate_with_rate("api.openai.com", 443).await.0,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn matching_exact_rule_allows() {
        let policy = make_policy(vec![rule("api.openai.com")]);
        assert!(matches!(
            policy.evaluate_with_rate("api.openai.com", 443).await.0,
            Decision::Allow
        ));
    }

    #[tokio::test]
    async fn non_matching_rule_denies() {
        let policy = make_policy(vec![rule("api.openai.com")]);
        assert!(matches!(
            policy.evaluate_with_rate("evil.com", 443).await.0,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn wildcard_rule_allows_subdomain() {
        let policy = make_policy(vec![rule("*.anthropic.com")]);
        assert!(matches!(
            policy.evaluate_with_rate("api.anthropic.com", 443).await.0,
            Decision::Allow
        ));
    }

    #[tokio::test]
    async fn wildcard_rule_denies_bare_domain() {
        let policy = make_policy(vec![rule("*.anthropic.com")]);
        assert!(matches!(
            policy.evaluate_with_rate("anthropic.com", 443).await.0,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn multiple_rules_all_tried() {
        let policy = make_policy(vec![rule("api.openai.com"), rule("*.anthropic.com")]);
        assert!(matches!(
            policy.evaluate_with_rate("api.openai.com", 443).await.0,
            Decision::Allow
        ));
        assert!(matches!(
            policy.evaluate_with_rate("api.anthropic.com", 443).await.0,
            Decision::Allow
        ));
        assert!(matches!(
            policy.evaluate_with_rate("evil.com", 443).await.0,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn replace_rules_takes_effect_immediately() {
        let policy = make_policy(vec![rule("old.example.com")]);
        assert!(matches!(
            policy.evaluate_with_rate("old.example.com", 443).await.0,
            Decision::Allow
        ));
        assert!(matches!(
            policy.evaluate_with_rate("new.example.com", 443).await.0,
            Decision::Deny(_)
        ));

        policy.replace_rules(vec![rule("new.example.com")]).await;

        assert!(matches!(
            policy.evaluate_with_rate("old.example.com", 443).await.0,
            Decision::Deny(_)
        ));
        assert!(matches!(
            policy.evaluate_with_rate("new.example.com", 443).await.0,
            Decision::Allow
        ));
    }

    #[tokio::test]
    async fn replace_with_empty_rules_denies_all() {
        let policy = make_policy(vec![rule("allowed.com")]);
        assert!(matches!(
            policy.evaluate_with_rate("allowed.com", 443).await.0,
            Decision::Allow
        ));

        policy.replace_rules(vec![]).await;

        assert!(matches!(
            policy.evaluate_with_rate("allowed.com", 443).await.0,
            Decision::Deny(_)
        ));
    }

    // H4 (a): port allowlist tests

    #[tokio::test]
    async fn non_443_port_denied_by_default() {
        let policy = make_policy(vec![rule("api.openai.com")]);
        // Port 80 is not in the default allowlist [443].
        assert!(matches!(
            policy.evaluate_with_rate("api.openai.com", 80).await.0,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn port_443_allowed_by_default() {
        let policy = make_policy(vec![rule("api.openai.com")]);
        assert!(matches!(
            policy.evaluate_with_rate("api.openai.com", 443).await.0,
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
            policy.evaluate_with_rate("10.0.0.1", 443).await.0,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn metadata_ip_literal_denied() {
        let policy = make_policy(vec![rule("169.254.169.254")]);
        assert!(matches!(
            policy.evaluate_with_rate("169.254.169.254", 443).await.0,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn public_ip_literal_denied_without_explicit_rule() {
        // A public IP with no rule → denied.
        let policy = make_policy(vec![rule("api.openai.com")]);
        assert!(matches!(
            policy.evaluate_with_rate("8.8.8.8", 443).await.0,
            Decision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn public_ip_literal_allowed_with_explicit_rule() {
        let policy = make_policy(vec![rule("8.8.8.8")]);
        assert!(matches!(
            policy.evaluate_with_rate("8.8.8.8", 443).await.0,
            Decision::Allow
        ));
    }

    #[tokio::test]
    async fn wildcard_rule_does_not_match_ip_literal() {
        // A wildcard pattern must not cover an IP literal.
        let policy = make_policy(vec![rule("*.openai.com")]);
        assert!(matches!(
            policy.evaluate_with_rate("1.2.3.4", 443).await.0,
            Decision::Deny(_)
        ));
    }

    // H4 (c): degenerate "*." rule

    #[tokio::test]
    async fn degenerate_star_dot_rule_denies_all() {
        // A misconfigured "*." rule must not become allow-all.
        let policy = make_policy(vec![rule("*.")]);
        assert!(matches!(
            policy.evaluate_with_rate("anything.com", 443).await.0,
            Decision::Deny(_)
        ));
        assert!(matches!(
            policy.evaluate_with_rate("evil.com", 443).await.0,
            Decision::Deny(_)
        ));
    }

    // ---- rate_bps: evaluate_with_rate returns correct rate ----

    fn rule_with_rate(pattern: &str, rate_bps: i64) -> EgressRule {
        EgressRule {
            pattern: pattern.to_string(),
            http_methods: vec![],
            rate_bps,
        }
    }

    #[tokio::test]
    async fn evaluate_with_rate_returns_zero_for_unlimited_rule() {
        let policy = make_policy(vec![rule("api.openai.com")]);
        let (decision, rate) = policy.evaluate_with_rate("api.openai.com", 443).await;
        assert!(matches!(decision, Decision::Allow));
        assert_eq!(rate, 0);
    }

    #[tokio::test]
    async fn evaluate_with_rate_returns_nonzero_for_rate_limited_rule() {
        let policy = make_policy(vec![rule_with_rate("api.openai.com", 1_000_000)]);
        let (decision, rate) = policy.evaluate_with_rate("api.openai.com", 443).await;
        assert!(matches!(decision, Decision::Allow));
        assert_eq!(rate, 1_000_000);
    }

    #[tokio::test]
    async fn evaluate_with_rate_deny_returns_zero_rate() {
        let policy = make_policy(vec![rule_with_rate("api.openai.com", 500_000)]);
        let (decision, rate) = policy.evaluate_with_rate("evil.com", 443).await;
        assert!(matches!(decision, Decision::Deny(_)));
        assert_eq!(rate, 0);
    }

    #[tokio::test]
    async fn evaluate_with_rate_negative_rate_bps_treated_as_zero() {
        // rate_bps is i64 in the proto; negative means misconfigured — clamp to 0.
        let policy = make_policy(vec![rule_with_rate("api.openai.com", -100)]);
        let (decision, rate) = policy.evaluate_with_rate("api.openai.com", 443).await;
        assert!(matches!(decision, Decision::Allow));
        assert_eq!(rate, 0);
    }

    // ---- TokenBucket: pure math tests ----

    #[tokio::test]
    async fn token_bucket_unlimited_never_sleeps() {
        // rate_bps == 0 means unlimited; consume should return immediately.
        let mut bucket = TokenBucket::new(0);
        let start = std::time::Instant::now();
        bucket.consume(1_000_000).await;
        // Should complete well under 1ms, certainly under 100ms.
        assert!(start.elapsed().as_millis() < 100);
    }

    #[tokio::test]
    async fn token_bucket_burst_consumes_without_wait() {
        // A fresh bucket starts full (1 second of burst). Consuming up to
        // rate_bps bytes must not sleep.
        let rate: u64 = 100_000;
        let mut bucket = TokenBucket::new(rate);
        let start = std::time::Instant::now();
        bucket.consume(rate).await; // exactly one burst — should not sleep
        assert!(start.elapsed().as_millis() < 100, "burst should not wait");
    }

    #[tokio::test]
    async fn token_bucket_overdraft_waits() {
        // Consuming 2× the burst should require waiting ~1 second.
        let rate: u64 = 50_000;
        let mut bucket = TokenBucket::new(rate);
        // Drain the burst first (no sleep).
        bucket.consume(rate).await;
        // Now consume another burst — this should sleep ~1s.
        let start = std::time::Instant::now();
        bucket.consume(rate).await;
        let elapsed = start.elapsed();
        // Allow generous bounds: must wait at least 800ms, not more than 3s.
        assert!(
            elapsed.as_millis() >= 800,
            "expected ~1s wait, got {}ms",
            elapsed.as_millis()
        );
        assert!(
            elapsed.as_millis() < 3000,
            "wait took too long: {}ms",
            elapsed.as_millis()
        );
    }

    #[tokio::test]
    async fn token_bucket_zero_consume_is_noop() {
        let mut bucket = TokenBucket::new(1000);
        let start = std::time::Instant::now();
        bucket.consume(0).await;
        assert!(start.elapsed().as_millis() < 50);
    }

    // ---- HTTP method filtering: check_method ----

    fn rule_with_methods(pattern: &str, methods: &[&str]) -> EgressRule {
        EgressRule {
            pattern: pattern.to_string(),
            http_methods: methods.iter().map(|s| s.to_string()).collect(),
            rate_bps: 0,
        }
    }

    #[tokio::test]
    async fn check_method_empty_list_allows_all() {
        // An empty http_methods list means all methods are permitted.
        let policy = make_policy(vec![rule("api.example.com")]);
        assert!(policy.check_method("api.example.com", "GET").await);
        assert!(policy.check_method("api.example.com", "POST").await);
        assert!(policy.check_method("api.example.com", "DELETE").await);
    }

    #[tokio::test]
    async fn check_method_allows_listed_method() {
        let policy = make_policy(vec![rule_with_methods("api.example.com", &["GET", "POST"])]);
        assert!(policy.check_method("api.example.com", "GET").await);
        assert!(policy.check_method("api.example.com", "POST").await);
    }

    #[tokio::test]
    async fn check_method_denies_unlisted_method() {
        let policy = make_policy(vec![rule_with_methods("api.example.com", &["GET"])]);
        assert!(!policy.check_method("api.example.com", "POST").await);
        assert!(!policy.check_method("api.example.com", "DELETE").await);
    }

    #[tokio::test]
    async fn check_method_is_case_insensitive() {
        let policy = make_policy(vec![rule_with_methods("api.example.com", &["GET"])]);
        assert!(policy.check_method("api.example.com", "get").await);
        assert!(policy.check_method("api.example.com", "Get").await);
    }

    #[tokio::test]
    async fn check_method_wildcard_rule_allows_all_methods() {
        let policy = make_policy(vec![rule_with_methods("*.example.com", &["GET"])]);
        assert!(policy.check_method("api.example.com", "GET").await);
        assert!(!policy.check_method("api.example.com", "DELETE").await);
    }

    // ---- extract_host_for_plain_http (pure) ----

    #[test]
    fn host_extracted_from_absolute_uri() {
        let headers: Vec<String> = vec![];
        assert_eq!(
            extract_host_for_plain_http("http://api.example.com/path", &headers),
            Some("api.example.com".to_string())
        );
    }

    #[test]
    fn host_extracted_from_absolute_uri_with_port() {
        let headers: Vec<String> = vec![];
        assert_eq!(
            extract_host_for_plain_http("http://api.example.com:8080/path", &headers),
            Some("api.example.com:8080".to_string())
        );
    }

    #[test]
    fn host_extracted_from_host_header() {
        let headers = vec!["Host: api.example.com\r\n".to_string()];
        assert_eq!(
            extract_host_for_plain_http("/path", &headers),
            Some("api.example.com".to_string())
        );
    }

    #[test]
    fn host_returns_none_when_absent() {
        let headers: Vec<String> = vec![];
        assert_eq!(extract_host_for_plain_http("/path", &headers), None);
    }

    // ---- parse_host_port_with_default ----

    #[test]
    fn parse_with_default_uses_explicit_port() {
        assert_eq!(
            parse_host_port_with_default("api.example.com:8080", 80),
            ("api.example.com".to_string(), 8080)
        );
    }

    #[test]
    fn parse_with_default_falls_back_to_default_port() {
        assert_eq!(
            parse_host_port_with_default("api.example.com", 80),
            ("api.example.com".to_string(), 80)
        );
    }

    // ---- P2-B7 (2): egress enforcement preflight ----

    #[test]
    fn preflight_ok_when_no_egress_configured() {
        // No rules → nothing to enforce, regardless of REDIRECT presence.
        assert_eq!(preflight_decision(false, false, true), PreflightOutcome::Ok);
        assert_eq!(
            preflight_decision(false, false, false),
            PreflightOutcome::Ok
        );
    }

    #[test]
    fn preflight_ok_when_redirect_present() {
        // Egress configured AND enforcement present → safe.
        assert_eq!(preflight_decision(true, true, true), PreflightOutcome::Ok);
        assert_eq!(preflight_decision(true, true, false), PreflightOutcome::Ok);
    }

    #[test]
    fn preflight_fails_closed_when_configured_but_enforcement_absent() {
        // The scary case: rules declared, REDIRECT missing, fail-closed on.
        assert_eq!(
            preflight_decision(true, false, true),
            PreflightOutcome::FailClosed
        );
    }

    #[test]
    fn preflight_warns_when_enforcement_absent_but_not_fail_closed() {
        // Dev override: rules declared, REDIRECT missing, fail-closed off.
        assert_eq!(
            preflight_decision(true, false, false),
            PreflightOutcome::WarnOnly
        );
    }
}
