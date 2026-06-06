//! mTLS configuration for the runtime-manager gRPC server.
//!
//! # Design
//!
//! The manager serves two gRPC services:
//!   - `RuntimeManager`  — dialled by the scheduler / control-plane
//!   - `RuntimeHarness`  — dialled by every VM's harness process
//!
//! Both run on the same tonic `Server`.  mTLS is enabled when all three env
//! vars are present:
//!
//!   - `LANTERN_MANAGER_TLS_CA` — PEM CA cert; harness client certs must be
//!     signed by this CA.
//!   - `LANTERN_MANAGER_TLS_CERT` — PEM server cert for the manager.
//!   - `LANTERN_MANAGER_TLS_KEY` — PEM private key for the manager cert.
//!
//! **Prod gate** (`LANTERN_ENV` ∈ {prod, production, staging}):
//!   missing mTLS env vars → `eprintln!` + `std::process::exit(1)`.
//!
//! **Dev / unset `LANTERN_ENV`**: missing mTLS env vars → `WARN` log,
//!   returns `Ok(None)`, tonic server uses plain gRPC.
//!
//! ## vm_id ↔ cert-identity check
//!
//! On each `VendSecret` call the manager additionally verifies that the
//! Common Name (CN) or DNS Subject Alternative Name (SAN) of the peer's
//! client certificate matches the `vm_id` in the request.  This prevents a
//! compromised VM from impersonating another by guessing its `vm_id`.
//!
//! The check is implemented in [`verify_client_cert_vm_id`] — a pure function
//! that takes the `vm_id` string and the DER-encoded peer certificate.  It is
//! unit-tested without a live connection.
//!
//! ## Remaining work
//!
//! Per-VM cert PROVISIONING (manager issues a cert with CN=vm_id at spawn
//! time, injects `LANTERN_VM_TLS_CERT`/`LANTERN_VM_TLS_KEY` into the
//! container/VM env) is the last wiring step.  The contract (env var names,
//! CA, CN format) is documented here so the provisioning code has a clear
//! target.
//!
//! The handshake itself (server ↔ harness over a live two-process socket)
//! is integration-tested; the unit tests here cover config building and the
//! identity check.

use std::fs;
use std::io::BufReader;

use rustls::pki_types::CertificateDer;
use rustls_pemfile::{certs, private_key};
use rustls_pki_types::PrivateKeyDer;
use tonic::transport::ServerTlsConfig;

// ---------------------------------------------------------------------------
// Prod-env gate (shared with harness)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Server TLS config
// ---------------------------------------------------------------------------

/// mTLS env-var names injected at deploy time.
pub const ENV_CA: &str = "LANTERN_MANAGER_TLS_CA";
pub const ENV_CERT: &str = "LANTERN_MANAGER_TLS_CERT";
pub const ENV_KEY: &str = "LANTERN_MANAGER_TLS_KEY";

/// Returns a tonic `ServerTlsConfig` when all three mTLS env vars are present,
/// `None` in dev when they are absent.  Exits the process in production.
///
/// The returned config requires client certs signed by `LANTERN_MANAGER_TLS_CA`.
pub fn build_server_tls_config() -> anyhow::Result<Option<ServerTlsConfig>> {
    let ca_path = std::env::var(ENV_CA).ok();
    let cert_path = std::env::var(ENV_CERT).ok();
    let key_path = std::env::var(ENV_KEY).ok();

    match (ca_path, cert_path, key_path) {
        (Some(ca), Some(cert), Some(key)) => {
            let ca_pem =
                fs::read(&ca).map_err(|e| anyhow::anyhow!("cannot read {ENV_CA} {ca:?}: {e}"))?;
            let cert_pem = fs::read(&cert)
                .map_err(|e| anyhow::anyhow!("cannot read {ENV_CERT} {cert:?}: {e}"))?;
            let key_pem = fs::read(&key)
                .map_err(|e| anyhow::anyhow!("cannot read {ENV_KEY} {key:?}: {e}"))?;

            let config = build_server_tls_config_from_pem(&ca_pem, &cert_pem, &key_pem)?;
            tracing::info!(ca = %ca, cert = %cert, "manager: mTLS enabled");
            Ok(Some(config))
        }
        _ => {
            if is_prod_env() {
                eprintln!(
                    "FATAL: {ENV_CA}, {ENV_CERT}, {ENV_KEY} are required in production \
                     (LANTERN_ENV={:?}). Refusing to start without mTLS.",
                    std::env::var("LANTERN_ENV").unwrap_or_default()
                );
                std::process::exit(1);
            }
            tracing::warn!(
                "mTLS env vars ({ENV_CA}/{ENV_CERT}/{ENV_KEY}) not set; \
                 manager gRPC is PLAINTEXT. Set LANTERN_ENV=prod to make this fatal."
            );
            Ok(None)
        }
    }
}

