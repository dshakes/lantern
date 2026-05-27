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

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;

use crate::manager_client::ManagerClient;
use crate::proto::{now_unix_ms, AuditEvent, EgressRule, HarnessReport};

#[derive(Clone, Debug)]
pub enum Decision {
    Allow,
    Deny(&'static str),
}

pub struct EgressPolicy {
    rules: RwLock<Vec<EgressRule>>,
    manager: ManagerClient,
}

impl EgressPolicy {
    pub fn new(initial: Vec<EgressRule>, manager: ManagerClient) -> Self {
        Self {
            rules: RwLock::new(initial),
            manager,
        }
    }

    pub async fn replace_rules(&self, new_rules: Vec<EgressRule>) {
        let mut g = self.rules.write().await;
        *g = new_rules;
    }

    /// Decision point: extend here for header/method enforcement + per-rule
    /// rate buckets. v1 does host-pattern matching only.
    pub async fn evaluate(&self, host: &str, _method: Option<&str>) -> Decision {
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

    async fn audit(&self, host: &str, decision: &Decision) {
        let mut attrs = std::collections::HashMap::new();
        attrs.insert("host".into(), host.to_string());
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

fn pattern_matches(pattern: &str, host: &str) -> bool {
    if let Some(suffix) = pattern.strip_prefix("*.") {
        host.ends_with(suffix) && host.len() > suffix.len()
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
    let host = target.split(':').next().unwrap_or(target).to_string();

    let decision = policy.evaluate(&host, None).await;
    policy.audit(&host, &decision).await;

    match decision {
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
