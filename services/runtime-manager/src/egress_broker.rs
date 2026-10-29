//! Host-side egress broker (ADR 0026).
//!
//! In `LANTERN_EGRESS_MODE=broker` a Firecracker guest has NO network device.
//! Its only way out is vsock: the in-guest harness bridges the workload's
//! `HTTP(S)_PROXY` (127.0.0.1:3128) to guest-initiated vsock port
//! [`EGRESS_VSOCK_PORT`], which Firecracker surfaces on the host as the Unix
//! socket `<vsock_uds>_<port>`. This module listens there, per VM, and:
//!
//! * enforces the VM's `egress_rules` (host pattern, port allowlist, private /
//!   metadata IP denial, HTTP methods, `rate_bps`) — the same matcher as the
//!   in-guest proxy, kept in parity by `services/testdata/egress_match_cases.json`;
//! * opens the upstream TCP connection FROM THE HOST (DNS resolved once, the
//!   resolved addresses re-checked against private ranges, then dialled);
//! * injects credentials: a rule with `inject` entries gets those headers set
//!   from the manager's [`SecretResolver`] at request time. HTTPS is terminated
//!   with a per-VM ephemeral CA (only for hosts that have an injection rule —
//!   everything else is an opaque CONNECT tunnel); plain HTTP is rewritten in
//!   place;
//! * audits every decision through the manager's report path (`egress` /
//!   `egress_inject` actions). Audit attrs carry header NAMES, never values.
//!
//! The secret value lives only in this process, for the duration of one request
//! write. It is never logged, traced, audited, or written into the guest
//! (invariant #10).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::net::{TcpStream, UnixListener};
use tokio::sync::mpsc;

use crate::proto::{CredentialInjection, EgressRule, pb};
use crate::secret_resolver::{ResolveScope, SecretResolver};

/// Guest→host vsock port the harness forwarder dials for egress.
pub const EGRESS_VSOCK_PORT: u32 = 3128;
/// Guest→host vsock port for the harness's gRPC control channel (relayed to
/// the manager's own listener; mTLS stays end-to-end).
pub const MANAGER_VSOCK_PORT: u32 = 50054;
/// Name the guest dials the manager by. Must match a DNS SAN on the manager's
/// server certificate (same constant as the harness's `MANAGER_HOSTNAME`).
pub const MANAGER_HOSTNAME: &str = "manager.lantern.internal";

/// Cap on a request head (request line + headers) read from the guest. The
/// guest is untrusted; an unbounded `read_line` would let it grow host memory.
const MAX_HEAD_BYTES: u64 = 64 * 1024;
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound on every guest- or upstream-paced handshake step: request head,
/// guest TLS accept, DNS + upstream TLS. A slow-loris guest cannot pin a
/// connection slot past this.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// A spliced connection with no bytes in EITHER direction for this long is
/// closed (frees the per-VM slot).
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// Concurrent connections per VM, per listener (egress broker and the
/// control relay each have their own budget).
pub const MAX_CONNS_PER_VM: usize = 128;
/// Leaf server configs cached per VM. With exact-host-only injection rules
/// there is one leaf per injecting rule; past this, leaves are minted fresh.
const MAX_LEAVES: usize = 16;
/// Deny audits a VM may push into the shared audit channel: burst, then a
/// sustained rate. Excess denies are still logged locally (L5).
const DENY_AUDIT_BURST: f64 = 20.0;
const DENY_AUDIT_PER_SEC: f64 = 5.0;
/// Opt-in for injecting credentials into plain-HTTP requests (cleartext on
/// the wire). Even then only to port 80.
pub const ENV_PLAIN_INJECT: &str = "PAL_EGRESS_PLAIN_INJECT";

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/// How a Firecracker guest reaches the network.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EgressMode {
    /// Legacy: TAP NIC + in-guest CONNECT proxy (iptables REDIRECT enforced).
    #[default]
    Guest,
    /// No NIC; all egress over vsock to this host-side broker.
    Broker,
}

impl EgressMode {
    pub const ENV: &'static str = "PAL_EGRESS_MODE";

    /// `broker` (case-insensitive) → Broker; anything else → Guest.
    pub fn parse(v: Option<&str>) -> Self {
        match v.map(str::trim) {
            Some(s) if s.eq_ignore_ascii_case("broker") => EgressMode::Broker,
            _ => EgressMode::Guest,
        }
    }

    pub fn from_env() -> Self {
        let raw = pal_env::var(Self::ENV).ok();
        let mode = Self::parse(raw.as_deref());
        if mode == EgressMode::Guest
            && raw
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty() && !v.trim().eq_ignore_ascii_case("guest"))
        {
            tracing::warn!(value = ?raw, "LANTERN_EGRESS_MODE unrecognised — using in-guest egress");
        }
        mode
    }

    /// Value written to `spawn.json` `egress_mode` (empty = legacy, omitted).
    pub fn contract_value(self) -> &'static str {
        match self {
            EgressMode::Guest => "",
            EgressMode::Broker => "broker",
        }
    }
}

// ---------------------------------------------------------------------------
// Matcher — ported from services/harness/src/egress.rs. Parity is pinned by
// services/testdata/egress_match_cases.json, read by both crates' tests.
// ---------------------------------------------------------------------------

/// `"api.x.com"` exact; `"*.x.com"` any proper subdomain; `"*."` never.
pub fn pattern_matches(pattern: &str, host: &str) -> bool {
    if let Some(suffix) = pattern.strip_prefix("*.") {
        if suffix.is_empty() {
            return false;
        }
        host.len() > suffix.len() + 1
            && host.ends_with(suffix)
            && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
    } else {
        pattern == host
    }
}

/// RFC 1918, loopback, link-local (incl. 169.254.169.254), CGNAT, multicast,
/// reserved, and the IPv6 equivalents (+ IPv4-mapped).
pub fn is_private_or_metadata(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 10
                || (o[0] == 172 && (o[1] & 0xf0) == 16)
                || (o[0] == 192 && o[1] == 168)
                || o[0] == 127
                || (o[0] == 169 && o[1] == 254)
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
                || o[0] == 0
                || (o[0] & 0xf0) == 240
                || (o[0] & 0xf0) == 224
                // 192.0.0.0/24 IETF protocol assignments
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                // 198.18.0.0/15 benchmarking
                || (o[0] == 198 && (o[1] & 0xfe) == 18)
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            v6.is_loopback()
                || (seg[0] & 0xfe00) == 0xfc00
                || (seg[0] & 0xffc0) == 0xfe80
                // NAT64 64:ff9b::/96 (well-known) and 64:ff9b:1::/48 (local)
                || (seg[0] == 0x64 && seg[1] == 0xff9b && (seg[2] == 1 || seg[2..6] == [0, 0, 0, 0]))
                || v6
                    .to_ipv4()
                    .is_some_and(|v4| is_private_or_metadata(IpAddr::V4(v4)))
        }
    }
}

/// `"host:port"` / `"[v6]:port"` → (host, port). `None` without a valid port.
pub fn parse_host_port(target: &str) -> Option<(String, u16)> {
    if let Some(rest) = target.strip_prefix('[') {
        let close = rest.find(']')?;
        let port = rest[close + 1..].strip_prefix(':')?.parse().ok()?;
        Some((rest[..close].to_string(), port))
    } else {
        let (host, port) = target.rsplit_once(':')?;
        Some((host.to_string(), port.parse().ok()?))
    }
}

/// The VM's egress allowlist plus the destination-port allowlist.
pub struct Policy {
    rules: Vec<EgressRule>,
    allowed_ports: Vec<u16>,
}

impl Policy {
    pub fn new(rules: Vec<EgressRule>, allowed_ports: Vec<u16>) -> Self {
        Self {
            rules,
            allowed_ports,
        }
    }

    /// Ports from `LANTERN_EGRESS_ALLOWED_PORTS` (comma list), default `[443]`
    /// — same knob and default as the in-guest proxy.
    pub fn from_env(rules: Vec<EgressRule>) -> Self {
        let ports = match pal_env::var("PAL_EGRESS_ALLOWED_PORTS") {
            Ok(raw) if !raw.trim().is_empty() => raw
                .split(',')
                .filter_map(|s| s.trim().parse().ok())
                .collect(),
            _ => vec![443],
        };
        Self::new(rules, ports)
    }

    /// The first rule admitting `host:port`, or the deny reason.
    pub fn evaluate(&self, host: &str, port: u16) -> Result<&EgressRule, &'static str> {
        if !self.allowed_ports.contains(&port) {
            return Err("port not in allowlist");
        }
        if let Ok(ip) = host.parse::<IpAddr>() {
            if is_private_or_metadata(ip) {
                return Err("IP literal in private/metadata range");
            }
            return self
                .rules
                .iter()
                .find(|r| r.pattern == host)
                .ok_or("IP literal not explicitly allowlisted");
        }
        if self.rules.is_empty() {
            return Err("no rules configured");
        }
        self.rules
            .iter()
            .find(|r| pattern_matches(&r.pattern, host))
            .ok_or("no matching allowlist rule")
    }
}

/// Empty `http_methods` = any; else case-insensitive membership.
pub fn method_allowed(rule: &EgressRule, method: &str) -> bool {
    rule.http_methods.is_empty()
        || rule
            .http_methods
            .iter()
            .any(|m| m.eq_ignore_ascii_case(method))
}

/// Whether a CONNECT to a host admitted by `rule` is TLS-terminated (so a
/// credential can be injected) or tunnelled opaquely. Terminate ONLY when the
/// rule injects — every other host keeps end-to-end TLS with the workload.
pub fn terminates_tls(rule: &EgressRule) -> bool {
    !rule.inject.is_empty()
}

// ---------------------------------------------------------------------------
// HTTP head handling
// ---------------------------------------------------------------------------

/// A request line + raw header lines (each still carrying its line ending).
#[derive(Debug, Default)]
struct Head {
    line: String,
    headers: Vec<String>,
}

impl Head {
    fn method_target(&self) -> Option<(&str, &str)> {
        let mut parts = self.line.split_whitespace();
        Some((parts.next()?, parts.next()?))
    }

    /// Every `Host:` header value (trimmed).
    fn host_headers(&self) -> Vec<&str> {
        self.header_values("host")
    }

    /// Every value of header `want` (case-insensitive name, trimmed value).
    fn header_values(&self, want: &str) -> Vec<&str> {
        self.headers
            .iter()
            .filter_map(|h| {
                let (name, value) = h.split_once(':')?;
                name.trim().eq_ignore_ascii_case(want).then(|| value.trim())
            })
            .collect()
    }

    /// Authority a plain-HTTP proxy request targets: the absolute-form
    /// `http://` authority (scheme case-insensitive), else the single `Host:`.
    /// Any other scheme, more than one `Host:`, or a malformed target is an
    /// error — never a silent fall-back to a guest-chosen header.
    fn plain_http_authority(&self) -> Result<&str, &'static str> {
        let (_, target) = self.method_target().ok_or("bad request")?;
        let hosts = self.host_headers();
        if hosts.len() > 1 {
            return Err("multiple Host headers");
        }
        match target_form(target) {
            Target::Absolute { scheme, authority } if scheme.eq_ignore_ascii_case("http") => {
                Ok(authority)
            }
            Target::Absolute { .. } => Err("unsupported request-target scheme"),
            Target::Origin => hosts
                .first()
                .copied()
                .filter(|h| !h.is_empty())
                .ok_or("missing-host"),
            Target::Other => Err("bad request target"),
        }
    }
}

/// The request-target forms the broker distinguishes.
#[derive(Debug, PartialEq, Eq)]
enum Target<'a> {
    /// `/path?query`
    Origin,
    /// `scheme://authority/...`
    Absolute { scheme: &'a str, authority: &'a str },
    /// asterisk-form, authority-form, or garbage.
    Other,
}

fn target_form(target: &str) -> Target<'_> {
    if target.starts_with('/') {
        return Target::Origin;
    }
    let Some((scheme, rest)) = target.split_once("://") else {
        return Target::Other;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if scheme.is_empty() || authority.is_empty() {
        return Target::Other;
    }
    Target::Absolute { scheme, authority }
}

/// M1: the request must name exactly the host the policy approved, so a
/// credential can never ride a request addressed elsewhere (another vhost on
/// the same IP, a different absolute-form authority, a duplicated `Host:`).
/// Target: origin-form, or absolute-form with `scheme` and authority
/// `host[:port]`. `Host:` exactly one equal to `host[:port]` — required when
/// `require_host` (injecting rules), else at most one and matching.
fn bound_to_host(
    head: &Head,
    host: &str,
    scheme: &str,
    port: u16,
    require_host: bool,
) -> Result<(), &'static str> {
    let matches = |a: &str| {
        let a = a.trim();
        a.eq_ignore_ascii_case(host)
            || a.eq_ignore_ascii_case(&format!("{host}:{port}"))
            || a.eq_ignore_ascii_case(&format!("[{host}]"))
            || a.eq_ignore_ascii_case(&format!("[{host}]:{port}"))
    };
    let (_, target) = head.method_target().ok_or("bad request")?;
    match target_form(target) {
        Target::Origin => {}
        Target::Absolute {
            scheme: s,
            authority,
        } if s.eq_ignore_ascii_case(scheme) && matches(authority) => {}
        _ => return Err("request target not bound to the approved host"),
    }
    match head.host_headers().as_slice() {
        [h] if matches(h) => Ok(()),
        [] if !require_host => Ok(()),
        _ => Err("Host header not bound to the approved host"),
    }
}