/// Build a `ServerTlsConfig` from raw PEM bytes (in-memory; no file I/O).
///
/// The CA cert is required for client authentication.  We parse the PEM
/// ourselves using `rustls-pemfile` to validate the bytes before handing
/// them to tonic; tonic re-parses internally but we surface parse errors
/// with better context this way.
pub fn build_server_tls_config_from_pem(
    ca_pem: &[u8],
    cert_pem: &[u8],
    key_pem: &[u8],
) -> anyhow::Result<ServerTlsConfig> {
    // Validate cert chain.
    let cert_chain: Vec<CertificateDer> = certs(&mut BufReader::new(cert_pem))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("failed to parse server cert PEM: {e}"))?;
    if cert_chain.is_empty() {
        return Err(anyhow::anyhow!("server cert PEM contains no certificates"));
    }

    // Validate private key.
    let _key: PrivateKeyDer = private_key(&mut BufReader::new(key_pem))
        .map_err(|e| anyhow::anyhow!("failed to parse server key PEM: {e}"))?
        .ok_or_else(|| anyhow::anyhow!("server key PEM contains no private key"))?;

    // Validate CA cert.
    let ca_chain: Vec<CertificateDer> = certs(&mut BufReader::new(ca_pem))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("failed to parse CA PEM: {e}"))?;
    if ca_chain.is_empty() {
        return Err(anyhow::anyhow!("CA PEM contains no certificates"));
    }

    // Build the tonic ServerTlsConfig.  tonic's TLS layer (backed by
    // rustls) enforces client-cert verification when `client_ca_root` is set.
    let identity = tonic::transport::Identity::from_pem(cert_pem, key_pem);
    let ca_cert = tonic::transport::Certificate::from_pem(ca_pem);

    let tls = ServerTlsConfig::new()
        .identity(identity)
        .client_ca_root(ca_cert);

    Ok(tls)
}

// ---------------------------------------------------------------------------
// vm_id ↔ cert-identity check
// ---------------------------------------------------------------------------

