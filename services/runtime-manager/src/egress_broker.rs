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
use crate::secret_resolver::SecretResolver;

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
    pub const ENV: &'static str = "LANTERN_EGRESS_MODE";

    /// `broker` (case-insensitive) → Broker; anything else → Guest.
    pub fn parse(v: Option<&str>) -> Self {
        match v.map(str::trim) {
            Some(s) if s.eq_ignore_ascii_case("broker") => EgressMode::Broker,
            _ => EgressMode::Guest,
        }
    }

    pub fn from_env() -> Self {
        let raw = std::env::var(Self::ENV).ok();
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
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
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
        let ports = match std::env::var("LANTERN_EGRESS_ALLOWED_PORTS") {
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

    /// Host for a plain-HTTP request: absolute-form URI, else `Host:`.
    fn plain_http_authority(&self) -> Option<&str> {
        let (_, target) = self.method_target()?;
        if let Some(after) = target.strip_prefix("http://") {
            let authority = after.split('/').next().unwrap_or("");
            if !authority.is_empty() {
                return Some(authority);
            }
        }
        self.headers.iter().find_map(|h| {
            let (name, value) = h.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("host")
                .then(|| value.trim())
                .filter(|v| !v.is_empty())
        })
    }
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
fn rewrite_head(head: &Head, creds: &[(String, String)]) -> Vec<u8> {
    let replaced = |name: &str| {
        ["connection", "proxy-connection", "proxy-authorization"]
            .iter()
            .any(|h| name.eq_ignore_ascii_case(h))
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
            let dns = rule.pattern.strip_prefix("*.").unwrap_or(&rule.pattern);
            if dns.is_empty() || dns.parse::<IpAddr>().is_ok() || dns.contains('/') {
                bail!(
                    "egress rule '{}' injects credentials but is not a hostname pattern",
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
        leaves.insert(host.to_string(), Arc::clone(&cfg));
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
    policy: Policy,
    resolver: Arc<dyn SecretResolver>,
    mitm: Option<Arc<MitmCa>>,
    upstream_tls: Arc<rustls::ClientConfig>,
    audit: mpsc::Sender<pb::AuditEvent>,
    /// Test seam: dial this address for every allowed host, skipping DNS and
    /// the private-range check (test servers live on loopback).
    #[cfg(test)]
    test_upstream: Option<SocketAddr>,
}

impl Broker {
    pub fn new(
        vm_id: &str,
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
            policy,
            resolver: Arc::clone(&deps.resolver),
            mitm,
            upstream_tls: Arc::new(tls),
            audit: deps.audit.clone(),
            #[cfg(test)]
            test_upstream: None,
        })
    }

    /// Accept guest connections forever, one task each.
    pub async fn serve(self: Arc<Self>, listener: UnixListener) {
        loop {
            match listener.accept().await {
                Ok((conn, _)) => {
                    let broker = Arc::clone(&self);
                    tokio::spawn(async move {
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
        let Some(head) = read_head(&mut reader).await? else {
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
        let upstream = match self.dial(&host, port).await {
            Ok(s) => s,
            Err(reason) => {
                self.audit_decision(&host, port, Err(reason), "connect");
                respond(&mut client, "502 Bad Gateway", reason).await;
                return Ok(());
            }
        };
        let tls_mode = if terminate {
            "terminate"
        } else {
            "passthrough"
        };
        self.audit_decision(&host, port, Ok(()), tls_mode);
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await?;
        let rate = rule.rate_bps.max(0) as u64;
        match mitm {
            Some(ca) => self.terminate(client, upstream, &host, rule, &ca).await,
            None => splice(client, upstream, rate).await,
        }
    }

    /// TLS-terminate the workload's tunnel for an injecting rule, inject the
    /// credential into its request, and re-encrypt to the real upstream.
    async fn terminate<S>(
        &self,
        client: BufReader<S>,
        upstream: TcpStream,
        host: &str,
        rule: &EgressRule,
        ca: &MitmCa,
    ) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send,
    {
        let cfg = ca.server_config(host)?;
        // `client` is the BufReader: any ClientHello bytes already buffered
        // past the CONNECT head are read first, so nothing is lost.
        let tls = tokio_rustls::TlsAcceptor::from(cfg)
            .accept(client)
            .await
            .context("egress broker: TLS accept from guest")?;
        let mut inner = BufReader::new(tls);
        let Some(head) = read_head(&mut inner).await? else {
            return Ok(());
        };
        let method = head.method_target().map(|(m, _)| m).unwrap_or("");
        let Some(creds) = self
            .authorize_and_resolve(&mut inner, host, rule, method)
            .await
        else {
            return Ok(());
        };
        let server_name =
            ServerName::try_from(host.to_string()).context("egress broker: invalid SNI host")?;
        let mut up = tokio_rustls::TlsConnector::from(Arc::clone(&self.upstream_tls))
            .connect(server_name, upstream)
            .await
            .context("egress broker: upstream TLS handshake")?;
        let out = rewrite_head(&head, &creds);
        drop(creds);
        up.write_all(&out).await?;
        drop(out);
        self.audit_inject(host, method, rule);
        splice(inner, up, rule.rate_bps.max(0) as u64).await
    }

    async fn handle_plain<S>(&self, mut client: BufReader<S>, head: Head) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send,
    {
        let Some(authority) = head.plain_http_authority() else {
            respond(&mut client, "400 Bad Request", "missing-host").await;
            return Ok(());
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
            if !method_allowed(rule, method) {
                self.audit_decision(&host, port, Err("method-not-allowed"), "plain");
                respond(&mut client, "403 Forbidden", "method-not-allowed").await;
                return Ok(());
            }
            Vec::new()
        } else {
            match self
                .authorize_and_resolve(&mut client, &host, rule, method)
                .await
            {
                Some(c) => c,
                None => return Ok(()),
            }
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
        let out = rewrite_head(&head, &creds);
        let injected = !creds.is_empty();
        drop(creds);
        upstream.write_all(&out).await?;
        drop(out);
        if injected {
            self.audit_inject(&host, method, rule);
        }
        splice(client, upstream, rule.rate_bps.max(0) as u64).await
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
            let value = match self.resolver.resolve(&inj.secret_uri, None).await {
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
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
            .await
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
}

// ---------------------------------------------------------------------------
// Byte plumbing
// ---------------------------------------------------------------------------

/// Bidirectional copy; `rate_bps > 0` throttles each direction separately
/// (burst = one second of traffic, same as the in-guest proxy).
async fn splice<A, B>(a: A, b: B, rate_bps: u64) -> Result<()>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let (mut a, mut b) = (a, b);
    if rate_bps == 0 {
        let _ = tokio::io::copy_bidirectional(&mut a, &mut b).await;
        return Ok(());
    }
    let (ar, aw) = tokio::io::split(a);
    let (br, bw) = tokio::io::split(b);
    let _ = tokio::join!(
        throttled_copy(ar, bw, rate_bps),
        throttled_copy(br, aw, rate_bps)
    );
    Ok(())
}

async fn throttled_copy<R, W>(mut r: R, mut w: W, rate_bps: u64) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let burst = rate_bps as f64;
    let mut tokens = burst;
    let mut last = Instant::now();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            return w.shutdown().await;
        }
        let now = Instant::now();
        tokens = (tokens + now.duration_since(last).as_secs_f64() * burst).min(burst);
        last = now;
        if tokens < n as f64 {
            tokio::time::sleep(Duration::from_secs_f64((n as f64 - tokens) / burst)).await;
            tokens = 0.0;
            last = Instant::now();
        } else {
            tokens -= n as f64;
        }
        w.write_all(&buf[..n]).await?;
    }
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
pub async fn relay_to_tcp(listener: UnixListener, target: SocketAddr) {
    loop {
        match listener.accept().await {
            Ok((mut conn, _)) => {
                tokio::spawn(async move {
                    match TcpStream::connect(target).await {
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
        let mut b = Broker::new("vm-test", Policy::new(rules, ports), mitm, &d).unwrap();
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
        let ca = MitmCa::for_rules("vm", &[rule("a.com"), inject_rule("*.openai.com")])
            .unwrap()
            .unwrap();
        assert!(ca.ca_pem().starts_with("-----BEGIN CERTIFICATE-----"));
    }

    #[test]
    fn ca_refuses_injection_on_ip_or_bad_header() {
        assert!(MitmCa::for_rules("vm", &[inject_rule("8.8.8.8")]).is_err());
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
        let (b, mut rx) = broker(
            vec![r],
            vec![80],
            rustls::RootCertStore::empty(),
            Some(addr),
        );
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
        let (b, mut rx) = broker(
            vec![inject_rule("api.x.com")],
            vec![80],
            rustls::RootCertStore::empty(),
            Some(addr),
        );
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
}
