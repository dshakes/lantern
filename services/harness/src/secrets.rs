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
        tracing::info!(path = ?self.socket_path, "secrets: socket listening");

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
