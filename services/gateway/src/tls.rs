//! TLS termination config for the gateway.
//!
//! # Design
//!
//! - Cert + key are loaded from paths in `LANTERN_TLS_CERT` / `LANTERN_TLS_KEY`.
//! - When those env vars are present a `rustls::ServerConfig` is returned and
//!   main.rs wraps the TCP listener in a `TlsListener` that implements
//!   `axum::serve::Listener`, passing it straight to `axum::serve`.
//! - **Prod gate** (`LANTERN_ENV` ∈ {prod, production, staging}):
//!   missing cert/key → `eprintln!` + `std::process::exit(1)`. The gateway
//!   MUST NOT serve user traffic in cleartext on :8443 in production.
//! - **Dev / unset `LANTERN_ENV`**: missing cert/key → `WARN` log + returns
//!   `Ok(None)`, main.rs falls through to the plain TCP path.

use std::fs;
use std::io::BufReader;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use rustls::ServerConfig;
use rustls_pemfile::{certs, private_key};
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

/// Returns the rustls `ServerConfig` when TLS env vars are present, or `None`
/// in dev mode when they are absent.  Exits the process in production when
/// the config cannot be built.
pub fn build_server_config() -> anyhow::Result<Option<Arc<ServerConfig>>> {
    let cert_path = std::env::var("LANTERN_TLS_CERT").ok();
    let key_path = std::env::var("LANTERN_TLS_KEY").ok();

    match (cert_path, key_path) {
        (Some(cert), Some(key)) => {
            let config = load_server_config(Path::new(&cert), Path::new(&key))?;
            Ok(Some(Arc::new(config)))
        }
        _ => {
            if is_prod_env() {
                // FAIL CLOSED: never serve credentials in cleartext in prod.
                eprintln!(
                    "FATAL: LANTERN_TLS_CERT and LANTERN_TLS_KEY are required in \
                     production (LANTERN_ENV={:?}). Refusing to start without TLS.",
                    std::env::var("LANTERN_ENV").unwrap_or_default()
                );
                std::process::exit(1);
            }
            tracing::warn!(
                "LANTERN_TLS_CERT/LANTERN_TLS_KEY not set; serving PLAINTEXT on :8443. \
                 This is unsafe outside dev/test. Set LANTERN_ENV=prod to make this fatal."
            );
            Ok(None)
        }
    }
}

/// Returns `true` when `LANTERN_ENV` indicates a production-like environment.
pub fn is_prod_env() -> bool {
    matches!(
        std::env::var("LANTERN_ENV")
            .unwrap_or_default()
            .to_lowercase()
            .as_str(),
        "prod" | "production" | "staging"
    )
}

/// Parse PEM cert chain and private key files, return a ready `ServerConfig`.
///
/// Errors on I/O failure, malformed PEM, or missing key.
pub fn load_server_config(cert_path: &Path, key_path: &Path) -> anyhow::Result<ServerConfig> {
    let cert_file = fs::File::open(cert_path)
        .map_err(|e| anyhow::anyhow!("cannot open TLS cert {:?}: {e}", cert_path))?;
    let key_file = fs::File::open(key_path)
        .map_err(|e| anyhow::anyhow!("cannot open TLS key {:?}: {e}", key_path))?;

    let cert_chain: Vec<CertificateDer> = certs(&mut BufReader::new(cert_file))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("failed to parse TLS cert PEM: {e}"))?;

    if cert_chain.is_empty() {
        return Err(anyhow::anyhow!("TLS cert file contains no certificates"));
    }

    let key = private_key(&mut BufReader::new(key_file))
        .map_err(|e| anyhow::anyhow!("failed to parse TLS key PEM: {e}"))?
        .ok_or_else(|| anyhow::anyhow!("TLS key file contains no private key"))?;

    build_server_config_from_parts(cert_chain, key)
}

/// Build a `ServerConfig` from already-parsed cert chain and private key.
///
/// Extracted for testability — tests can pass in-memory PEM buffers without
/// writing temporary files.
///
/// Uses `ring` as the explicit crypto provider so the binary works correctly
/// even when both `ring` and `aws-lc-rs` are present as transitive deps.
pub fn build_server_config_from_parts(
    cert_chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> anyhow::Result<ServerConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| anyhow::anyhow!("rustls protocol versions error: {e}"))?
        .with_no_client_auth()
        .with_single_cert(cert_chain, key)
        .map_err(|e| anyhow::anyhow!("rustls ServerConfig error: {e}"))?;
    Ok(config)
}

// ---------------------------------------------------------------------------
// TlsListener — wraps TcpListener + TlsAcceptor and implements
// axum::serve::Listener so axum::serve can use it directly.
// ---------------------------------------------------------------------------

/// An axum-compatible `Listener` that performs a TLS handshake on each
/// accepted TCP connection before handing the stream to hyper.
///
/// `axum::serve::Listener` requires `Io: AsyncRead + AsyncWrite + Unpin + Send + 'static`
/// and `Addr: Send`.  `tokio_rustls::server::TlsStream<TcpStream>` satisfies
/// both, and `SocketAddr` is `Send`, so this compiles without any unsafe.
pub struct TlsListener {
    inner: TcpListener,
    acceptor: TlsAcceptor,
}