/// L1: methods never allowed to carry an injected credential (TRACE echoes
/// request headers back; CONNECT inside the tunnel would re-target it).
fn method_forbidden_for_injection(method: &str) -> bool {
    method.eq_ignore_ascii_case("TRACE") || method.eq_ignore_ascii_case("CONNECT")
}

/// Read one request head, bounded by [`MAX_HEAD_BYTES`]. `Ok(None)` on a
/// connection closed before any byte.
async fn read_head<R: AsyncBufRead + Unpin>(r: &mut R) -> std::io::Result<Option<Head>> {
    let mut limited = r.take(MAX_HEAD_BYTES);
    let mut head = Head::default();
    if limited.read_line(&mut head.line).await? == 0 {
        return Ok(None);
    }
    loop {
        let mut h = String::new();
        let n = limited.read_line(&mut h).await?;
        if n == 0 || !h.ends_with('\n') {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request head truncated or larger than the limit",
            ));
        }
        if h == "\r\n" || h == "\n" {
            return Ok(Some(head));
        }
        head.headers.push(h);
    }
}

fn header_name(line: &str) -> &str {
    line.split(':').next().unwrap_or("").trim()
}

/// Serialize the head to forward upstream: hop-by-hop + proxy headers and any
/// workload-supplied header that a credential replaces are dropped, the
/// credentials are added, and `Connection: close` is forced.
///
/// ponytail: `Connection: close` means one injected request per upstream
/// connection — the client reconnects for the next one, so a keep-alive
/// follow-up can never ride a connection without its header. Parse request
/// framing (Content-Length / chunked) if per-request reconnects ever cost too much.
///
/// `drop_expect`: the broker already answered `Expect: 100-continue` itself
/// (DLP reads the body before dialling), so the upstream must not see it.
fn rewrite_head(head: &Head, creds: &[(String, String)], drop_expect: bool) -> Vec<u8> {
    let replaced = |name: &str| {
        ["connection", "proxy-connection", "proxy-authorization"]
            .iter()
            .any(|h| name.eq_ignore_ascii_case(h))
            || (drop_expect && name.eq_ignore_ascii_case("expect"))
            || creds.iter().any(|(n, _)| name.eq_ignore_ascii_case(n))
    };
    let mut out = Vec::with_capacity(head.line.len() + 64 * (head.headers.len() + 2));
    out.extend_from_slice(head.line.as_bytes());
    for h in head.headers.iter().filter(|h| !replaced(header_name(h))) {
        out.extend_from_slice(h.as_bytes());
    }
    for (name, value) in creds {
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"Connection: close\r\n\r\n");
    out
}

/// Serialise a [`Head`] back to its raw bytes (request line + headers + blank line).
/// Used by DLP inspection to build the scan buffer.
fn head_bytes(head: &Head) -> Vec<u8> {
    let cap = head.line.len() + head.headers.iter().map(|h| h.len()).sum::<usize>() + 2;
    let mut out = Vec::with_capacity(cap);
    out.extend_from_slice(head.line.as_bytes());
    for h in &head.headers {
        out.extend_from_slice(h.as_bytes());
    }
    out.extend_from_slice(b"\r\n");
    out
}

/// RFC 7230 token check for a header name from the spec.
fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

async fn respond<W: AsyncWrite + Unpin>(w: &mut W, status: &str, reason: &str) {
    let msg = format!(
        "HTTP/1.1 {status}\r\nX-Lantern-Reason: {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = w.write_all(msg.as_bytes()).await;
    let _ = w.flush().await;
}

// ---------------------------------------------------------------------------
// Per-VM ephemeral CA (TLS termination for injected hosts only)
// ---------------------------------------------------------------------------

/// Ephemeral CA generated per VM at spawn. Its certificate is written into
/// `spawn.json` so the guest trusts it; its key never leaves this process.
/// The CA is name-constrained to the injection rules' hosts, so even a
/// guest-side trust of it cannot vouch for any other name.
pub struct MitmCa {
    ca_cert: rcgen::Certificate,
    ca_key: rcgen::KeyPair,
    leaves: Mutex<HashMap<String, Arc<rustls::ServerConfig>>>,
}

fn ring_provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

impl MitmCa {
    /// A CA for the rules that inject, or `None` when none do (then no TLS is
    /// ever terminated). Errors on an injection rule whose pattern is not a
    /// hostname — name constraints (and SNI) need a DNS name.
    pub fn for_rules(vm_id: &str, rules: &[EgressRule]) -> Result<Option<Self>> {
        let mut permitted = Vec::new();
        for rule in rules.iter().filter(|r| terminates_tls(r)) {
            // M2: exact hostnames only. A wildcard would let the CA (and the
            // credential) cover every subdomain, including attacker-chosen ones.
            let dns = rule.pattern.as_str();
            if dns.is_empty()
                || dns.contains('*')
                || dns.parse::<IpAddr>().is_ok()
                || dns.contains('/')
            {
                bail!(
                    "egress rule '{}' injects credentials but is not an exact hostname",
                    rule.pattern
                );
            }
            for inj in &rule.inject {
                if !valid_header_name(&inj.header) || inj.secret_uri.is_empty() {
                    bail!(
                        "egress rule '{}' has an invalid injection (header name or secret ref)",
                        rule.pattern
                    );
                }
                if inj.value_prefix.contains(['\r', '\n']) {
                    bail!("egress rule '{}' value_prefix contains CR/LF", rule.pattern);
                }
            }
            permitted.push(rcgen::GeneralSubtree::DnsName(dns.to_string()));
        }
        if permitted.is_empty() {
            return Ok(None);
        }

        let now = time::OffsetDateTime::now_utc();
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new())?;
        params.distinguished_name.push(
            rcgen::DnType::CommonName,
            format!("lantern egress broker CA {vm_id}"),
        );
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
        params.key_usages = vec![
            rcgen::KeyUsagePurpose::KeyCertSign,
            rcgen::KeyUsagePurpose::CrlSign,
        ];
        params.name_constraints = Some(rcgen::NameConstraints {
            permitted_subtrees: permitted,
            excluded_subtrees: vec![],
        });
        params.not_before = now - time::Duration::hours(1);
        params.not_after = now + time::Duration::days(365);
        let ca_key = rcgen::KeyPair::generate()?;
        let ca_cert = params.self_signed(&ca_key)?;
        Ok(Some(Self {
            ca_cert,
            ca_key,
            leaves: Mutex::new(HashMap::new()),
        }))
    }

    /// PEM of the CA certificate (public — goes into `spawn.json`).
    pub fn ca_pem(&self) -> String {
        self.ca_cert.pem()
    }

    #[cfg(test)]
    fn ca_der(&self) -> rustls::pki_types::CertificateDer<'static> {
        self.ca_cert.der().clone()
    }

    /// TLS server config presenting a leaf for `host`, cached per host.
    fn server_config(&self, host: &str) -> Result<Arc<rustls::ServerConfig>> {
        let mut leaves = self
            .leaves
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cfg) = leaves.get(host) {
            return Ok(Arc::clone(cfg));
        }
        let now = time::OffsetDateTime::now_utc();
        let mut params = rcgen::CertificateParams::new(vec![host.to_string()])?;
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, host);
        params.not_before = now - time::Duration::hours(1);
        params.not_after = now + time::Duration::days(365);
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        let key = rcgen::KeyPair::generate()?;
        let leaf = params.signed_by(&key, &self.ca_cert, &self.ca_key)?;
        let mut cfg = rustls::ServerConfig::builder_with_provider(ring_provider())
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf.der().clone(), self.ca_cert.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )?;
        // The broker parses HTTP/1.1 heads; never negotiate h2.
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        let cfg = Arc::new(cfg);
        if leaves.len() < MAX_LEAVES {
            leaves.insert(host.to_string(), Arc::clone(&cfg));
        }
        Ok(cfg)
    }
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

/// Process-wide dependencies every per-VM broker shares.
#[derive(Clone)]
pub struct BrokerDeps {
    pub resolver: Arc<dyn SecretResolver>,
    /// Audit events toward the report forwarder (see `main.rs`).
    pub audit: mpsc::Sender<pb::AuditEvent>,
    /// Roots for verifying upstream servers on the terminated path.
    pub upstream_roots: Arc<rustls::RootCertStore>,
}

/// System trust roots for upstream verification. An empty store (no roots
/// found) fails every terminated connection closed rather than open.
pub fn native_roots() -> rustls::RootCertStore {
    let found = rustls_native_certs::load_native_certs();
    if !found.errors.is_empty() {
        tracing::warn!(
            errors = found.errors.len(),
            "egress broker: some native roots failed to load"
        );
    }
    let mut roots = rustls::RootCertStore::empty();
    let (added, ignored) = roots.add_parsable_certificates(found.certs);
    tracing::info!(added, ignored, "egress broker: loaded upstream trust roots");
    roots
}

/// One VM's broker.
pub struct Broker {
    vm_id: String,
    /// The VM's tenant from the manager's spawn record — the relay resolves
    /// injected refs only inside it.
    tenant_id: String,
    policy: Policy,
    resolver: Arc<dyn SecretResolver>,
    mitm: Option<Arc<MitmCa>>,
    upstream_tls: Arc<rustls::ClientConfig>,
    audit: mpsc::Sender<pb::AuditEvent>,
    /// M3: per-VM concurrent connection budget on the egress listener.
    conns: Arc<tokio::sync::Semaphore>,
    handshake_timeout: Duration,
    idle_timeout: Duration,
    /// H1: `LANTERN_EGRESS_PLAIN_INJECT=1` (port 80 only even then).
    plain_inject: bool,
    /// L5: token bucket for deny audits into the shared channel.
    deny_bucket: Mutex<(f64, Instant)>,
    /// DLP engine compiled from the per-tenant policy (ADR 0030). `None` means
    /// no DLP is configured — zero overhead on the data path.
    dlp: Option<Arc<crate::dlp::DlpEngine>>,
    /// Test seam: dial this address for every allowed host, skipping DNS and
    /// the private-range check (test servers live on loopback).
    #[cfg(test)]
    test_upstream: Option<SocketAddr>,
}

