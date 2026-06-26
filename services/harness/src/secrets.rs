// Secret vending: on workload request the harness calls
// runtime-manager's VendSecret RPC and exposes the value over a unix
// socket at /run/lantern/secrets.sock. Cached responses are stored in
// tmpfs and re-vended before expiry.
//
// Wire protocol on the unix socket (newline-delimited JSON):
//   { "env_name": "OPENAI_API_KEY" }  -> { "value": "...", "expires_at_unix_ms": 0 }
// Errors:
//   { "error": "..." }
//
// The workload typically wraps this in a small library; the SDK ships one.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use crate::manager_client::ManagerClient;
use crate::proto::{AuditEvent, HarnessReport, SecretRef, VendSecretRequest, now_unix_ms};

const REFRESH_LEAD_MS: i64 = 30_000; // refresh 30s before expiry
const DEFAULT_TTL_SECS: i64 = 300;

// ---------------------------------------------------------------------------
// P2-B7 (1): peer authentication for the secrets socket.
//
// Threat model
// ------------
// The secrets socket at /run/lantern/secrets.sock vends short-TTL secret
// material to the workload. Before this change ANY in-VM process that could
// open the socket received whatever it asked for. Inside a microVM the workload
// runs as PID 1's uid with no privilege drop, so a single compromised library /
// subprocess in the workload's process tree could exfiltrate every declared
// secret. The socket is the last in-VM trust boundary around secret material.
//
// Control
// -------
// We use SO_PEERCRED on the accepted UnixStream to read the connecting peer's
// (uid, gid, pid) — kernel-attested, unspoofable by the peer. The harness only
// vends to the *expected workload uid*, injected by the manager at spawn as
// `LANTERN_WORKLOAD_UID`. The harness's own uid (its own process) is always
// allowed so internal probes / health checks work.
//
// Fail-open vs fail-closed
// ------------------------
// When `LANTERN_WORKLOAD_UID` is UNSET we are in dev (no manager-injected
// identity). We log a prominent SECURITY warning once and allow — the dev path
// must keep working and there is no second identity to distinguish. In
// production the manager MUST inject `LANTERN_WORKLOAD_UID` so this becomes
// fail-closed against any other uid. The bootstrap-token alternative was
// rejected: the workload binary is opaque (we don't control its source) so we
// can't reliably hand it a token to present, whereas SO_PEERCRED needs zero
// workload cooperation.

/// The kernel-attested identity of a unix-socket peer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeerIdentity {
    pub uid: u32,
    pub gid: u32,
    pub pid: i32,
}

/// Read SO_PEERCRED from a connected `UnixStream`. Linux-only; on other hosts
/// (macOS dev) the syscall shape differs, so we return `None` and the caller
/// treats it as "cannot authenticate" (dev path). The returned identity is
/// attested by the kernel and cannot be forged by the peer.
#[cfg(target_os = "linux")]
fn peer_identity(stream: &UnixStream) -> Option<PeerIdentity> {
    use std::os::fd::AsRawFd;
    let fd = stream.as_raw_fd();
    // SAFETY: ucred is a plain POD struct; getsockopt fills it and reports the
    // written length. We pass a correctly-sized buffer and check the return.
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(cred).cast(),
            &mut len,
        )
    };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        tracing::warn!(error = %err, "secrets: SO_PEERCRED getsockopt failed");
        return None;
    }
    Some(PeerIdentity {
        uid: cred.uid,
        gid: cred.gid,
        pid: cred.pid,
    })
}

#[cfg(not(target_os = "linux"))]
fn peer_identity(_stream: &UnixStream) -> Option<PeerIdentity> {
    None
}

/// The expected workload uid the manager injected at spawn, if any.
fn expected_workload_uid() -> Option<u32> {
    std::env::var("LANTERN_WORKLOAD_UID")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
}