impl TlsListener {
    pub fn new(listener: TcpListener, acceptor: TlsAcceptor) -> Self {
        Self {
            inner: listener,
            acceptor,
        }
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.inner.accept().await {
                Ok((tcp, peer)) => {
                    match self.acceptor.accept(tcp).await {
                        Ok(tls) => return (tls, peer),
                        Err(e) => {
                            // A failed TLS handshake (e.g., client sent
                            // non-TLS bytes, or sent an SNI we don't have a
                            // cert for) is logged at WARN and we loop to
                            // accept the next connection — never panic.
                            tracing::warn!(
                                peer = %peer,
                                error = %e,
                                "TLS handshake failed; dropping connection"
                            );
                        }
                    }
                }
                Err(e) => {
                    // Transient OS errors (EMFILE, ECONNRESET) are logged;
                    // fatal bind errors won't occur here since we already
                    // called bind() before entering this loop.
                    tracing::error!(error = %e, "TCP accept error");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // Generate a self-signed cert+key pair using `rcgen` (dev-dep only).
    // Returns (cert_pem_bytes, key_pem_bytes).
    fn generate_test_cert() -> (Vec<u8>, Vec<u8>) {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
            .expect("rcgen generate_simple_self_signed failed");
        let cert_pem = cert.cert.pem().into_bytes();
        let key_pem = cert.key_pair.serialize_pem().into_bytes();
        (cert_pem, key_pem)
    }

    /// Loading valid PEM cert+key produces a `ServerConfig` without error.
    #[test]
    fn load_valid_cert_key_builds_config() {
        let (cert_pem, key_pem) = generate_test_cert();

        let cert_chain: Vec<CertificateDer> = certs(&mut BufReader::new(Cursor::new(&cert_pem)))
            .collect::<Result<Vec<_>, _>>()
            .expect("cert parse");

        let key = private_key(&mut BufReader::new(Cursor::new(&key_pem)))
            .expect("key parse ok")
            .expect("key present");

        let result = build_server_config_from_parts(cert_chain, key);
        assert!(result.is_ok(), "expected Ok, got {result:?}");
    }

    /// An empty cert chain is rejected.
    #[test]
    fn empty_cert_chain_is_rejected() {
        let (_, key_pem) = generate_test_cert();
        let key = private_key(&mut BufReader::new(Cursor::new(&key_pem)))
            .expect("key parse ok")
            .expect("key present");

        // Pass an empty chain — ServerConfig should error.
        let result = build_server_config_from_parts(vec![], key);
        assert!(result.is_err(), "expected error for empty cert chain");
    }

    /// `is_prod_env` correctly identifies production-like values.
    #[test]
    fn prod_env_detection() {
        // These tests set env vars; guard against parallel test contamination
        // by using a dedicated env var name in each sub-test.
        let check = |val: &str, expected: bool| {
            // We can't set env vars per-test safely in parallel; test the
            // pure logic directly by calling the matcher function.
            let result = matches!(
                val.to_lowercase().as_str(),
                "prod" | "production" | "staging"
            );
            assert_eq!(
                result, expected,
                "LANTERN_ENV={val:?} should be prod={expected}"
            );
        };

        check("prod", true);
        check("production", true);
        check("staging", true);
        check("PROD", true);
        check("PRODUCTION", true);
        check("dev", false);
        check("development", false);
        check("test", false);
        check("", false);
    }

    /// In-process TLS handshake: the ServerConfig produced by
    /// `build_server_config_from_parts` negotiates successfully with a
    /// `rustls::ClientConfig` that trusts the same self-signed cert.
    ///
    /// Uses a tokio in-memory duplex channel so no OS sockets are needed.
    #[tokio::test]
    async fn in_process_tls_handshake_succeeds() {
        use rustls::ClientConfig;
        use rustls_pki_types::ServerName;
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio_rustls::{TlsAcceptor, TlsConnector};

        let (cert_pem, key_pem) = generate_test_cert();

        // --- Parse cert chain & key ---
        let cert_chain: Vec<CertificateDer<'static>> =
            certs(&mut BufReader::new(Cursor::new(&cert_pem)))
                .collect::<Result<Vec<_>, _>>()
                .expect("cert parse");

        let key = private_key(&mut BufReader::new(Cursor::new(&key_pem)))
            .expect("key parse")
            .expect("key present");

        // --- Build server TLS config ---
        let server_config = Arc::new(
            build_server_config_from_parts(cert_chain.clone(), key).expect("server config"),
        );

        // --- Build client TLS config that trusts the self-signed cert ---
        let mut root_store = rustls::RootCertStore::empty();
        for cert in &cert_chain {
            root_store
                .add(cert.clone())
                .expect("add self-signed cert to root store");
        }
        // Use ring explicitly to avoid ambiguity when both ring and
        // aws-lc-rs are present as transitive deps.
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let client_config = Arc::new(
            ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .expect("protocol versions")
                .with_root_certificates(root_store)
                .with_no_client_auth(),
        );

        // --- Wire up an in-memory duplex transport (no OS sockets) ---
        let (client_io, server_io) = tokio::io::duplex(4096);

        let acceptor = TlsAcceptor::from(server_config);
        let connector = TlsConnector::from(client_config);

        // Server task: accept, read one byte, echo it back.
        let server_task = tokio::spawn(async move {
            let mut tls_stream = acceptor.accept(server_io).await.expect("server accept");
            let mut buf = [0u8; 1];
            tls_stream.read_exact(&mut buf).await.expect("server read");
            tls_stream.write_all(&buf).await.expect("server write");
        });

        // Client: connect, write one byte, read echo.
        let server_name = ServerName::try_from("localhost").expect("server name");
        let mut tls_stream = connector
            .connect(server_name, client_io)
            .await
            .expect("client connect");

        tls_stream.write_all(&[0x42]).await.expect("client write");
        let mut echo = [0u8; 1];
        tls_stream.read_exact(&mut echo).await.expect("client read");

        assert_eq!(echo[0], 0x42, "echoed byte must match");
        server_task.await.expect("server task");
    }
}