impl Broker {
    pub fn new(
        vm_id: &str,
        tenant_id: &str,
        policy: Policy,
        mitm: Option<Arc<MitmCa>>,
        deps: &BrokerDeps,
    ) -> Result<Self> {
        let mut tls = rustls::ClientConfig::builder_with_provider(ring_provider())
            .with_safe_default_protocol_versions()?
            .with_root_certificates(Arc::clone(&deps.upstream_roots))
            .with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Self {
            vm_id: vm_id.to_string(),
            tenant_id: tenant_id.to_string(),
            policy,
            resolver: Arc::clone(&deps.resolver),
            mitm,
            upstream_tls: Arc::new(tls),
            audit: deps.audit.clone(),
            conns: Arc::new(tokio::sync::Semaphore::new(MAX_CONNS_PER_VM)),
            handshake_timeout: HANDSHAKE_TIMEOUT,
            idle_timeout: IDLE_TIMEOUT,
            plain_inject: pal_env::var(ENV_PLAIN_INJECT).is_ok_and(|v| v.trim() == "1"),
            deny_bucket: Mutex::new((DENY_AUDIT_BURST, Instant::now())),
            dlp: None,
            #[cfg(test)]
            test_upstream: None,
        })
    }

    /// Attach a compiled DLP engine to this broker.
    pub fn with_dlp(mut self, dlp: Arc<crate::dlp::DlpEngine>) -> Self {
        self.dlp = Some(dlp);
        self
    }

    /// L5: take one deny-audit token (refilled at `DENY_AUDIT_PER_SEC`).
    fn take_deny_token(&self) -> bool {
        let mut b = self
            .deny_bucket
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Instant::now();
        b.0 = (b.0 + now.duration_since(b.1).as_secs_f64() * DENY_AUDIT_PER_SEC)
            .min(DENY_AUDIT_BURST);
        b.1 = now;
        if b.0 >= 1.0 {
            b.0 -= 1.0;
            true
        } else {
            false
        }
    }

    /// Accept guest connections forever, one task each.
    pub async fn serve(self: Arc<Self>, listener: UnixListener) {
        loop {
            match listener.accept().await {
                Ok((conn, _)) => {
                    // M3: a VM may hold at most MAX_CONNS_PER_VM connections;
                    // beyond that new ones are closed immediately.
                    let Ok(permit) = Arc::clone(&self.conns).try_acquire_owned() else {
                        drop(conn);
                        self.audit_decision("-", 0, Err("per-VM connection limit"), "-");
                        continue;
                    };
                    let broker = Arc::clone(&self);
                    tokio::spawn(async move {
                        let _permit = permit;
                        if let Err(e) = broker.serve_conn(conn).await {
                            tracing::debug!(error = %e, "egress broker: connection ended with error");
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!(vm_id = %self.vm_id, error = %e, "egress broker: accept failed");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    /// Handle one proxy connection (CONNECT or plain HTTP) from the guest.
    pub async fn serve_conn<S>(&self, stream: S) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send,
    {
        let mut reader = BufReader::new(stream);
        let Ok(head) = tokio::time::timeout(self.handshake_timeout, read_head(&mut reader)).await
        else {
            return Ok(()); // M3: slow/silent guest — drop it
        };
        let Some(head) = head? else {
            return Ok(());
        };
        let Some((method, target)) = head.method_target() else {
            respond(&mut reader, "400 Bad Request", "bad-request").await;
            return Ok(());
        };
        if method.eq_ignore_ascii_case("CONNECT") {
            let target = target.to_string();
            self.handle_connect(reader, &target).await
        } else {
            self.handle_plain(reader, head).await
        }
    }

    async fn handle_connect<S>(&self, mut client: BufReader<S>, target: &str) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send,
    {
        let Some((host, port)) = parse_host_port(target) else {
            respond(&mut client, "400 Bad Request", "missing-port").await;
            return Ok(());
        };
        let rule = match self.policy.evaluate(&host, port) {
            Ok(r) => r,
            Err(reason) => {
                self.audit_decision(&host, port, Err(reason), "connect");
                respond(&mut client, "403 Forbidden", reason).await;
                return Ok(());
            }
        };
        let terminate = terminates_tls(rule);
        let mitm = match (&self.mitm, terminate) {
            (Some(ca), true) => Some(Arc::clone(ca)),
            (None, true) => {
                let reason = "credential injection unavailable";
                self.audit_decision(&host, port, Err(reason), "connect");
                respond(&mut client, "403 Forbidden", reason).await;
                return Ok(());
            }
            _ => None,
        };
        let rate = rule.rate_bps.max(0) as u64;
        if let Some(ca) = mitm {
            // M3: nothing is dialled for an injecting rule until the guest has
            // completed TLS and its inner request head passed authorisation.
            self.audit_decision(&host, port, Ok(()), "terminate");
            client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await?;
            return self.terminate(client, &host, port, rule, &ca).await;
        }
        let upstream = match self.dial(&host, port).await {
            Ok(s) => s,
            Err(reason) => {
                self.audit_decision(&host, port, Err(reason), "connect");
                respond(&mut client, "502 Bad Gateway", reason).await;
                return Ok(());
            }
        };
        self.audit_decision(&host, port, Ok(()), "passthrough");
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await?;
        splice(client, upstream, rate, self.idle_timeout).await
    }

    /// TLS-terminate the workload's tunnel for an injecting rule, inject the
    /// credential into its request, and re-encrypt to the real upstream.
    async fn terminate<S>(
        &self,
        client: BufReader<S>,
        host: &str,
        port: u16,
        rule: &EgressRule,
        ca: &MitmCa,
    ) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send,
    {
        let cfg = ca.server_config(host)?;
        // `client` is the BufReader: any ClientHello bytes already buffered
        // past the CONNECT head are read first, so nothing is lost.
        let tls = tokio::time::timeout(
            self.handshake_timeout,
            tokio_rustls::TlsAcceptor::from(cfg).accept(client),
        )
        .await
        .context("egress broker: guest TLS accept timed out")?
        .context("egress broker: TLS accept from guest")?;
        let mut inner = BufReader::new(tls);
        let Ok(head) = tokio::time::timeout(self.handshake_timeout, read_head(&mut inner)).await
        else {
            return Ok(());
        };
        let Some(head) = head? else {
            return Ok(());
        };
        let method = head.method_target().map(|(m, _)| m).unwrap_or("");
        // M1 + L1, BEFORE the secret is resolved or anything is dialled.
        if let Err(reason) = self.injection_preflight(&head, host, "https", port, method) {
            respond(&mut inner, "403 Forbidden", reason).await;
            return Ok(());
        }
        let Some(creds) = self
            .authorize_and_resolve(&mut inner, host, rule, method)
            .await
        else {
            return Ok(());
        };
        // ADR 0030: DLP scan BEFORE the upstream dial so a blocked request
        // incurs no dial cost. `body_prefix` carries early body bytes to
        // forward after the rewritten head; opaque CONNECT tunnels (below)
        // are never inspected here.
        let Some(body_prefix) = self.dlp_scan(&mut inner, host, method, &head).await? else {
            return Ok(()); // blocked — 403 already sent
        };
        let upstream = match self.dial(host, port).await {
            Ok(s) => s,
            Err(reason) => {
                self.audit_decision(host, port, Err(reason), "terminate");
                respond(&mut inner, "502 Bad Gateway", reason).await;
                return Ok(());
            }
        };
        let server_name =
            ServerName::try_from(host.to_string()).context("egress broker: invalid SNI host")?;
        let mut up = tokio::time::timeout(
            self.handshake_timeout,
            tokio_rustls::TlsConnector::from(Arc::clone(&self.upstream_tls))
                .connect(server_name, upstream),
        )
        .await
        .context("egress broker: upstream TLS handshake timed out")?
        .context("egress broker: upstream TLS handshake")?;
        let out = rewrite_head(&head, &creds, self.dlp.is_some());
        drop(creds);
        up.write_all(&out).await?;
        drop(out);
        if !body_prefix.is_empty() {
            up.write_all(&body_prefix).await?;
        }
        self.audit_inject(host, method, rule);
        splice(inner, up, rule.rate_bps.max(0) as u64, self.idle_timeout).await
    }

    /// Host binding (M1) + forbidden methods (L1) for a request that would
    /// carry an injected credential. Audits the deny; the caller answers 403.
    fn injection_preflight(
        &self,
        head: &Head,
        host: &str,
        scheme: &str,
        port: u16,
        method: &str,
    ) -> Result<(), &'static str> {
        let verdict = if method_forbidden_for_injection(method) {
            Err("method never carries an injected credential")
        } else {
            bound_to_host(head, host, scheme, port, true)
        };
        if let Err(reason) = verdict {
            self.audit_inject_deny(host, method, reason);
        }
        verdict
    }

    async fn handle_plain<S>(&self, mut client: BufReader<S>, head: Head) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send,
    {
        let authority = match head.plain_http_authority() {
            Ok(a) => a,
            Err(reason) => {
                respond(&mut client, "400 Bad Request", reason).await;
                return Ok(());
            }
        };
        let (host, port) = parse_host_port(authority)
            .unwrap_or_else(|| (authority.trim_matches(['[', ']']).to_string(), 80));
        let rule = match self.policy.evaluate(&host, port) {
            Ok(r) => r,
            Err(reason) => {
                self.audit_decision(&host, port, Err(reason), "plain");
                respond(&mut client, "403 Forbidden", reason).await;
                return Ok(());
            }
        };
        let method = head.method_target().map(|(m, _)| m).unwrap_or("");
        let creds = if rule.inject.is_empty() {
            // The forwarded Host must name the approved host too (no vhost
            // hop past the allowlist on a shared IP).
            if let Err(reason) = bound_to_host(&head, &host, "http", port, false) {
                self.audit_decision(&host, port, Err(reason), "plain");
                respond(&mut client, "403 Forbidden", reason).await;
                return Ok(());
            }
            if !method_allowed(rule, method) {
                self.audit_decision(&host, port, Err("method-not-allowed"), "plain");
                respond(&mut client, "403 Forbidden", "method-not-allowed").await;
                return Ok(());
            }
            Vec::new()
        } else {
            // H1: a credential in a plain-HTTP request crosses the network in
            // cleartext. Refused unless explicitly enabled, and then only to
            // port 80 — never e.g. `http://host:443/`.
            if !(self.plain_inject && port == 80) {
                let reason = "plain-HTTP credential injection refused";
                self.audit_inject_deny(&host, method, reason);
                respond(&mut client, "403 Forbidden", reason).await;
                return Ok(());
            }
            if let Err(reason) = self.injection_preflight(&head, &host, "http", port, method) {
                respond(&mut client, "403 Forbidden", reason).await;
                return Ok(());
            }
            match self
                .authorize_and_resolve(&mut client, &host, rule, method)
                .await
            {
                Some(c) => c,
                None => return Ok(()),
            }
        };
        // ADR 0030: DLP scan BEFORE the upstream dial.
        let Some(body_prefix) = self.dlp_scan(&mut client, &host, method, &head).await? else {
            return Ok(()); // blocked — 403 already sent
        };
        let mut upstream = match self.dial(&host, port).await {
            Ok(s) => s,
            Err(reason) => {
                self.audit_decision(&host, port, Err(reason), "plain");
                respond(&mut client, "502 Bad Gateway", reason).await;
                return Ok(());
            }
        };
        self.audit_decision(&host, port, Ok(()), "plain");
        let out = rewrite_head(&head, &creds, self.dlp.is_some());
        let injected = !creds.is_empty();
        drop(creds);
        upstream.write_all(&out).await?;
        drop(out);
        if !body_prefix.is_empty() {
            upstream.write_all(&body_prefix).await?;
        }
        if injected {
            self.audit_inject(&host, method, rule);
        }
        splice(
            client,
            upstream,
            rule.rate_bps.max(0) as u64,
            self.idle_timeout,
        )
        .await
    }

    /// Method check + secret resolution for an injecting rule. On failure the
    /// guest gets a 403/502 and the deny is audited; returns `None`.
    async fn authorize_and_resolve<W: AsyncWrite + Unpin>(
        &self,
        client: &mut W,
        host: &str,
        rule: &EgressRule,
        method: &str,
    ) -> Option<Vec<(String, String)>> {
        if !method_allowed(rule, method) {
            self.audit_inject_deny(host, method, "method-not-allowed");
            respond(client, "403 Forbidden", "method-not-allowed").await;
            return None;
        }
        match self.resolve(&rule.inject).await {
            Ok(c) => Some(c),
            Err(reason) => {
                self.audit_inject_deny(host, method, reason);
                respond(client, "502 Bad Gateway", reason).await;
                None
            }
        }
    }

    /// Resolve each injection's secret on the host. Error strings are static:
    /// they reach the guest and the audit, so they must not echo the value.
    async fn resolve(
        &self,
        inject: &[CredentialInjection],
    ) -> Result<Vec<(String, String)>, &'static str> {
        let mut out = Vec::with_capacity(inject.len());
        for inj in inject {
            if !valid_header_name(&inj.header) {
                return Err("invalid injection header");
            }
            // ADR 0008 shared-token relay path (no agent bearer): the URI comes
            // from the manager's own spawn record, not from the guest.
            let scope = ResolveScope {
                tenant_id: &self.tenant_id,
                vm_id: &self.vm_id,
            };
            let value = match self
                .resolver
                .resolve_scoped(&inj.secret_uri, scope, None)
                .await
            {
                Ok(v) => v,
                Err(_) => {
                    tracing::warn!(vm_id = %self.vm_id, header = %inj.header, "egress broker: credential resolution failed");
                    return Err("credential resolution failed");
                }
            };
            if value.contains(['\r', '\n']) || inj.value_prefix.contains(['\r', '\n']) {
                return Err("credential value not header-safe");
            }
            out.push((inj.header.clone(), format!("{}{}", inj.value_prefix, value)));
        }
        Ok(out)
    }

    /// Resolve once, refuse private/metadata answers, dial the checked
    /// addresses (never the name again — no DNS-rebinding window).
    async fn dial(&self, host: &str, port: u16) -> Result<TcpStream, &'static str> {
        #[cfg(test)]
        if let Some(addr) = self.test_upstream {
            return TcpStream::connect(addr)
                .await
                .map_err(|_| "upstream connect failed");
        }
        let addrs: Vec<SocketAddr> = tokio::time::timeout(
            self.handshake_timeout,
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| "DNS resolution timed out")?
        .map_err(|_| "DNS resolution failed")?
        .collect();
        if addrs.iter().any(|a| is_private_or_metadata(a.ip())) {
            return Err("hostname resolves to private/metadata IP");
        }
        for addr in &addrs {
            if let Ok(Ok(s)) =
                tokio::time::timeout(UPSTREAM_CONNECT_TIMEOUT, TcpStream::connect(addr)).await
            {
                return Ok(s);
            }
        }
        Err("upstream connect failed")
    }

    fn emit(&self, action: &str, attrs: HashMap<String, String>) {
        // Local record FIRST: a full channel or a dead forwarder must never
        // make a security decision vanish.
        tracing::info!(target: "lantern_audit", vm_id = %self.vm_id, action, attrs = ?attrs, "egress broker audit");
        // L5: one VM spraying denied requests must not crowd every other VM's
        // audits out of the shared channel. Allows always go through.
        let deny = attrs.get("decision").is_some_and(|d| d == "deny");
        if deny && !self.take_deny_token() {
            tracing::debug!(target: "lantern_audit", vm_id = %self.vm_id, action, "egress broker: deny audit rate-limited (kept in local log)");
            return;
        }
        let ev = pb::AuditEvent {
            vm_id: self.vm_id.clone(),
            action: action.to_string(),
            at: Some(prost_types::Timestamp::from(std::time::SystemTime::now())),
            attrs,
        };
        if self.audit.try_send(ev).is_err() {
            tracing::warn!(target: "lantern_audit", vm_id = %self.vm_id, action, "egress broker: audit channel full/closed — event kept in local log only");
        }
    }

    fn audit_decision(&self, host: &str, port: u16, decision: Result<(), &str>, tls: &str) {
        let mut attrs = HashMap::from([
            ("host".to_string(), host.to_string()),
            ("port".to_string(), port.to_string()),
            ("mode".to_string(), "broker".to_string()),
            ("tls".to_string(), tls.to_string()),
        ]);
        match decision {
            Ok(()) => attrs.insert("decision".into(), "allow".into()),
            Err(reason) => {
                attrs.insert("decision".into(), "deny".into());
                attrs.insert("reason".into(), reason.into())
            }
        };
        self.emit("egress", attrs);
    }

    fn audit_inject(&self, host: &str, method: &str, rule: &EgressRule) {
        let names: Vec<&str> = rule.inject.iter().map(|i| i.header.as_str()).collect();
        self.emit(
            "egress_inject",
            HashMap::from([
                ("host".to_string(), host.to_string()),
                ("method".to_string(), method.to_string()),
                ("decision".to_string(), "allow".to_string()),
                ("headers".to_string(), names.join(",")),
            ]),
        );
    }

    fn audit_inject_deny(&self, host: &str, method: &str, reason: &str) {
        self.emit(
            "egress_inject",
            HashMap::from([
                ("host".to_string(), host.to_string()),
                ("method".to_string(), method.to_string()),
                ("decision".to_string(), "deny".to_string()),
                ("reason".to_string(), reason.to_string()),
            ]),
        );
    }

    /// Emit a `dlp` audit event. Matched value is **never** included (invariant #10).
    fn audit_dlp(&self, host: &str, method: &str, m: &crate::dlp::DlpMatch, decision: &str) {
        self.emit(
            "dlp",
            HashMap::from([
                ("host".into(), host.into()),
                ("method".into(), method.into()),
                ("rule_id".into(), m.rule_id.clone()),
                ("detector".into(), m.detector.clone()),
                ("byte_offset".into(), m.byte_offset.to_string()),
                ("byte_count".into(), m.byte_count.to_string()),
                ("decision".into(), decision.into()),
                // matched_value intentionally absent — invariant #10
            ]),
        );
    }

    /// Emit a `dlp` audit event for a request whose body could not be fully
    /// inspected (no rule matched; nothing about the content is recorded).
    fn audit_dlp_incomplete(&self, host: &str, method: &str, decision: &str) {
        self.emit(
            "dlp",
            HashMap::from([
                ("host".into(), host.into()),
                ("method".into(), method.into()),
                ("decision".into(), decision.into()),
                ("reason".into(), "body-not-fully-inspected".into()),
            ]),
        );
    }

    /// Scan headers + up to `max_inspect_bytes` of body for DLP violations.
    ///
    /// Returns:
    /// - `Ok(Some(raw))` — clean or audit; `raw` is the body bytes consumed
    ///   from the guest, verbatim, to forward after the head
    /// - `Ok(None)` — refused (403/400 already sent to `stream`)
    /// - `Err(_)` — I/O error (request aborted; nothing forwarded)
    ///
    /// Fails closed in block mode: a body the broker could not inspect up to
    /// the cap (the guest went quiet, closed early, or padded the chunk
    /// framing past the raw budget) is refused, never forwarded uninspected.
    async fn dlp_scan<W>(
        &self,
        stream: &mut W,
        host: &str,
        method: &str,
        head: &Head,
    ) -> Result<Option<Vec<u8>>>
    where
        W: AsyncRead + AsyncWrite + Unpin,
    {
        let Some(dlp) = self.dlp.as_ref() else {
            return Ok(Some(Vec::new()));
        };
        let framing = match body_framing(head) {
            Ok(f) => f,
            Err(reason) => {
                // RFC 9112 §6.3: ambiguous framing is a smuggling vector — the
                // broker and the upstream could disagree on where the body ends.
                self.audit_decision(host, 0, Err(reason), "dlp");
                respond(stream, "400 Bad Request", reason).await;
                return Ok(None);
            }
        };
        // We read the body before dialling, so the guest's `Expect:
        // 100-continue` is ours to answer (the header is dropped upstream).
        if framing != Framing::None
            && head
                .header_values("expect")
                .iter()
                .any(|v| v.eq_ignore_ascii_case("100-continue"))
        {
            stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await?;
            stream.flush().await?;
        }
        let body = match read_body_prefix(
            stream,
            framing,
            dlp.max_inspect_bytes,
            self.handshake_timeout,
        )
        .await?
        {
            Ok(b) => b,
            Err(reason) => {
                self.audit_decision(host, 0, Err(reason), "dlp");
                respond(stream, "400 Bad Request", reason).await;
                return Ok(None);
            }
        };
        let mut inspect = head_bytes(head);
        inspect.extend_from_slice(&body.scan);
        match dlp.scan(&inspect) {
            crate::dlp::DlpVerdict::Block(m) => {
                self.audit_dlp(host, method, &m, "block");
                respond(stream, "403 Forbidden", "dlp-block").await;
                return Ok(None);
            }
            crate::dlp::DlpVerdict::Audit(m) => self.audit_dlp(host, method, &m, "audit"),
            crate::dlp::DlpVerdict::Clean => {}
        }
        if !body.complete {
            if dlp.has_block_rules() {
                self.audit_dlp_incomplete(host, method, "block");
                respond(stream, "403 Forbidden", "dlp-incomplete").await;
                return Ok(None);
            }
            self.audit_dlp_incomplete(host, method, "audit");
        }
        Ok(Some(body.raw))
    }
}

/// How a request delimits its body (RFC 9112 §6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Framing {
    None,
    Length(usize),
    Chunked,
}

/// Request body framing, refusing every ambiguous form a smuggler relies on:
/// both Content-Length and Transfer-Encoding, differing Content-Length values,
/// or a Transfer-Encoding whose final coding is not `chunked`.
fn body_framing(head: &Head) -> Result<Framing, &'static str> {
    let te = head.header_values("transfer-encoding");
    let cl: Vec<&str> = head
        .header_values("content-length")
        .into_iter()
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .collect();
    if !te.is_empty() && !cl.is_empty() {
        return Err("both Content-Length and Transfer-Encoding");
    }
    if !te.is_empty() {
        let last = te
            .iter()
            .flat_map(|v| v.split(','))
            .map(str::trim)
            .next_back()
            .unwrap_or("");
        return if last.eq_ignore_ascii_case("chunked") {
            Ok(Framing::Chunked)
        } else {
            Err("Transfer-Encoding not ending in chunked")
        };
    }
    let Some(first) = cl.first() else {
        return Ok(Framing::None);
    };
    if cl.iter().any(|v| v != first) {
        return Err("conflicting Content-Length values");
    }
    // Digits only: `+5` / `-1` parse in Rust but are invalid HTTP.
    if first.is_empty() || !first.bytes().all(|b| b.is_ascii_digit()) {
        return Err("bad Content-Length");
    }
    first
        .parse()
        .map(Framing::Length)
        .map_err(|_| "bad Content-Length")
}

/// What the DLP body read consumed from the guest.
#[derive(Debug, Default)]
struct BodyPrefix {
    /// Bytes read from the guest, verbatim (framing included) — forwarded
    /// upstream ahead of the spliced remainder.
    raw: Vec<u8>,
    /// The de-chunked body prefix the detectors see (≤ cap).
    scan: Vec<u8>,
    /// True when `scan` covers the whole body or the first `cap` bytes of it.
    complete: bool,
}

/// Read the start of the request body for DLP, following the request's own
/// framing. Never read to EOF: the client keeps the connection open waiting
/// for our response. Content-Length → exactly min(len, cap) bytes. No body
/// framing → no body (RFC 9112 §6.3). Chunked → de-chunked, so chunk sizes
/// cannot split a value the detectors look for, up to the terminal chunk or
/// `cap` decoded bytes.
///
/// The whole read shares one `timeout`; a guest that goes quiet (or closes)
/// first yields `complete == false`, which block mode refuses. The outer
/// `Err` is an I/O error; the inner one malformed chunk framing (→ 400).
async fn read_body_prefix<R: AsyncRead + Unpin>(
    r: &mut R,
    framing: Framing,
    cap: usize,
    timeout: Duration,
) -> Result<Result<BodyPrefix, &'static str>> {
    let deadline = tokio::time::Instant::now() + timeout;
    // Chunk framing (sizes, extensions) costs raw bytes beyond the decoded
    // cap; past this budget the body counts as not fully inspected.
    let raw_budget = match framing {
        Framing::None => {
            return Ok(Ok(BodyPrefix {
                complete: true,
                ..Default::default()
            }));
        }
        Framing::Length(n) => n.min(cap),
        Framing::Chunked => 2 * cap + 16 * 1024,
    };
    let mut out = BodyPrefix::default();
    let mut tmp = [0u8; 8192];
    loop {
        match framing {
            Framing::Length(_) if out.raw.len() == raw_budget => {
                out.scan = out.raw.clone();
                out.complete = true;
                return Ok(Ok(out));
            }
            Framing::Chunked => match dechunk(&out.raw, cap) {
                Err(reason) => return Ok(Err(reason)),
                Ok(Some(decoded)) => {
                    out.scan = decoded;
                    out.complete = true;
                    return Ok(Ok(out));
                }
                Ok(None) if out.raw.len() >= raw_budget => break,
                Ok(None) => {}
            },
            _ => {}
        }
        let want = tmp.len().min(raw_budget - out.raw.len());
        match tokio::time::timeout_at(deadline, r.read(&mut tmp[..want])).await {
            Err(_) | Ok(Ok(0)) => break, // quiet or closed before the body was read
            Ok(Ok(k)) => out.raw.extend_from_slice(&tmp[..k]),
            Ok(Err(e)) => return Err(e.into()),
        }
    }
    // Incomplete: scan what arrived (a match still blocks/audits).
    out.scan = match framing {
        Framing::Chunked => dechunk_partial(&out.raw, cap),
        _ => out.raw.clone(),
    };
    Ok(Ok(out))
}

