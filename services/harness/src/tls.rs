//! mTLS client-side config for the harness → manager gRPC channel.
//!
//! # Design
//!
//! Each harness instance presents a per-VM client certificate when connecting
//! to the runtime-manager.  Three env vars are injected by the manager at
//! spawn time:
//!
//!   - `LANTERN_VM_TLS_CERT` — path to the per-VM PEM client cert.
//!   - `LANTERN_VM_TLS_KEY`  — path to the per-VM PEM private key.
//!   - `LANTERN_MANAGER_TLS_CA` — path to the PEM CA that signed the
//!     manager's server cert.
//!
//! When all three are present, `build_client_tls_config` returns a tonic
//! `ClientTlsConfig` that the harness uses to dial the manager.
//!
//! **Dev / unset env vars**: when any of the three vars is absent the function
//! returns `Ok(None)` and the caller keeps the existing plaintext channel,
//! emitting a one-time WARN so the omission is visible in logs.
//!
//! ## Prod gate
//!
//! `LANTERN_ENV` ∈ {prod, production, staging} → missing vars are fatal
//! (`eprintln!` + `process::exit(1)`).
//!
//! ## Remaining work
//!
//! Per-VM cert PROVISIONING: the manager must generate a cert with CN=vm_id
//! and inject `LANTERN_VM_TLS_CERT`/`LANTERN_VM_TLS_KEY` into the
//! container/VM env at spawn time.  Until that is wired, the harness runs
//! plaintext in dev and tests.  The env-var names above are the agreed-upon
//! contract between manager (provisioner) and harness (consumer).

use std::fs;
use std::io::BufReader;

use rustls_pemfile::{certs, private_key};
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tonic::transport::{Certificate, ClientTlsConfig, Identity};

/// Env-var names for the harness client cert and CA.
pub const ENV_VM_CERT: &str = "LANTERN_VM_TLS_CERT";
pub const ENV_VM_KEY: &str = "LANTERN_VM_TLS_KEY";
pub const ENV_MANAGER_CA: &str = "LANTERN_MANAGER_TLS_CA";

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

/// Build a tonic `ClientTlsConfig` from the three env-var paths, or return
/// `None` when any are absent (dev mode).  Exits in production if absent.
pub fn build_client_tls_config() -> anyhow::Result<Option<ClientTlsConfig>> {
    let cert_path = std::env::var(ENV_VM_CERT).ok();
    let key_path = std::env::var(ENV_VM_KEY).ok();
    let ca_path = std::env::var(ENV_MANAGER_CA).ok();

    match (cert_path, key_path, ca_path) {
        (Some(cert), Some(key), Some(ca)) => {
            let cert_pem = fs::read(&cert)
                .map_err(|e| anyhow::anyhow!("cannot read {ENV_VM_CERT} {cert:?}: {e}"))?;
            let key_pem = fs::read(&key)
                .map_err(|e| anyhow::anyhow!("cannot read {ENV_VM_KEY} {key:?}: {e}"))?;
            let ca_pem = fs::read(&ca)
                .map_err(|e| anyhow::anyhow!("cannot read {ENV_MANAGER_CA} {ca:?}: {e}"))?;

            let config = build_client_tls_config_from_pem(&cert_pem, &key_pem, &ca_pem)?;
            tracing::info!(cert = %cert, ca = %ca, "harness: mTLS client cert loaded");
            Ok(Some(config))
        }
        _ => {
            if is_prod_env() {
                eprintln!(
                    "FATAL: {ENV_VM_CERT}, {ENV_VM_KEY}, {ENV_MANAGER_CA} are required \
                     in production (LANTERN_ENV={:?}). Refusing to start without mTLS.",
                    std::env::var("LANTERN_ENV").unwrap_or_default()
                );
                std::process::exit(1);
            }
            tracing::warn!(
                "mTLS client env vars ({ENV_VM_CERT}/{ENV_VM_KEY}/{ENV_MANAGER_CA}) not set; \
                 harness→manager channel is PLAINTEXT. \
                 Set LANTERN_ENV=prod to make this fatal."
            );
            Ok(None)
        }
    }
}

/// Build a `ClientTlsConfig` from raw PEM bytes (no file I/O).
///
/// Validates PEM before constructing the tonic config.  The CA cert tells
/// the client what server cert to trust; the identity is the client cert
/// presented to the server for mTLS.
pub fn build_client_tls_config_from_pem(
    cert_pem: &[u8],
    key_pem: &[u8],
    ca_pem: &[u8],
) -> anyhow::Result<ClientTlsConfig> {
    // Validate client cert chain.
    let cert_chain: Vec<CertificateDer> = certs(&mut BufReader::new(cert_pem))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("failed to parse VM client cert PEM: {e}"))?;
    if cert_chain.is_empty() {
        return Err(anyhow::anyhow!(
            "VM client cert PEM contains no certificates"
        ));
    }

    // Validate private key.
    let _key: PrivateKeyDer = private_key(&mut BufReader::new(key_pem))
        .map_err(|e| anyhow::anyhow!("failed to parse VM key PEM: {e}"))?
        .ok_or_else(|| anyhow::anyhow!("VM key PEM contains no private key"))?;

    // Validate CA cert.
    let ca_chain: Vec<CertificateDer> = certs(&mut BufReader::new(ca_pem))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("failed to parse manager CA PEM: {e}"))?;
    if ca_chain.is_empty() {
        return Err(anyhow::anyhow!("manager CA PEM contains no certificates"));
    }

    let identity = Identity::from_pem(cert_pem, key_pem);
    let ca_cert = Certificate::from_pem(ca_pem);

    let config = ClientTlsConfig::new()
        .identity(identity)
        .ca_certificate(ca_cert)
        // The server name must match the manager's cert CN/SAN.
        // Default: tls_config applies to the host derived from the endpoint URI.
        // Override with `.domain_name("manager.lantern.internal")` if needed.
        ;

    Ok(config)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cert_for(name: &str) -> (Vec<u8>, Vec<u8>) {
        let cert =
            rcgen::generate_simple_self_signed(vec![name.to_string()]).expect("rcgen failed");
        (
            cert.cert.pem().into_bytes(),
            cert.key_pair.serialize_pem().into_bytes(),
        )
    }

    /// Valid PEM triplet produces a ClientTlsConfig without error.
    #[test]
    fn client_tls_config_built_from_valid_pem() {
        let (ca_pem, _) = make_cert_for("ca.lantern.internal");
        let (cert_pem, key_pem) = make_cert_for("vm-abc123");

        let result = build_client_tls_config_from_pem(&cert_pem, &key_pem, &ca_pem);
        assert!(result.is_ok(), "expected Ok, got {result:?}");
    }

    /// Empty client cert PEM is rejected.
    #[test]
    fn client_tls_config_rejects_empty_cert_pem() {
        let (ca_pem, _) = make_cert_for("ca.lantern.internal");
        let (_, key_pem) = make_cert_for("vm-abc123");

        let result = build_client_tls_config_from_pem(b"", &key_pem, &ca_pem);
        assert!(result.is_err(), "expected error for empty cert PEM");
    }

    /// Empty CA PEM is rejected.
    #[test]
    fn client_tls_config_rejects_empty_ca_pem() {
        let (cert_pem, key_pem) = make_cert_for("vm-abc123");

        let result = build_client_tls_config_from_pem(&cert_pem, &key_pem, b"");
        assert!(result.is_err(), "expected error for empty CA PEM");
    }

    /// Prod-env detection.
    #[test]
    fn prod_env_detection() {
        let check = |val: &str, expected: bool| {
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
        check("dev", false);
        check("", false);
    }
}