/// Decide whether a peer is authorized to pull secrets.
///
/// Pure so it is unit-testable without a live socket:
///  - `expected`: the configured workload uid (None = dev / unset).
///  - `self_uid`: the harness's own uid (always allowed — internal probes).
///  - `peer`: the SO_PEERCRED identity (None = couldn't read it).
///
/// Returns `Ok(())` to allow, `Err(reason)` to reject.
fn authorize_peer(
    expected: Option<u32>,
    self_uid: u32,
    peer: Option<PeerIdentity>,
) -> Result<(), &'static str> {
    match (expected, peer) {
        // No expected uid configured → dev path: allow (warned once at serve()).
        (None, _) => Ok(()),
        // Couldn't read peer creds but an identity IS required → fail closed.
        (Some(_), None) => Err("peer credentials unavailable (SO_PEERCRED failed)"),
        (Some(want), Some(p)) => {
            if p.uid == want || p.uid == self_uid {
                Ok(())
            } else {
                Err("peer uid not authorized for secret access")
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct CacheEntry {
    pub value: String,
    pub expires_at_unix_ms: i64,
    #[allow(dead_code)]
    pub secret_uri: String,
}

#[derive(Clone)]
pub struct SecretCache {
    /// keyed by env_name (e.g. "OPENAI_API_KEY")
    inner: Arc<DashMap<String, CacheEntry>>,
    /// declared SecretRefs from the AgentSpec — anything not on this list
    /// is rejected at vend time. Manager will also reject, but enforcing
    /// here keeps the audit trail accurate.
    declared: Arc<DashMap<String, SecretRef>>,
    manager: ManagerClient,
    socket_path: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct SocketReq {
    env_name: String,
}

#[derive(Serialize)]
#[serde(untagged)]
enum SocketResp {
    Ok {
        value: String,
        expires_at_unix_ms: i64,
    },
    Err {
        error: String,
    },
}

impl SecretCache {
    pub fn new(manager: ManagerClient, declared: Vec<SecretRef>) -> Self {
        let map = DashMap::new();
        for s in declared {
            map.insert(s.env_name.clone(), s);
        }
        let socket_path = std::env::var("LANTERN_SECRETS_SOCKET")
            .unwrap_or_else(|_| "/run/lantern/secrets.sock".to_string());
        Self {
            inner: Arc::new(DashMap::new()),
            declared: Arc::new(map),
            manager,
            socket_path: PathBuf::from(socket_path),
        }
    }

    /// Bind the unix socket and accept workload requests forever.
    pub async fn serve(self: Arc<Self>) -> Result<()> {
        if let Some(parent) = self.socket_path.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        // Remove stale socket if present (idempotent restart).
        let _ = tokio::fs::remove_file(&self.socket_path).await;

        let listener = UnixListener::bind(&self.socket_path)
            .with_context(|| format!("bind {:?}", self.socket_path))?;

        // P2-B7 (1): announce the peer-auth posture once at startup.
        match expected_workload_uid() {
            Some(uid) => {
                tracing::info!(
                    path = ?self.socket_path,
                    expected_workload_uid = uid,
                    "secrets: socket listening (peer-auth ENFORCED — only the workload uid \
                     and the harness uid may pull secrets)"
                );
            }
            None => {
                tracing::warn!(
                    path = ?self.socket_path,
                    "secrets: socket listening WITHOUT peer authentication — \
                     LANTERN_WORKLOAD_UID unset (dev path). ANY in-VM process can pull secrets. \
                     The manager MUST inject LANTERN_WORKLOAD_UID in production."
                );
            }
        }

        loop {
            let (stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(error = %e, "secrets: accept error");
                    continue;
                }
            };
            let this = Arc::clone(&self);
            tokio::spawn(async move {
                if let Err(e) = this.handle_conn(stream).await {
                    tracing::warn!(error = %e, "secrets: conn handler error");
                }
            });
        }
    }

    async fn handle_conn(self: Arc<Self>, stream: UnixStream) -> Result<()> {
        // P2-B7 (1): authenticate the peer BEFORE reading any request. An
        // unauthorized peer is rejected with an error line and the connection
        // is closed without ever consulting the cache or vending.
        let peer = peer_identity(&stream);
        // SAFETY: getuid() is always-succeeds and thread-safe.
        let self_uid = unsafe { libc::getuid() };
        if let Err(reason) = authorize_peer(expected_workload_uid(), self_uid, peer) {
            tracing::warn!(
                ?peer,
                reason,
                "secrets: REJECTED unauthorized peer attempting secret access"
            );
            // Audit the rejection so it leaves a forensic trail.
            let mut attrs: HashMap<String, String> = HashMap::new();
            attrs.insert("decision".into(), "deny".into());
            attrs.insert("reason".into(), reason.to_string());
            if let Some(p) = peer {
                attrs.insert("peer_uid".into(), p.uid.to_string());
                attrs.insert("peer_pid".into(), p.pid.to_string());
            }
            self.manager
                .enqueue_report(HarnessReport::Audit(AuditEvent {
                    vm_id: self.manager.vm_id.clone(),
                    action: "secret_access_denied".into(),
                    at_unix_ms: now_unix_ms(),
                    attrs,
                }))
                .await;
            let (_read_half, mut write_half) = stream.into_split();
            let mut bytes = serde_json::to_vec(&SocketResp::Err {
                error: "unauthorized: secret access denied".to_string(),
            })?;
            bytes.push(b'\n');
            let _ = write_half.write_all(&bytes).await;
            return Ok(());
        }

        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();

        while reader.read_line(&mut line).await? > 0 {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                line.clear();
                continue;
            }
            let resp = match serde_json::from_str::<SocketReq>(trimmed) {
                Ok(req) => match self.get_or_vend(&req.env_name).await {
                    Ok(entry) => SocketResp::Ok {
                        value: entry.value,
                        expires_at_unix_ms: entry.expires_at_unix_ms,
                    },
                    Err(e) => SocketResp::Err {
                        error: e.to_string(),
                    },
                },
                Err(e) => SocketResp::Err {
                    error: format!("bad request: {e}"),
                },
            };
            let mut bytes = serde_json::to_vec(&resp)?;
            bytes.push(b'\n');
            write_half.write_all(&bytes).await?;
            line.clear();
        }
        Ok(())
    }

    /// Returns a fresh value, vending if absent or near expiry.
    pub async fn get_or_vend(&self, env_name: &str) -> Result<CacheEntry> {
        // Validate against declared list — defence in depth.
        let secret_ref = self
            .declared
            .get(env_name)
            .map(|r| r.clone())
            .ok_or_else(|| anyhow::anyhow!("secret {env_name} not declared in AgentSpec"))?;

        if let Some(entry) = self.inner.get(env_name)
            && entry.expires_at_unix_ms - now_unix_ms() > REFRESH_LEAD_MS
        {
            return Ok(entry.clone());
        }

        let resp = self
            .manager
            .vend_secret(VendSecretRequest {
                vm_id: self.manager.vm_id.clone(),
                secret_uri: secret_ref.secret_uri.clone(),
                ttl_secs: DEFAULT_TTL_SECS,
            })
            .await?;

        let entry = CacheEntry {
            value: resp.value,
            expires_at_unix_ms: resp.expires_at_unix_ms,
            secret_uri: secret_ref.secret_uri.clone(),
        };
        self.inner.insert(env_name.to_string(), entry.clone());

        // Audit (NEVER log the value).
        let mut attrs: HashMap<String, String> = HashMap::new();
        attrs.insert("env_name".into(), env_name.to_string());
        attrs.insert("secret_uri".into(), secret_ref.secret_uri.clone());
        attrs.insert(
            "expires_at_unix_ms".into(),
            entry.expires_at_unix_ms.to_string(),
        );
        self.manager
            .enqueue_report(HarnessReport::Audit(AuditEvent {
                vm_id: self.manager.vm_id.clone(),
                action: "secret_vend".into(),
                at_unix_ms: now_unix_ms(),
                attrs,
            }))
            .await;

        Ok(entry)
    }

    /// Background refresh sweep — keeps active secrets ahead of expiry.
    pub async fn refresh_loop(self: Arc<Self>) {
        let mut ticker = tokio::time::interval(Duration::from_secs(15));
        loop {
            ticker.tick().await;
            let now = now_unix_ms();
            let keys: Vec<String> = self
                .inner
                .iter()
                .filter(|e| e.expires_at_unix_ms - now < REFRESH_LEAD_MS)
                .map(|e| e.key().clone())
                .collect();
            for k in keys {
                if let Err(e) = self.get_or_vend(&k).await {
                    tracing::warn!(env = %k, error = %e, "secrets: refresh failed (workload keeps cached value until expiry)");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — peer-auth decision logic (pure; no live socket required).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const WORKLOAD_UID: u32 = 1000;
    const HARNESS_UID: u32 = 0;

    fn peer(uid: u32) -> PeerIdentity {
        PeerIdentity {
            uid,
            gid: uid,
            pid: 42,
        }
    }

    /// The expected workload uid is accepted.
    #[test]
    fn authorize_accepts_expected_workload_uid() {
        assert!(
            authorize_peer(Some(WORKLOAD_UID), HARNESS_UID, Some(peer(WORKLOAD_UID))).is_ok(),
            "the configured workload uid must be allowed"
        );
    }

    /// The harness's own uid is always accepted (internal probes).
    #[test]
    fn authorize_accepts_self_uid() {
        assert!(
            authorize_peer(Some(WORKLOAD_UID), HARNESS_UID, Some(peer(HARNESS_UID))).is_ok(),
            "the harness's own uid must be allowed"
        );
    }

    /// A different uid is REJECTED when an expected uid is configured.
    #[test]
    fn authorize_rejects_other_uid() {
        let r = authorize_peer(Some(WORKLOAD_UID), HARNESS_UID, Some(peer(31337)));
        assert!(r.is_err(), "an unexpected uid must be rejected");
    }

    /// Fail-closed: when an expected uid is configured but the peer creds could
    /// not be read, the connection is rejected (not allowed by default).
    #[test]
    fn authorize_fails_closed_when_peercred_unavailable() {
        let r = authorize_peer(Some(WORKLOAD_UID), HARNESS_UID, None);
        assert!(
            r.is_err(),
            "missing peer creds with a required uid must fail closed"
        );
    }

    /// Dev path: when no expected uid is configured, any peer is allowed (the
    /// serve() warning covers the security posture). This keeps macOS dev and
    /// manager-less local runs working.
    #[test]
    fn authorize_allows_when_no_expected_uid() {
        assert!(authorize_peer(None, HARNESS_UID, Some(peer(31337))).is_ok());
        assert!(
            authorize_peer(None, HARNESS_UID, None).is_ok(),
            "dev path: unset uid + no peer creds still allowed"
        );
    }
}