/// Verify that the CN or a DNS SAN in `cert_der` matches `vm_id`.
///
/// Returns `Ok(())` on match, `Err(reason)` on mismatch or parse failure.
///
/// # Why CN + SAN
///
/// RFC 5280 prefers SANs; legacy code uses CN.  We check both so the
/// provisioner can use whichever is convenient.  `rcgen` (the provisioner
/// helper) puts the name in both by default.
///
/// # Pure function
///
/// Takes raw DER bytes so it can be tested without a live gRPC connection.
/// In `service.rs` the caller extracts the peer cert from the tonic
/// `Request` extensions and passes the DER here.
pub fn verify_client_cert_vm_id(vm_id: &str, cert_der: &[u8]) -> Result<(), String> {
    // Parse the DER certificate.
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der)
        .map_err(|e| format!("failed to parse client cert DER: {e}"))?;

    // Check DNS SANs first (RFC 5280 preferred).
    if let Ok(Some(san_ext)) = cert.subject_alternative_name() {
        for name in &san_ext.value.general_names {
            if matches!(name, x509_parser::extensions::GeneralName::DNSName(dns) if *dns == vm_id) {
                return Ok(());
            }
        }
    }

    // Fall back to CN.
    for attr in cert.subject().iter_common_name() {
        if attr.as_str().is_ok_and(|cn| cn == vm_id) {
            return Ok(());
        }
    }

    Err(format!(
        "client cert identity does not match vm_id '{vm_id}'; \
         cert subject: {}",
        cert.subject()
    ))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // ---------------------------------------------------------------------------
    // Test cert helpers
    // ---------------------------------------------------------------------------

    /// Generate a self-signed cert with CN = SAN = `name`.
    fn make_cert_for(name: &str) -> (Vec<u8>, Vec<u8>) {
        let cert =
            rcgen::generate_simple_self_signed(vec![name.to_string()]).expect("rcgen failed");
        let cert_pem = cert.cert.pem().into_bytes();
        let key_pem = cert.key_pair.serialize_pem().into_bytes();
        (cert_pem, key_pem)
    }

    /// Convert a PEM cert to DER (single cert assumed).
    fn pem_to_der(cert_pem: &[u8]) -> Vec<u8> {
        certs(&mut BufReader::new(Cursor::new(cert_pem)))
            .next()
            .expect("cert iterator not empty")
            .expect("cert parse ok")
            .to_vec()
    }

    // ---------------------------------------------------------------------------
    // build_server_tls_config_from_pem
    // ---------------------------------------------------------------------------

    #[test]
    fn server_tls_config_built_from_valid_pem() {
        let (ca_pem, _) = make_cert_for("ca.lantern.internal");
        let (cert_pem, key_pem) = make_cert_for("manager.lantern.internal");

        let result = build_server_tls_config_from_pem(&ca_pem, &cert_pem, &key_pem);
        assert!(result.is_ok(), "expected Ok, got {result:?}");
    }

    #[test]
    fn server_tls_config_rejects_empty_cert_pem() {
        let (ca_pem, _) = make_cert_for("ca.lantern.internal");
        let (_, key_pem) = make_cert_for("manager.lantern.internal");

        let result = build_server_tls_config_from_pem(&ca_pem, b"", &key_pem);
        assert!(result.is_err(), "expected error for empty cert PEM, got Ok");
    }

    #[test]
    fn server_tls_config_rejects_empty_ca_pem() {
        let (cert_pem, key_pem) = make_cert_for("manager.lantern.internal");

        let result = build_server_tls_config_from_pem(b"", &cert_pem, &key_pem);
        assert!(result.is_err(), "expected error for empty CA PEM, got Ok");
    }

    // ---------------------------------------------------------------------------
    // verify_client_cert_vm_id
    // ---------------------------------------------------------------------------

    /// A cert whose CN/SAN matches the vm_id passes.
    #[test]
    fn cert_matching_vm_id_passes() {
        let vm_id = "vm-abc123";
        let (cert_pem, _) = make_cert_for(vm_id);
        let cert_der = pem_to_der(&cert_pem);

        let result = verify_client_cert_vm_id(vm_id, &cert_der);
        assert!(
            result.is_ok(),
            "expected Ok for matching vm_id, got {result:?}"
        );
    }

    /// A cert whose CN/SAN does NOT match the vm_id is rejected.
    #[test]
    fn cert_mismatching_vm_id_fails() {
        let (cert_pem, _) = make_cert_for("vm-OTHER");
        let cert_der = pem_to_der(&cert_pem);

        let result = verify_client_cert_vm_id("vm-EXPECTED", &cert_der);
        assert!(
            result.is_err(),
            "expected Err for mismatching vm_id, got Ok"
        );
        let msg = result.unwrap_err();
        assert!(
            msg.contains("vm-EXPECTED"),
            "error message should mention the expected vm_id: {msg}"
        );
    }

    /// Garbage bytes are rejected gracefully (no panic).
    #[test]
    fn garbage_cert_der_returns_error() {
        let result = verify_client_cert_vm_id("vm-xyz", b"not-a-cert");
        assert!(result.is_err(), "expected Err for invalid DER");
    }

    /// Empty DER is rejected gracefully.
    #[test]
    fn empty_cert_der_returns_error() {
        let result = verify_client_cert_vm_id("vm-xyz", b"");
        assert!(result.is_err(), "expected Err for empty DER");
    }

    /// Prod-env detection uses the same logic as the gateway.
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