/// Decode a chunked body prefix from `raw`. `Ok(Some(body))` once the
/// terminal chunk is seen or `cap` body bytes are decoded; `Ok(None)` when
/// more raw bytes are needed; `Err` on malformed framing. Trailers after the
/// terminal chunk are not needed for inspection and are forwarded spliced.
fn dechunk(raw: &[u8], cap: usize) -> Result<Option<Vec<u8>>, &'static str> {
    let (body, done) = dechunk_inner(raw, cap)?;
    Ok(done.then_some(body))
}

/// Best-effort decode of whatever arrived (for scanning an incomplete body).
fn dechunk_partial(raw: &[u8], cap: usize) -> Vec<u8> {
    dechunk_inner(raw, cap).map(|(b, _)| b).unwrap_or_default()
}

fn dechunk_inner(raw: &[u8], cap: usize) -> Result<(Vec<u8>, bool), &'static str> {
    let mut out = Vec::new();
    let mut i = 0;
    loop {
        let Some(nl) = raw[i..].windows(2).position(|w| w == b"\r\n") else {
            return Ok((out, false));
        };
        let line = &raw[i..i + nl];
        let size_hex = line.split(|&b| b == b';').next().unwrap_or(b"");
        let size_hex = std::str::from_utf8(size_hex)
            .map_err(|_| "bad chunk size")?
            .trim_matches([' ', '\t']);
        if size_hex.is_empty() || !size_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("bad chunk size");
        }
        let size = usize::from_str_radix(size_hex, 16).map_err(|_| "bad chunk size")?;
        i += nl + 2;
        if size == 0 {
            return Ok((out, true));
        }
        let avail = raw.len() - i;
        let take = size.min(avail).min(cap - out.len());
        out.extend_from_slice(&raw[i..i + take]);
        if out.len() >= cap {
            return Ok((out, true));
        }
        if avail < size + 2 {
            return Ok((out, false));
        }
        if &raw[i + size..i + size + 2] != b"\r\n" {
            return Err("bad chunk framing");
        }
        i += size + 2;
    }
}

// ---------------------------------------------------------------------------
// Byte plumbing
// ---------------------------------------------------------------------------

/// Bidirectional copy; `rate_bps > 0` throttles each direction separately
/// (burst = one second of traffic, same as the in-guest proxy). Closed when
/// neither direction moved a byte for `idle` (M3).
async fn splice<A, B>(a: A, b: B, rate_bps: u64, idle: Duration) -> Result<()>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let start = Instant::now();
    let last = std::sync::atomic::AtomicU64::new(0);
    let (ar, aw) = tokio::io::split(a);
    let (br, bw) = tokio::io::split(b);
    let copies = async {
        tokio::join!(
            throttled_copy(ar, bw, rate_bps, start, &last),
            throttled_copy(br, aw, rate_bps, start, &last)
        )
    };
    let watchdog = async {
        loop {
            tokio::time::sleep(idle / 4).await;
            let quiet = start.elapsed().as_millis() as u64
                - last.load(std::sync::atomic::Ordering::Relaxed);
            if quiet >= idle.as_millis() as u64 {
                return;
            }
        }
    };
    tokio::select! {
        _ = copies => {}
        () = watchdog => tracing::debug!("egress broker: idle connection closed"),
    }
    Ok(())
}

/// One direction of `splice`; `rate_bps == 0` = unthrottled. Stamps `last`
/// (ms since `start`) on every chunk for the idle watchdog.
async fn throttled_copy<R, W>(
    mut r: R,
    mut w: W,
    rate_bps: u64,
    start: Instant,
    last: &std::sync::atomic::AtomicU64,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let burst = rate_bps as f64;
    let mut tokens = burst;
    let mut last_refill = Instant::now();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            return w.shutdown().await;
        }
        last.store(
            start.elapsed().as_millis() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
        if rate_bps == 0 {
            w.write_all(&buf[..n]).await?;
            continue;
        }
        let now = Instant::now();
        tokens = (tokens + now.duration_since(last_refill).as_secs_f64() * burst).min(burst);
        last_refill = now;
        if tokens < n as f64 {
            tokio::time::sleep(Duration::from_secs_f64((n as f64 - tokens) / burst)).await;
            tokens = 0.0;
            last_refill = Instant::now();
        } else {
            tokens -= n as f64;
        }
        w.write_all(&buf[..n]).await?;
    }
}

/// L3: in production, broker mode must resolve credentials through the
/// control-plane relay (tenant-bound, audited) — never the dev
/// `EnvSecretResolver` fallback.
pub fn check_broker_resolver(
    mode: EgressMode,
    lantern_env: Option<&str>,
    relay_configured: bool,
) -> Result<()> {
    let prod = lantern_env.is_some_and(|e| matches!(e.trim(), "prod" | "production" | "staging"));
    if mode == EgressMode::Broker && prod && !relay_configured {
        bail!(
            "LANTERN_EGRESS_MODE=broker in production requires the control-plane secret relay \
             (LANTERN_CONTROL_PLANE_URL + LANTERN_RUNTIME_SECRET_TOKEN); refusing to fall back \
             to the env resolver"
        );
    }
    Ok(())
}

/// Bind the host side of a guest-initiated vsock port (`<uds>_<port>`).
/// `owner` = the jailer uid/gid: a jailed firecracker must be able to
/// connect, and connecting to a Unix socket needs write permission on it.
pub fn bind_vsock_listener(path: &Path, owner: Option<(u32, u32)>) -> Result<UnixListener> {
    let _ = std::fs::remove_file(path);
    let listener =
        UnixListener::bind(path).with_context(|| format!("bind vsock listener {path:?}"))?;
    if let Some((uid, gid)) = owner {
        std::os::unix::fs::chown(path, Some(uid), Some(gid))
            .with_context(|| format!("chown vsock listener {path:?}"))?;
    }
    Ok(listener)
}

/// Relay guest control-channel connections to the manager's own gRPC
/// listener. A dumb byte pipe: the harness's mTLS session runs through it.
pub async fn relay_to_tcp(listener: UnixListener, target: SocketAddr, max_conns: usize) {
    // M3: the guest controls how many connections it opens; bound them.
    let slots = Arc::new(tokio::sync::Semaphore::new(max_conns));
    loop {
        match listener.accept().await {
            Ok((mut conn, _)) => {
                let Ok(permit) = Arc::clone(&slots).try_acquire_owned() else {
                    tracing::warn!(%target, "vsock control relay: per-VM connection limit reached");
                    drop(conn);
                    continue;
                };
                tokio::spawn(async move {
                    let _permit = permit;
                    match tokio::time::timeout(HANDSHAKE_TIMEOUT, TcpStream::connect(target))
                        .await
                        .unwrap_or_else(|_| Err(std::io::ErrorKind::TimedOut.into()))
                    {
                        Ok(mut up) => {
                            let _ = tokio::io::copy_bidirectional(&mut conn, &mut up).await;
                        }
                        Err(e) => {
                            tracing::warn!(%target, error = %e, "vsock control relay: manager connect failed")
                        }
                    }
                });
            }
            Err(e) => {
                tracing::warn!(error = %e, "vsock control relay: accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The REAL guest-side forwarder, compiled from the harness source, so the
/// end-to-end test below drives both halves of the vsock bridge.
#[cfg(test)]
#[path = "../../harness/src/egress_forwarder.rs"]
mod harness_forwarder;

#[cfg(test)]
mod e2e {
    use super::tests::{SECRET, broker, capture, inject_rule, mitm_ca, rule};
    use super::*;
    use tokio::net::{TcpListener, UnixStream};

    /// A test CA + a TLS server for `host` on loopback that records the
    /// request head it receives and answers `hello`.
    async fn tls_upstream(
        host: &'static str,
    ) -> (
        SocketAddr,
        rustls::pki_types::CertificateDer<'static>,
        tokio::task::JoinHandle<Head>,
    ) {
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let leaf = rcgen::CertificateParams::new(vec![host.to_string()])
            .unwrap()
            .signed_by(&leaf_key, &ca, &ca_key)
            .unwrap();
        let cfg = rustls::ServerConfig::builder_with_provider(ring_provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der())),
            )
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let tls = tokio_rustls::TlsAcceptor::from(Arc::new(cfg))
                .accept(tcp)
                .await
                .unwrap();
            let mut r = BufReader::new(tls);
            let head = read_head(&mut r).await.unwrap().unwrap();
            let s = r.get_mut();
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
                .await
                .unwrap();
            let _ = s.shutdown().await;
            head
        });
        (addr, ca.der().clone(), task)
    }

    fn roots_of(ca: &rustls::pki_types::CertificateDer<'static>) -> rustls::RootCertStore {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca.clone()).unwrap();
        roots
    }

    /// Workload side: CONNECT through the guest forwarder, then HTTPS to
    /// `host` trusting only `trust`. Returns the plaintext response.
    async fn workload_get(
        forwarder: SocketAddr,
        host: &str,
        trust: rustls::pki_types::CertificateDer<'static>,
    ) -> String {
        let mut tcp = tokio::net::TcpStream::connect(forwarder).await.unwrap();
        tcp.write_all(
            format!("CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n").as_bytes(),
        )
        .await
        .unwrap();
        let mut resp = Vec::new();
        while !resp.ends_with(b"\r\n\r\n") {
            let mut b = [0u8; 1];
            assert_eq!(tcp.read(&mut b).await.unwrap(), 1, "proxy closed early");
            resp.push(b[0]);
        }
        assert!(
            resp.starts_with(b"HTTP/1.1 200"),
            "{}",
            String::from_utf8_lossy(&resp)
        );
        let mut roots = rustls::RootCertStore::empty();
        roots.add(trust).unwrap();
        let cfg = rustls::ClientConfig::builder_with_provider(ring_provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let mut tls = tokio_rustls::TlsConnector::from(Arc::new(cfg))
            .connect(ServerName::try_from(host.to_string()).unwrap(), tcp)
            .await
            .unwrap();
        tls.write_all(
            format!("GET /v1/models HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer placeholder\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
        let mut out = Vec::new();
        let _ = tls.read_to_end(&mut out).await;
        String::from_utf8_lossy(&out).to_string()
    }

    /// Host side of "vsock" (a Unix socket, as Firecracker presents it) served
    /// by the broker, plus the guest forwarder dialling it. Returns the
    /// forwarder's address (what the workload's HTTPS_PROXY points at).
    async fn bridge(b: Broker, dir: &Path) -> SocketAddr {
        let uds = dir.join("vm.sock_3128");
        let listener = bind_vsock_listener(&uds, None).unwrap();
        tokio::spawn(Arc::new(b).serve(listener));
        let fwd = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = fwd.local_addr().unwrap();
        tokio::spawn(harness_forwarder::run(fwd, move || {
            UnixStream::connect(uds.clone())
        }));
        addr
    }

    /// CONNECT + TLS (trusting `trust`) through `b`, then send `inner` raw;
    /// returns whatever plaintext came back.
    async fn tunnel_request(
        b: &Broker,
        host: &str,
        trust: rustls::pki_types::CertificateDer<'static>,
        inner: &str,
    ) -> String {
        let (mut guest, hostside) = tokio::io::duplex(64 * 1024);
        let host = host.to_string();
        let inner = inner.to_string();
        let client = async move {
            guest
                .write_all(format!("CONNECT {host}:443 HTTP/1.1\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let mut resp = Vec::new();
            while !resp.ends_with(b"\r\n\r\n") {
                let mut c = [0u8; 1];
                if guest.read(&mut c).await.unwrap_or(0) == 0 {
                    return String::from_utf8_lossy(&resp).to_string();
                }
                resp.push(c[0]);
            }
            let mut roots = rustls::RootCertStore::empty();
            roots.add(trust).unwrap();
            let cfg = rustls::ClientConfig::builder_with_provider(ring_provider())
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth();
            let mut tls = tokio_rustls::TlsConnector::from(Arc::new(cfg))
                .connect(ServerName::try_from(host).unwrap(), guest)
                .await
                .unwrap();
            tls.write_all(inner.as_bytes()).await.unwrap();
            let mut out = Vec::new();
            let _ = tls.read_to_end(&mut out).await;
            String::from_utf8_lossy(&out).to_string()
        };
        let (_, out) = tokio::join!(b.serve_conn(hostside), client);
        out
    }

    /// M1 + L1 on the terminate path: each request is refused with 403
    /// BEFORE the secret is resolved and before anything is dialled.
    #[tokio::test]
    async fn m1_l1_terminate_path_refuses_unbound_requests_before_resolving() {
        let up = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = up.local_addr().unwrap();
        let rec = Arc::new(super::tests::ScopeRecorder(std::sync::Mutex::new(
            Vec::new(),
        )));
        let (tx, _rx) = mpsc::channel(64);
        let deps = BrokerDeps {
            resolver: rec.clone(),
            audit: tx,
            upstream_roots: Arc::new(rustls::RootCertStore::empty()),
        };
        let rules = vec![inject_rule("api.openai.com")];
        let mitm = MitmCa::for_rules("vm", &rules).unwrap().map(Arc::new);
        let mut b = Broker::new("vm", "t", Policy::new(rules, vec![443]), mitm, &deps).unwrap();
        b.test_upstream = Some(addr);
        let trust = mitm_ca(&b);
        for inner in [
            "GET https://evil.com/ HTTP/1.1\r\nHost: api.openai.com\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: evil.com\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: api.openai.com\r\nHost: evil.com\r\n\r\n",
            "GET / HTTP/1.1\r\n\r\n",
            "GET http://api.openai.com/ HTTP/1.1\r\nHost: api.openai.com\r\n\r\n",
            "TRACE / HTTP/1.1\r\nHost: api.openai.com\r\n\r\n",
            "CONNECT evil.com:443 HTTP/1.1\r\nHost: api.openai.com\r\n\r\n",
        ] {
            let out = tunnel_request(&b, "api.openai.com", trust.clone(), inner).await;
            assert!(out.starts_with("HTTP/1.1 403"), "{inner:?} -> {out}");
        }
        assert!(
            rec.0.lock().unwrap().is_empty(),
            "secret resolved for a refused request"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), up.accept())
                .await
                .is_err(),
            "upstream dialled for a refused request"
        );
    }

    #[tokio::test]
    async fn injected_header_reaches_upstream_and_guest_never_sees_it() {
        let logs = capture::Capture::default();
        let _guard = tracing::subscriber::set_default(logs.subscriber());
        let (up, up_ca, upstream) = tls_upstream("api.openai.com").await;
        let roots = roots_of(&up_ca);
        let (b, mut audit) = broker(
            vec![inject_rule("api.openai.com")],
            vec![443],
            roots,
            Some(up),
        );
        let guest_trust = mitm_ca(&b);
        let dir = tempfile::tempdir().unwrap();
        let fwd = bridge(b, dir.path()).await;

        let plaintext = workload_get(fwd, "api.openai.com", guest_trust).await;

        assert!(plaintext.ends_with("hello"), "{plaintext}");
        assert!(!plaintext.contains(SECRET), "secret reached the guest");
        let head = upstream.await.unwrap();
        let auth: Vec<&String> = head
            .headers
            .iter()
            .filter(|h| header_name(h).eq_ignore_ascii_case("authorization"))
            .collect();
        assert_eq!(auth, vec![&format!("Authorization: Bearer {SECRET}\r\n")]);

        let mut events = Vec::new();
        while let Ok(ev) = audit.try_recv() {
            events.push(ev);
        }
        assert!(
            events.iter().any(|e| e.action == "egress"
                && e.attrs.get("tls").map(String::as_str) == Some("terminate"))
        );
        assert!(events.iter().any(|e| e.action == "egress_inject"
            && e.attrs.get("headers").map(String::as_str) == Some("Authorization")));
        assert!(events.iter().all(|e| !format!("{e:?}").contains(SECRET)));
        assert!(!logs.text().contains(SECRET), "secret leaked into logs");
    }

    /// #13: DLP on the TLS-terminated (injecting) path — a card in the
    /// decrypted body is refused before anything is dialled; a chunked body
    /// with the card split across chunks is refused too.
    #[tokio::test]
    async fn dlp_blocks_on_the_terminate_path() {
        let up = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut b, mut audit) = broker(
            vec![inject_rule("api.openai.com")],
            vec![443],
            rustls::RootCertStore::empty(),
            Some(up.local_addr().unwrap()),
        );
        b.dlp = Some(super::tests::dlp_engine_block_card());
        let trust = mitm_ca(&b);
        for inner in [
            "POST /v1 HTTP/1.1\r\nHost: api.openai.com\r\nContent-Length: 21\r\n\r\ncard 4532015112830366",
            "POST /v1 HTTP/1.1\r\nHost: api.openai.com\r\nTransfer-Encoding: chunked\r\n\r\n\
             8\r\ncard 453\r\n6\r\n201511\r\n7\r\n2830366\r\n0\r\n\r\n",
        ] {
            let out = tunnel_request(&b, "api.openai.com", trust.clone(), inner).await;
            assert!(
                out.starts_with("HTTP/1.1 403") && out.contains("dlp-block"),
                "{inner:?} -> {out}"
            );
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), up.accept())
                .await
                .is_err(),
            "upstream dialled for a DLP-blocked request"
        );
        let mut blocks = 0;
        while let Ok(ev) = audit.try_recv() {
            if ev.action == "dlp" {
                assert_eq!(ev.attrs["decision"], "block");
                blocks += 1;
            }
            assert!(!format!("{ev:?}").contains("4532015112830366"));
        }
        assert_eq!(blocks, 2);
    }

    #[tokio::test]
    async fn host_without_injection_is_tunnelled_not_terminated() {
        let (up, up_ca, upstream) = tls_upstream("api.github.com").await;
        let (b, mut audit) = broker(
            vec![rule("api.github.com")],
            vec![443],
            roots_of(&up_ca),
            Some(up),
        );
        assert!(b.mitm.is_none(), "no injection rule → no CA at all");
        let dir = tempfile::tempdir().unwrap();
        let fwd = bridge(b, dir.path()).await;

        // The workload trusts ONLY the upstream's own CA: success proves the
        // TLS session is end-to-end with the upstream, never the broker.
        let plaintext = workload_get(fwd, "api.github.com", up_ca).await;
        assert!(plaintext.ends_with("hello"), "{plaintext}");
        let head = upstream.await.unwrap();
        assert!(
            head.headers
                .iter()
                .any(|h| h.contains("Bearer placeholder")),
            "passthrough must not touch the workload's headers"
        );
        let ev = audit.try_recv().unwrap();
        assert_eq!(ev.attrs["tls"], "passthrough");
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::secret_resolver::HashMapSecretResolver;

    fn head(headers: &[&str]) -> Head {
        Head {
            line: "POST /post HTTP/1.1\r\n".into(),
            headers: headers.iter().map(|h| format!("{h}\r\n")).collect(),
        }
    }

    const T: Duration = Duration::from_millis(300);

    async fn body(r: &mut tokio::io::DuplexStream, f: Framing, cap: usize) -> BodyPrefix {
        read_body_prefix(r, f, cap, T).await.unwrap().unwrap()
    }

    // Regression: the client keeps the connection open awaiting our response,
    // so the DLP body read must stop at the declared length, never wait for EOF.
    #[tokio::test]
    async fn dlp_body_read_does_not_wait_for_eof() {
        let (mut client, mut server) = tokio::io::duplex(1 << 16);
        client
            .write_all(b"card 4532015112830366 tail")
            .await
            .unwrap(); // stays open
        let got = tokio::time::timeout(
            Duration::from_millis(200),
            body(&mut server, Framing::Length(21), 65536),
        )
        .await
        .expect("stalled waiting for EOF");
        assert_eq!(got.raw, b"card 4532015112830366");
        assert!(got.complete);
        // No length, not chunked (a GET): no body, no read.
        let got = body(&mut server, Framing::None, 65536).await;
        assert!(got.raw.is_empty() && got.complete);
        // Cap respected.
        let got = body(&mut server, Framing::Length(100), 3).await;
        assert_eq!(got.raw, b" ta");
        assert!(got.complete);
    }

    /// #3: ambiguous framing is refused (request smuggling).
    #[test]
    fn body_framing_refuses_ambiguity() {
        assert_eq!(body_framing(&head(&["Host: x"])), Ok(Framing::None));
        assert_eq!(
            body_framing(&head(&["Content-Length: 5", "content-length: 5"])),
            Ok(Framing::Length(5))
        );
        assert_eq!(
            body_framing(&head(&["Transfer-Encoding: gzip, chunked"])),
            Ok(Framing::Chunked)
        );
        for bad in [
            &["Content-Length: 5", "Transfer-Encoding: chunked"][..],
            &["Transfer-Encoding: chunked", "Content-Length: 0"],
            &["Content-Length: 5", "Content-Length: 6"],
            &["Content-Length: 5, 6"],
            &["Content-Length: +5"],
            &["Content-Length: "],
            &["Transfer-Encoding: chunked, gzip"],
            &["Transfer-Encoding: identity"],
        ] {
            assert!(body_framing(&head(bad)).is_err(), "{bad:?} accepted");
        }
    }

    /// #4b: chunk framing cannot split a value the detectors look for.
    #[test]
    fn dechunk_reassembles_split_values() {
        let raw = b"4\r\n4532\r\n6;ext=1\r\n015112\r\n6\r\n830366\r\n0\r\n\r\n";
        assert_eq!(dechunk(raw, 1024), Ok(Some(b"4532015112830366".to_vec())));
        assert_eq!(dechunk(b"4\r\n45", 1024), Ok(None));
        assert_eq!(dechunk(b"4\r\n4532\r\n", 1024), Ok(None));
        // Cap reached mid-chunk counts as done.
        assert_eq!(dechunk(b"10\r\n0123456789", 4), Ok(Some(b"0123".to_vec())));
        for bad in [&b"zz\r\n"[..], b"\r\n", b"4\r\n4532XX", b"-1\r\n"] {
            assert!(
                dechunk(bad, 1024).is_err(),
                "{:?}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    /// #4a: a chunked body that goes quiet before its terminal chunk is NOT
    /// complete (block mode refuses it); the whole read is bounded by the
    /// timeout, not 1 s of quiet followed by an uninspected splice.
    #[tokio::test]
    async fn chunked_body_quiet_before_terminal_chunk_is_incomplete() {
        let (mut client, mut server) = tokio::io::duplex(1 << 16);
        client.write_all(b"4\r\nabcd\r\n").await.unwrap(); // then silence
        let got = body(&mut server, Framing::Chunked, 65536).await;
        assert!(!got.complete);
        assert_eq!(got.scan, b"abcd");
        assert_eq!(got.raw, b"4\r\nabcd\r\n");

        let (mut client, mut server) = tokio::io::duplex(1 << 16);
        client.write_all(b"4\r\nabcd\r\n0\r\n\r\n").await.unwrap();
        let got = body(&mut server, Framing::Chunked, 65536).await;
        assert!(got.complete);
        assert_eq!(got.scan, b"abcd");

        // A Content-Length body cut short by silence is incomplete too.
        let (mut client, mut server) = tokio::io::duplex(1 << 16);
        client.write_all(b"abc").await.unwrap();
        let got = body(&mut server, Framing::Length(10), 65536).await;
        assert!(!got.complete);
        assert_eq!(got.raw, b"abc");

        // Framing padding past the raw budget: incomplete, not unbounded.
        let (mut client, mut server) = tokio::io::duplex(1 << 20);
        let pad = format!("1;{}\r\nx\r\n", "e".repeat(1000)).repeat(100);
        client.write_all(pad.as_bytes()).await.unwrap();
        let got = body(&mut server, Framing::Chunked, 64).await;
        assert!(!got.complete);
        assert!(got.raw.len() <= 2 * 64 + 16 * 1024);
    }

    pub(crate) const SECRET: &str = "sk-live-TOPSECRET-0123456789";
    pub(crate) const SECRET_URI: &str = "lantern.secret://tenant/t1/key/OPENAI";

    pub(crate) fn rule(pattern: &str) -> EgressRule {
        EgressRule {
            pattern: pattern.to_string(),
            ..Default::default()
        }
    }

    pub(crate) fn inject_rule(pattern: &str) -> EgressRule {
        EgressRule {
            inject: vec![CredentialInjection {
                header: "Authorization".into(),
                secret_uri: SECRET_URI.into(),
                value_prefix: "Bearer ".into(),
            }],
            ..rule(pattern)
        }
    }

    pub(crate) fn deps(
        roots: rustls::RootCertStore,
    ) -> (BrokerDeps, mpsc::Receiver<pb::AuditEvent>) {
        let (tx, rx) = mpsc::channel(64);
        let resolver = HashMapSecretResolver::new(HashMap::from([(
            SECRET_URI.to_string(),
            SECRET.to_string(),
        )]));
        (
            BrokerDeps {
                resolver: Arc::new(resolver),
                audit: tx,
                upstream_roots: Arc::new(roots),
            },
            rx,
        )
    }

    pub(crate) fn broker(
        rules: Vec<EgressRule>,
        ports: Vec<u16>,
        roots: rustls::RootCertStore,
        upstream: Option<SocketAddr>,
    ) -> (Broker, mpsc::Receiver<pb::AuditEvent>) {
        let (d, rx) = deps(roots);
        let mitm = MitmCa::for_rules("vm-test", &rules).unwrap().map(Arc::new);
        let mut b = Broker::new("vm-test", "t1", Policy::new(rules, ports), mitm, &d).unwrap();
        b.test_upstream = upstream;
        (b, rx)
    }

    pub(crate) fn mitm_ca(b: &Broker) -> rustls::pki_types::CertificateDer<'static> {
        b.mitm.as_ref().unwrap().ca_der()
    }

    // ---- parity with the in-guest matcher -------------------------------

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../testdata/egress_match_cases.json")).unwrap()
    }

    #[test]
    fn parity_pattern_cases() {
        for c in fixture()["pattern_cases"].as_array().unwrap() {
            let (p, h) = (c["pattern"].as_str().unwrap(), c["host"].as_str().unwrap());
            assert_eq!(
                pattern_matches(p, h),
                c["match"].as_bool().unwrap(),
                "{p} vs {h}"
            );
        }
    }

    #[test]
    fn parity_private_ip_cases() {
        for c in fixture()["private_ip_cases"].as_array().unwrap() {
            let ip: IpAddr = c["ip"].as_str().unwrap().parse().unwrap();
            assert_eq!(
                is_private_or_metadata(ip),
                c["private"].as_bool().unwrap(),
                "{ip}"
            );
        }
    }

    #[test]
    fn parity_host_port_cases() {
        for c in fixture()["host_port_cases"].as_array().unwrap() {
            let got = parse_host_port(c["target"].as_str().unwrap());
            let want = c["host"]
                .as_str()
                .map(|h| (h.to_string(), c["port"].as_u64().unwrap() as u16));
            assert_eq!(got, want, "{}", c["target"]);
        }
    }

    #[test]
    fn parity_evaluate_cases() {
        for c in fixture()["evaluate_cases"].as_array().unwrap() {
            let rules = c["rules"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| rule(p.as_str().unwrap()))
                .collect();
            let policy = Policy::new(rules, vec![443]);
            let got = policy.evaluate(
                c["host"].as_str().unwrap(),
                c["port"].as_u64().unwrap() as u16,
            );
            if c["allow"].as_bool().unwrap() {
                assert!(got.is_ok(), "{c}");
            } else {
                assert_eq!(got.err(), c["reason"].as_str(), "{c}");
            }
        }
    }

    // ---- decisions --------------------------------------------------------

    #[test]
    fn method_filter() {
        let mut r = rule("api.x.com");
        assert!(method_allowed(&r, "DELETE"));
        r.http_methods = vec!["post".into()];
        assert!(method_allowed(&r, "POST"));
        assert!(!method_allowed(&r, "GET"));
    }

    #[test]
    fn tls_terminated_only_for_injecting_rules() {
        assert!(!terminates_tls(&rule("api.github.com")));
        assert!(terminates_tls(&inject_rule("api.openai.com")));
    }

    #[test]
    fn mode_parse() {
        assert_eq!(EgressMode::parse(None), EgressMode::Guest);
        assert_eq!(EgressMode::parse(Some("guest")), EgressMode::Guest);
        assert_eq!(EgressMode::parse(Some(" Broker ")), EgressMode::Broker);
        assert_eq!(EgressMode::parse(Some("brokr")), EgressMode::Guest);
        assert_eq!(EgressMode::Broker.contract_value(), "broker");
        assert_eq!(EgressMode::Guest.contract_value(), "");
    }

    #[test]
    fn ca_only_when_a_rule_injects() {
        assert!(
            MitmCa::for_rules("vm", &[rule("api.github.com")])
                .unwrap()
                .is_none()
        );
        let ca = MitmCa::for_rules("vm", &[rule("a.com"), inject_rule("api.openai.com")])
            .unwrap()
            .unwrap();
        assert!(ca.ca_pem().starts_with("-----BEGIN CERTIFICATE-----"));
    }

    #[test]
    fn ca_refuses_injection_on_ip_wildcard_or_bad_header() {
        assert!(MitmCa::for_rules("vm", &[inject_rule("8.8.8.8")]).is_err());
        // M2: exact hostnames only — a wildcard would cover attacker subdomains.
        assert!(MitmCa::for_rules("vm", &[inject_rule("*.openai.com")]).is_err());
        assert!(MitmCa::for_rules("vm", &[inject_rule("*")]).is_err());
        let mut bad = inject_rule("api.x.com");
        bad.inject[0].header = "X-Bad\r\nEvil".into();
        assert!(MitmCa::for_rules("vm", &[bad]).is_err());
    }

    #[test]
    fn rewrite_replaces_placeholder_and_forces_close() {
        let head = Head {
            line: "POST /v1/chat HTTP/1.1\r\n".into(),
            headers: vec![
                "Host: api.openai.com\r\n".into(),
                "authorization: Bearer PLACEHOLDER\r\n".into(),
                "Connection: keep-alive\r\n".into(),
                "Proxy-Authorization: x\r\n".into(),
                "Content-Length: 2\r\n".into(),
            ],
        };
        let out = String::from_utf8(rewrite_head(
            &head,
            &[("Authorization".into(), "Bearer real".into())],
            false,
        ))
        .unwrap();
        assert!(!out.contains("PLACEHOLDER"));
        assert!(!out.contains("keep-alive"));
        assert!(!out.contains("Proxy-Authorization"));
        assert!(out.contains("Authorization: Bearer real\r\n"));
        assert!(out.contains("Content-Length: 2\r\n"));
        assert!(out.ends_with("Connection: close\r\n\r\n"));
        assert!(out.starts_with("POST /v1/chat HTTP/1.1\r\n"));
    }

    #[tokio::test]
    async fn oversized_head_is_rejected() {
        let big = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(70 * 1024));
        let mut r = BufReader::new(big.as_bytes());
        assert!(read_head(&mut r).await.is_err());
    }

    async fn roundtrip(b: &Broker, request: &str) -> String {
        let (mut guest, host) = tokio::io::duplex(64 * 1024);
        let serve = b.serve_conn(host);
        let client = async move {
            guest.write_all(request.as_bytes()).await.unwrap();
            // Half-close so a spliced connection can finish both directions.
            guest.shutdown().await.unwrap();
            let mut out = Vec::new();
            let _ = guest.read_to_end(&mut out).await;
            String::from_utf8_lossy(&out).to_string()
        };
        let (_, out) = tokio::join!(serve, client);
        out
    }

    #[tokio::test]
    async fn connect_to_unlisted_host_is_denied_and_audited() {
        let (b, mut rx) = broker(
            vec![rule("api.github.com")],
            vec![443],
            rustls::RootCertStore::empty(),
            None,
        );
        let out = roundtrip(&b, "CONNECT evil.com:443 HTTP/1.1\r\n\r\n").await;
        assert!(out.starts_with("HTTP/1.1 403"), "{out}");
        assert!(out.contains("no matching allowlist rule"));
        let ev = rx.try_recv().unwrap();
        assert_eq!(ev.action, "egress");
        assert_eq!(ev.attrs["decision"], "deny");
        assert_eq!(ev.attrs["host"], "evil.com");
    }

    #[tokio::test]
    async fn connect_to_metadata_ip_is_denied() {
        let (b, _rx) = broker(
            vec![rule("*.x.com")],
            vec![443],
            rustls::RootCertStore::empty(),
            None,
        );
        let out = roundtrip(&b, "CONNECT 169.254.169.254:443 HTTP/1.1\r\n\r\n").await;
        assert!(out.contains("private/metadata"), "{out}");
    }

    #[tokio::test]
    async fn plain_http_wrong_method_denied() {
        let mut r = rule("api.x.com");
        r.http_methods = vec!["GET".into()];
        let (b, _rx) = broker(vec![r], vec![80], rustls::RootCertStore::empty(), None);
        let out = roundtrip(
            &b,
            "DELETE http://api.x.com/thing HTTP/1.1\r\nHost: api.x.com\r\n\r\n",
        )
        .await;
        assert!(out.contains("method-not-allowed"), "{out}");
    }

    #[tokio::test]
    async fn unresolvable_secret_fails_closed_without_upstream_call() {
        let mut r = inject_rule("api.x.com");
        r.inject[0].secret_uri = "lantern.secret://tenant/t1/key/MISSING".into();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (mut b, mut rx) = broker(
            vec![r],
            vec![80],
            rustls::RootCertStore::empty(),
            Some(addr),
        );
        b.plain_inject = true;
        let out = roundtrip(
            &b,
            "GET http://api.x.com/ HTTP/1.1\r\nHost: api.x.com\r\n\r\n",
        )
        .await;
        assert!(out.starts_with("HTTP/1.1 502"), "{out}");
        assert!(out.contains("credential resolution failed"));
        let ev = rx.try_recv().unwrap();
        assert_eq!(ev.action, "egress_inject");
        assert_eq!(ev.attrs["decision"], "deny");
        // Nothing reached the upstream.
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }

    /// Plain-HTTP injection: header set upstream, secret absent from every
    /// audit event and from all tracing output.
    #[tokio::test]
    async fn plain_http_injects_and_never_logs_secret() {
        let logs = capture::Capture::default();
        let _guard = tracing::subscriber::set_default(logs.subscriber());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let mut r = BufReader::new(s);
            let head = read_head(&mut r).await.unwrap().unwrap();
            r.get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await
                .unwrap();
            head
        });
        let (mut b, mut rx) = broker(
            vec![inject_rule("api.x.com")],
            vec![80],
            rustls::RootCertStore::empty(),
            Some(addr),
        );
        b.plain_inject = true;
        let out = roundtrip(
            &b,
            "GET http://api.x.com/v1 HTTP/1.1\r\nHost: api.x.com\r\nAuthorization: Bearer placeholder\r\n\r\n",
        )
        .await;
        assert!(out.ends_with("ok"), "{out}");
        let seen = upstream.await.unwrap();
        let auth: Vec<_> = seen
            .headers
            .iter()
            .filter(|h| header_name(h).eq_ignore_ascii_case("authorization"))
            .collect();
        assert_eq!(auth, vec![&format!("Authorization: Bearer {SECRET}\r\n")]);

        let mut events = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            events.push(format!("{ev:?}"));
        }
        assert!(events.iter().any(|e| e.contains("egress_inject")));
        assert!(events.iter().all(|e| !e.contains(SECRET)), "{events:?}");
        let text = logs.text();
        assert!(text.contains("egress broker audit"), "capture works");
        assert!(!text.contains(SECRET), "secret leaked into logs: {text}");
    }

    /// Records the scope each resolution was made under.
    pub(crate) struct ScopeRecorder(pub(crate) std::sync::Mutex<Vec<(String, String)>>);

    #[async_trait::async_trait]
    impl SecretResolver for ScopeRecorder {
        async fn resolve(
            &self,
            _uri: &str,
            _bearer: Option<&str>,
        ) -> Result<String, crate::secret_resolver::SecretResolverError> {
            Err(crate::secret_resolver::SecretResolverError::Backend {
                detail: "unscoped resolve must not be used by the broker".into(),
            })
        }
        async fn resolve_scoped(
            &self,
            _uri: &str,
            scope: ResolveScope<'_>,
            _bearer: Option<&str>,
        ) -> Result<String, crate::secret_resolver::SecretResolverError> {
            self.0
                .lock()
                .unwrap()
                .push((scope.tenant_id.into(), scope.vm_id.into()));
            Ok(SECRET.into())
        }
    }

    #[tokio::test]
    async fn injection_resolves_scoped_to_the_vms_tenant() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let mut r = BufReader::new(s);
            let _ = read_head(&mut r).await;
            let _ = r
                .get_mut()
                .write_all(b"HTTP/1.1 204 No Content\r\n\r\n")
                .await;
        });
        let rec = Arc::new(ScopeRecorder(std::sync::Mutex::new(Vec::new())));
        let (tx, _rx) = mpsc::channel(8);
        let deps = BrokerDeps {
            resolver: rec.clone(),
            audit: tx,
            upstream_roots: Arc::new(rustls::RootCertStore::empty()),
        };
        let rules = vec![inject_rule("api.x.com")];
        let mut b = Broker::new(
            "vm-7",
            "tenant-owner",
            Policy::new(rules, vec![80]),
            None,
            &deps,
        )
        .unwrap();
        b.test_upstream = Some(addr);
        b.plain_inject = true;
        let out = roundtrip(
            &b,
            "GET http://api.x.com/ HTTP/1.1\r\nHost: api.x.com\r\n\r\n",
        )
        .await;
        assert!(out.starts_with("HTTP/1.1 204"), "{out}");
        assert_eq!(
            *rec.0.lock().unwrap(),
            vec![("tenant-owner".to_string(), "vm-7".to_string())]
        );
    }

    // ---- security review hardening (H1, M1, M3, L1, L3, L5) -----------------

    /// A TCP listener that must never be dialled; returns (addr, listener).
    async fn never_dialled() -> (SocketAddr, tokio::net::TcpListener) {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        (l.local_addr().unwrap(), l)
    }

    async fn assert_not_dialled(l: &tokio::net::TcpListener) {
        assert!(
            tokio::time::timeout(Duration::from_millis(50), l.accept())
                .await
                .is_err(),
            "upstream must not be dialled"
        );
    }

    #[tokio::test]
    async fn h1_plain_http_injection_refused_on_443_and_by_default() {
        let (addr, up) = never_dialled().await;
        for (opt_in, port, ports) in [
            (false, 443, vec![443]),
            (true, 443, vec![443]),
            (false, 80, vec![80]),
        ] {
            let (mut b, mut rx) = broker(
                vec![inject_rule("api.x.com")],
                ports,
                rustls::RootCertStore::empty(),
                Some(addr),
            );
            b.plain_inject = opt_in;
            let out = roundtrip(
                &b,
                &format!("GET http://api.x.com:{port}/ HTTP/1.1\r\nHost: api.x.com:{port}\r\n\r\n"),
            )
            .await;
            assert!(
                out.starts_with("HTTP/1.1 403"),
                "opt_in={opt_in} port={port}: {out}"
            );
            assert!(
                out.contains("plain-HTTP credential injection refused"),
                "{out}"
            );
            let ev = rx.try_recv().unwrap();
            assert_eq!(
                (ev.action.as_str(), ev.attrs["decision"].as_str()),
                ("egress_inject", "deny")
            );
        }
        assert_not_dialled(&up).await;
    }

    #[tokio::test]
    async fn m1_plain_path_host_binding_and_forms() {
        let (addr, up) = never_dialled().await;
        let (b, _rx) = broker(
            vec![rule("api.x.com")],
            vec![80],
            rustls::RootCertStore::empty(),
            Some(addr),
        );
        for (req, want) in [
            // Host header names a different vhost than the approved authority.
            (
                "GET http://api.x.com/ HTTP/1.1\r\nHost: evil.com\r\n\r\n",
                "403",
            ),
            // Duplicate Host headers.
            (
                "GET / HTTP/1.1\r\nHost: api.x.com\r\nHost: evil.com\r\n\r\n",
                "400",
            ),
            // https:// absolute-form is not a plain-HTTP request.
            (
                "GET https://api.x.com/ HTTP/1.1\r\nHost: api.x.com\r\n\r\n",
                "400",
            ),
            // Uppercase scheme: parsed as the authority, not a Host fall-back.
            (
                "GET HTTP://evil.com/ HTTP/1.1\r\nHost: api.x.com\r\n\r\n",
                "403",
            ),
        ] {
            let out = roundtrip(&b, req).await;
            assert!(
                out.starts_with(&format!("HTTP/1.1 {want}")),
                "{req:?} -> {out}"
            );
        }
        assert_not_dialled(&up).await;
    }

    #[test]
    fn m1_bound_to_host_cases() {
        let head = |line: &str, hosts: &[&str]| Head {
            line: format!("{line}\r\n"),
            headers: hosts.iter().map(|h| format!("Host: {h}\r\n")).collect(),
        };
        let ok = |h: &Head| bound_to_host(h, "api.x.com", "https", 443, true).is_ok();
        assert!(ok(&head("GET /v1 HTTP/1.1", &["api.x.com"])));
        assert!(ok(&head("GET /v1 HTTP/1.1", &["API.X.COM:443"])));
        assert!(ok(&head(
            "GET https://api.x.com/v1 HTTP/1.1",
            &["api.x.com"]
        )));
        assert!(ok(&head(
            "GET HTTPS://api.x.com:443/v1 HTTP/1.1",
            &["api.x.com"]
        )));
        assert!(!ok(&head("GET https://evil.com/ HTTP/1.1", &["api.x.com"])));
        assert!(!ok(&head("GET http://api.x.com/ HTTP/1.1", &["api.x.com"])));
        assert!(!ok(&head("GET /v1 HTTP/1.1", &["evil.com"])));
        assert!(!ok(&head("GET /v1 HTTP/1.1", &["api.x.com:8443"])));
        assert!(!ok(&head("GET /v1 HTTP/1.1", &["api.x.com", "api.x.com"])));
        assert!(!ok(&head("GET /v1 HTTP/1.1", &[])));
        assert!(!ok(&head("OPTIONS * HTTP/1.1", &["api.x.com"])));
        assert!(!ok(&head("GET api.x.com:443 HTTP/1.1", &["api.x.com"])));
    }

    #[tokio::test]
    async fn l3_prod_broker_requires_relay() {
        assert!(check_broker_resolver(EgressMode::Broker, Some("production"), false).is_err());
        assert!(check_broker_resolver(EgressMode::Broker, Some("staging"), false).is_err());
        assert!(check_broker_resolver(EgressMode::Broker, Some("prod"), true).is_ok());
        assert!(check_broker_resolver(EgressMode::Broker, None, false).is_ok());
        assert!(check_broker_resolver(EgressMode::Guest, Some("prod"), false).is_ok());
    }

    #[tokio::test]
    async fn l5_deny_audits_are_rate_limited_per_vm() {
        let (tx, mut rx) = mpsc::channel(1024);
        let resolver = HashMapSecretResolver::new(HashMap::new());
        let d = BrokerDeps {
            resolver: Arc::new(resolver),
            audit: tx,
            upstream_roots: Arc::new(rustls::RootCertStore::empty()),
        };
        let b = Broker::new("vm-noisy", "t", Policy::new(vec![], vec![443]), None, &d).unwrap();
        for _ in 0..200 {
            b.audit_decision("evil.com", 443, Err("no rules configured"), "connect");
        }
        b.audit_decision("ok.com", 443, Ok(()), "passthrough");
        let mut denies = 0;
        let mut allows = 0;
        while let Ok(ev) = rx.try_recv() {
            match ev.attrs["decision"].as_str() {
                "deny" => denies += 1,
                _ => allows += 1,
            }
        }
        assert!((20..=22).contains(&denies), "denies forwarded: {denies}");
        assert_eq!(allows, 1, "allows are never rate-limited");
    }

    #[tokio::test]
    async fn m3_silent_guest_is_dropped_after_handshake_timeout() {
        let (mut b, _rx) = broker(
            vec![rule("api.x.com")],
            vec![443],
            rustls::RootCertStore::empty(),
            None,
        );
        b.handshake_timeout = Duration::from_millis(100);
        let (_guest, host) = tokio::io::duplex(1024);
        let started = Instant::now();
        tokio::time::timeout(Duration::from_secs(2), b.serve_conn(host))
            .await
            .expect("serve_conn must give up on a silent guest")
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn m3_splice_closes_idle_connection() {
        let (a, _a_peer) = tokio::io::duplex(1024);
        let (c, _c_peer) = tokio::io::duplex(1024);
        let started = Instant::now();
        tokio::time::timeout(
            Duration::from_secs(2),
            splice(a, c, 0, Duration::from_millis(100)),
        )
        .await
        .expect("idle splice must close")
        .unwrap();
        assert!(started.elapsed() >= Duration::from_millis(100));
    }

    #[tokio::test]
    async fn m3_per_vm_connection_limit_on_broker_and_relay() {
        use tokio::net::UnixStream;
        let dir = tempfile::tempdir().unwrap();

        // Broker: 2 slots held by silent guests; the 3rd is closed at once.
        let (mut b, _rx) = broker(
            vec![rule("api.x.com")],
            vec![443],
            rustls::RootCertStore::empty(),
            None,
        );
        b.conns = Arc::new(tokio::sync::Semaphore::new(2));
        b.handshake_timeout = Duration::from_secs(30);
        let path = dir.path().join("vm.sock_3128");
        let l = bind_vsock_listener(&path, None).unwrap();
        tokio::spawn(Arc::new(b).serve(l));
        let _held1 = UnixStream::connect(&path).await.unwrap();
        let _held2 = UnixStream::connect(&path).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let mut third = UnixStream::connect(&path).await.unwrap();
        let mut buf = [0u8; 1];
        let n = tokio::time::timeout(Duration::from_secs(1), third.read(&mut buf))
            .await
            .expect("over-limit connection must be closed, not parked")
            .unwrap_or(0);
        assert_eq!(n, 0);

        // Relay: limit 1.
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let taddr = target.local_addr().unwrap();
        let rpath = dir.path().join("vm.sock_50054");
        let rl = bind_vsock_listener(&rpath, None).unwrap();
        tokio::spawn(relay_to_tcp(rl, taddr, 1));
        let _r1 = UnixStream::connect(&rpath).await.unwrap();
        let _accepted = tokio::time::timeout(Duration::from_secs(1), target.accept())
            .await
            .unwrap()
            .unwrap();
        let mut r2 = UnixStream::connect(&rpath).await.unwrap();
        let n = tokio::time::timeout(Duration::from_secs(1), r2.read(&mut buf))
            .await
            .expect("relay over-limit connection must be closed")
            .unwrap_or(0);
        assert_eq!(n, 0);
    }

    pub(crate) mod capture {
        use std::io::Write;
        use std::sync::{Arc, Mutex};

        /// Collects all tracing output (TRACE and up) for leak assertions.
        #[derive(Clone, Default)]
        pub struct Capture(Arc<Mutex<Vec<u8>>>);

        impl Write for Capture {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        impl Capture {
            pub fn subscriber(&self) -> impl tracing::Subscriber + Send + Sync {
                let me = self.clone();
                tracing_subscriber::fmt()
                    .with_max_level(tracing::Level::TRACE)
                    .with_writer(move || me.clone())
                    .finish()
            }
            pub fn text(&self) -> String {
                String::from_utf8_lossy(
                    &self
                        .0
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner),
                )
                .to_string()
            }
        }
    }

    // ---- DLP tests (ADR 0030) ---------------------------------------------------

    pub(crate) fn dlp_engine_block_card() -> Arc<crate::dlp::DlpEngine> {
        let policy = crate::dlp::DlpPolicy {
            rules: vec![crate::dlp::DlpRule {
                rule_id: "card-block".into(),
                detector: "card_number".into(),
                pattern: String::new(),
                mode: crate::dlp::DlpMode::Block,
                threshold: 1,
            }],
            max_inspect_bytes: 0,
        };
        Arc::new(crate::dlp::DlpEngine::compile(policy).unwrap())
    }

    fn dlp_engine_audit_card() -> Arc<crate::dlp::DlpEngine> {
        let policy = crate::dlp::DlpPolicy {
            rules: vec![crate::dlp::DlpRule {
                rule_id: "card-audit".into(),
                detector: "card_number".into(),
                pattern: String::new(),
                mode: crate::dlp::DlpMode::Audit,
                threshold: 1,
            }],
            max_inspect_bytes: 0,
        };
        Arc::new(crate::dlp::DlpEngine::compile(policy).unwrap())
    }

    #[tokio::test]
    async fn dlp_block_stops_plain_http_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (mut b, mut rx) = broker(
            vec![rule("api.x.com")],
            vec![80],
            rustls::RootCertStore::empty(),
            Some(addr),
        );
        b.dlp = Some(dlp_engine_block_card());
        // A valid Luhn card number in the body — should be blocked.
        let out = roundtrip(
            &b,
            "POST http://api.x.com/ HTTP/1.1\r\nHost: api.x.com\r\n\
             Content-Length: 18\r\n\r\n4111111111111111\r\n",
        )
        .await;
        assert!(out.starts_with("HTTP/1.1 403"), "expected 403, got: {out}");
        assert!(out.contains("dlp-block"), "{out}");
        // Upstream must NOT have received the request.
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "upstream was contacted despite DLP block"
        );
        // Audit event emitted with rule_id/detector but NOT the card number.
        let ev = rx.try_recv().unwrap();
        assert_eq!(ev.action, "dlp");
        assert_eq!(ev.attrs["decision"], "block");
        assert_eq!(ev.attrs["rule_id"], "card-block");
        assert_eq!(ev.attrs["detector"], "card_number");
        // Matched value never in attrs (invariant #10).
        assert!(!ev.attrs.contains_key("matched_value"));
        // The card number itself must not appear in any audit attr value.
        for (k, v) in &ev.attrs {
            assert!(
                !v.contains("4111111111111111"),
                "card number leaked in audit attr {k}={v}"
            );
        }
    }

    #[tokio::test]
    async fn dlp_audit_emits_event_and_allows_request_through() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let _ = tokio::io::copy(&mut s, &mut tokio::io::sink()).await;
        });
        let (mut b, mut rx) = broker(
            vec![rule("api.x.com")],
            vec![80],
            rustls::RootCertStore::empty(),
            Some(addr),
        );
        b.dlp = Some(dlp_engine_audit_card());
        let out = roundtrip(
            &b,
            "POST http://api.x.com/ HTTP/1.1\r\nHost: api.x.com\r\n\
             Content-Length: 18\r\n\r\n4111111111111111\r\n",
        )
        .await;
        // Not blocked — connection went through (upstream read and closed).
        assert!(
            !out.starts_with("HTTP/1.1 403"),
            "should not block on audit: {out}"
        );
        // Audit event emitted.
        let dlp_ev = (0..rx.len())
            .filter_map(|_| rx.try_recv().ok())
            .find(|e| e.action == "dlp");
        let ev = dlp_ev.expect("dlp audit event not emitted");
        assert_eq!(ev.attrs["decision"], "audit");
        assert_eq!(ev.attrs["rule_id"], "card-audit");
        // Matched value not present.
        for (k, v) in &ev.attrs {
            assert!(
                !v.contains("4111111111111111"),
                "card number in audit attr {k}={v}"
            );
        }
    }

    #[tokio::test]
    async fn dlp_opaque_connect_tunnel_not_inspected() {
        // An opaque CONNECT (no inject rule → no TLS termination) goes straight to
        // splice(); the DLP engine must never run on its body stream.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Accept and echo on the "upstream" side.
        tokio::spawn(async move {
            if let Ok((mut s, _)) = listener.accept().await {
                // Just drain then close.
                let _ = tokio::io::copy(&mut s, &mut tokio::io::sink()).await;
                let _ = s.shutdown().await;
            }
        });
        let (mut b, mut rx) = broker(
            vec![rule("api.x.com")],
            vec![443],
            rustls::RootCertStore::empty(),
            Some(addr),
        );
        // Block mode for card numbers — should NOT affect opaque CONNECT.
        b.dlp = Some(dlp_engine_block_card());
        // Send a CONNECT (opaque tunnel — no inject rule, so no MitM).
        let out = roundtrip(&b, "CONNECT api.x.com:443 HTTP/1.1\r\n\r\n").await;
        // We get "200 Connection Established" — DLP did not block.
        assert!(
            out.starts_with("HTTP/1.1 200"),
            "opaque CONNECT blocked unexpectedly: {out}"
        );
        // No dlp action in audit log.
        assert!(
            !(0..rx.len())
                .filter_map(|_| rx.try_recv().ok())
                .any(|e| e.action == "dlp"),
            "DLP audit emitted for opaque CONNECT"
        );
    }

    fn plain_dlp_broker(
        addr: SocketAddr,
        engine: Arc<crate::dlp::DlpEngine>,
    ) -> (Broker, mpsc::Receiver<pb::AuditEvent>) {
        let (mut b, rx) = broker(
            vec![rule("api.x.com")],
            vec![80],
            rustls::RootCertStore::empty(),
            Some(addr),
        );
        b.dlp = Some(engine);
        (b, rx)
    }

    /// #3 + #4 + #13 on the plain path: smuggling-shaped framing is a 400, a
    /// card split across chunks is blocked, and a chunked body that ends
    /// before its terminal chunk is refused in block mode — never spliced
    /// uninspected. Nothing reaches the upstream.
    #[tokio::test]
    async fn dlp_plain_path_framing_and_chunked_fail_closed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (b, mut rx) = plain_dlp_broker(listener.local_addr().unwrap(), dlp_engine_block_card());
        let pre = "POST http://api.x.com/ HTTP/1.1\r\nHost: api.x.com\r\n";
        for (req, want) in [
            (
                format!("{pre}Content-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"),
                "HTTP/1.1 400",
            ),
            (
                format!("{pre}Content-Length: 4\r\nContent-Length: 40\r\n\r\nabcd"),
                "HTTP/1.1 400",
            ),
            (
                format!("{pre}Transfer-Encoding: chunked\r\n\r\nzz\r\n"),
                "HTTP/1.1 400",
            ),
            (
                format!(
                    "{pre}Transfer-Encoding: chunked\r\n\r\n\
                     8\r\ncard 453\r\n6\r\n201511\r\n7\r\n2830366\r\n0\r\n\r\n"
                ),
                "HTTP/1.1 403",
            ),
            (
                // Clean so far, then the guest stops before the terminal chunk.
                format!("{pre}Transfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n"),
                "HTTP/1.1 403",
            ),
        ] {
            let out = roundtrip(&b, &req).await;
            assert!(out.starts_with(want), "{req:?} -> {out}");
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "upstream contacted for a refused request"
        );
        let evs: Vec<_> = (0..rx.len()).filter_map(|_| rx.try_recv().ok()).collect();
        assert!(evs.iter().any(|e| e.action == "dlp"
            && e.attrs.get("reason").map(String::as_str) == Some("body-not-fully-inspected")
            && e.attrs["decision"] == "block"));
    }

    /// #4a in audit mode: an incomplete body is forwarded (nothing to
    /// enforce) but recorded as not fully inspected.
    #[tokio::test]
    async fn dlp_audit_mode_forwards_incomplete_body_and_records_it() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut got = Vec::new();
            let _ = s.read_to_end(&mut got).await;
            got
        });
        let (b, mut rx) = plain_dlp_broker(addr, dlp_engine_audit_card());
        roundtrip(
            &b,
            "POST http://api.x.com/ HTTP/1.1\r\nHost: api.x.com\r\n\
             Transfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n",
        )
        .await;
        let got = String::from_utf8(upstream.await.unwrap()).unwrap();
        assert!(got.ends_with("\r\n\r\n4\r\nabcd\r\n"), "{got}");
        let evs: Vec<_> = (0..rx.len()).filter_map(|_| rx.try_recv().ok()).collect();
        assert!(
            evs.iter()
                .any(|e| e.action == "dlp" && e.attrs["decision"] == "audit")
        );
    }

    /// #10: with DLP the broker reads the body before dialling, so it answers
    /// `Expect: 100-continue` itself and the upstream never sees the header.
    #[tokio::test]
    async fn dlp_answers_expect_continue_and_strips_it_upstream() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let mut r = BufReader::new(s);
            let head = read_head(&mut r).await.unwrap().unwrap();
            let mut body = Vec::new();
            let _ = r.read_to_end(&mut body).await;
            (head, body)
        });
        let (b, _rx) = plain_dlp_broker(addr, dlp_engine_block_card());
        let (mut guest, host) = tokio::io::duplex(64 * 1024);
        let client = async move {
            guest
                .write_all(
                    b"POST http://api.x.com/ HTTP/1.1\r\nHost: api.x.com\r\n\
                      Expect: 100-continue\r\nContent-Length: 5\r\n\r\n",
                )
                .await
                .unwrap();
            // A real client waits for the 100 before sending the body.
            let mut interim = [0u8; 25];
            guest.read_exact(&mut interim).await.unwrap();
            assert_eq!(&interim, b"HTTP/1.1 100 Continue\r\n\r\n");
            guest.write_all(b"hello").await.unwrap();
            guest.shutdown().await.unwrap();
            let _ = guest.read_to_end(&mut Vec::new()).await;
        };
        let (_, ()) = tokio::join!(b.serve_conn(host), client);
        let (head, body) = upstream.await.unwrap();
        assert!(head.header_values("expect").is_empty(), "{head:?}");
        assert_eq!(head.header_values("content-length"), vec!["5"]);
        assert_eq!(body, b"hello");
    }
}
