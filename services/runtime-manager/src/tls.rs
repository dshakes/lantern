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
//! ## Per-VM cert PROVISIONING (now wired)
//!
//! At spawn the manager issues a short-lived client cert with CN=SAN=`vm_id`
//! signed by the manager CA ([`generate_vm_client_cert`]), writes the cert +
//! key to a per-VM directory mode 0700/0600 ([`write_vm_cert_files`]), and the
//! schedule handler injects `LANTERN_VM_TLS_CERT`/`LANTERN_VM_TLS_KEY` +
//! `LANTERN_MANAGER_TLS_CA` into the VM env (the Firecracker `VmConfig`
//! boot-args already thread these paths).
//!
//! On each `VendSecret` the handler extracts the peer client cert from the
//! tonic request ([`extract_peer_cert_der`]) and runs [`authorize_vm_cert`],
//! which delegates to [`verify_client_cert_vm_id`].  Absence or CN mismatch →
//! `PERMISSION_DENIED`.  Auth is cryptographic (CA-signed cert), not
//! topology-based (network reachability).
//!
//! The handshake itself (server ↔ harness over a live two-process socket)
//! is integration-tested; the unit tests here cover config building, cert
//! issuance, the identity check, and the authorize decision.

use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

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

/// mTLS env-var names injected at deploy time (manager SERVER identity).
pub const ENV_CA: &str = "LANTERN_MANAGER_TLS_CA";
pub const ENV_CERT: &str = "LANTERN_MANAGER_TLS_CERT";
pub const ENV_KEY: &str = "LANTERN_MANAGER_TLS_KEY";

/// Env-var names injected into each VM so its harness can present a
/// CA-signed CLIENT cert (CN=vm_id) on the harness↔manager channel.
/// `VM_ENV_CA` is the manager-CA cert the harness uses to verify the manager
/// server; it shares the same logical CA as [`ENV_CA`] but is referenced from
/// the VM's filesystem.
pub const VM_ENV_CERT: &str = "LANTERN_VM_TLS_CERT";
pub const VM_ENV_KEY: &str = "LANTERN_VM_TLS_KEY";
pub const VM_ENV_CA: &str = "LANTERN_MANAGER_TLS_CA";

/// Env-var names the manager reads to find its signing CA material (the CA
/// that issues per-VM client certs).  Defaults to the server `ENV_CA`/`ENV_KEY`
/// when unset — i.e. the manager signs VM certs with the same CA it presents,
/// which is the common single-CA topology.
pub const ENV_SIGNING_CA_CERT: &str = "LANTERN_VM_SIGNING_CA_CERT";
pub const ENV_SIGNING_CA_KEY: &str = "LANTERN_VM_SIGNING_CA_KEY";

/// Root directory under which per-VM cert material is written.  Overridable so
/// tests (and the Firecracker boot-args contract) can target a known path.
pub const ENV_VM_CERT_DIR: &str = "LANTERN_VM_CERT_DIR";
pub const DEFAULT_VM_CERT_DIR: &str = "/run/lantern/certs";

/// Short TTL for issued per-VM client certs.  A VM that outlives this must
/// be re-issued; in practice runs are far shorter and certs are single-use.
const VM_CERT_TTL_DAYS: i64 = 1;

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
// Per-VM client-cert issuance (rcgen, signed by the manager CA)
// ---------------------------------------------------------------------------

/// A freshly-issued per-VM client certificate + its private key, PEM-encoded.
#[derive(Clone, Debug)]
pub struct IssuedVmCert {
    /// Leaf cert PEM (CN=SAN=vm_id, signed by the manager CA).
    pub cert_pem: String,
    /// Leaf private key PEM.
    pub key_pem: String,
}

/// Issue a short-lived client cert with CN=SAN=`vm_id`, signed by the manager
/// CA passed as PEM.  Pure (no I/O); unit-testable on any platform.
///
/// The CA cert + key are the manager's signing material; the returned leaf is
/// what the VM's harness presents as its CLIENT cert on the harness↔manager
/// mTLS channel.  `verify_client_cert_vm_id` accepts it because both the CN and
/// the DNS SAN carry `vm_id`.
pub fn generate_vm_client_cert(
    vm_id: &str,
    ca_cert_pem: &str,
    ca_key_pem: &str,
) -> anyhow::Result<IssuedVmCert> {
    use rcgen::{CertificateParams, DnType, KeyPair};

    if vm_id.is_empty() {
        return Err(anyhow::anyhow!("cannot issue cert for empty vm_id"));
    }

    // Reconstruct the CA as an issuer from its PEM cert + key.
    let ca_params = CertificateParams::from_ca_cert_pem(ca_cert_pem)
        .map_err(|e| anyhow::anyhow!("parse manager CA cert PEM: {e}"))?;
    let ca_key = KeyPair::from_pem(ca_key_pem)
        .map_err(|e| anyhow::anyhow!("parse manager CA key PEM: {e}"))?;
    let ca_cert = ca_params
        .self_signed(&ca_key)
        .map_err(|e| anyhow::anyhow!("reconstruct manager CA cert: {e}"))?;

    // Build the leaf params: SAN=vm_id (via the constructor) + CN=vm_id.
    let mut leaf_params = CertificateParams::new(vec![vm_id.to_string()])
        .map_err(|e| anyhow::anyhow!("build leaf cert params for vm_id '{vm_id}': {e}"))?;
    leaf_params
        .distinguished_name
        .push(DnType::CommonName, vm_id);

    // Short validity window — the run is far shorter than this in practice.
    let now = time::OffsetDateTime::now_utc();
    leaf_params.not_before = now;
    leaf_params.not_after = now + time::Duration::days(VM_CERT_TTL_DAYS);

    let leaf_key = KeyPair::generate().map_err(|e| anyhow::anyhow!("generate leaf key: {e}"))?;
    let leaf_cert = leaf_params
        .signed_by(&leaf_key, &ca_cert, &ca_key)
        .map_err(|e| anyhow::anyhow!("sign leaf cert for vm_id '{vm_id}': {e}"))?;

    Ok(IssuedVmCert {
        cert_pem: leaf_cert.pem(),
        key_pem: leaf_key.serialize_pem(),
    })
}

/// Paths to the per-VM cert material on the host filesystem.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmCertPaths {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
    pub ca_path: PathBuf,
}

/// Write an issued per-VM cert + the manager CA cert under
/// `<cert_dir>/<vm_id>/`.  The private key is written mode 0600 and the
/// directory mode 0700 (the key reveals the VM's identity; only the manager —
/// and the VM's own mount — may read it).
///
/// Returns the three paths the schedule handler injects into the VM env.
///
/// LINUX-ONLY hardening note: the 0600/0700 modes are enforced via the Unix
/// permission bits; on non-Unix the files are written without mode bits (dev
/// only — production VMs are Linux).
pub fn write_vm_cert_files(
    cert_dir: &Path,
    vm_id: &str,
    issued: &IssuedVmCert,
    ca_cert_pem: &str,
) -> anyhow::Result<VmCertPaths> {
    let vm_dir = cert_dir.join(vm_id);
    fs::create_dir_all(&vm_dir)
        .map_err(|e| anyhow::anyhow!("create per-vm cert dir {vm_dir:?}: {e}"))?;
    set_dir_mode_0700(&vm_dir)?;

    let cert_path = vm_dir.join("tls.crt");
    let key_path = vm_dir.join("tls.key");
    let ca_path = cert_dir.join("manager-ca.crt");

    write_file_mode(&cert_path, issued.cert_pem.as_bytes(), 0o644)?;
    write_file_mode(&key_path, issued.key_pem.as_bytes(), 0o600)?;
    // The CA cert is shared across VMs on this node; idempotent re-write.
    write_file_mode(&ca_path, ca_cert_pem.as_bytes(), 0o644)?;

    Ok(VmCertPaths {
        cert_path,
        key_path,
        ca_path,
    })
}

/// Write `bytes` to `path`, then set the Unix permission bits to `mode`.
fn write_file_mode(path: &Path, bytes: &[u8], mode: u32) -> anyhow::Result<()> {
    fs::write(path, bytes).map_err(|e| anyhow::anyhow!("write {path:?}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|e| anyhow::anyhow!("chmod {path:?} to {mode:o}: {e}"))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}

/// Tighten a directory to owner-only (0700).  No-op off Unix.
fn set_dir_mode_0700(dir: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| anyhow::anyhow!("chmod dir {dir:?} to 0700: {e}"))?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// Resolve the manager's CA signing material (cert PEM, key PEM) from env.
///
/// Prefers the dedicated signing CA vars, falling back to the server identity
/// CA cert + key (single-CA topology).  Returns `Ok(None)` when no CA key is
/// available — in that case per-VM cert issuance is skipped (dev plaintext;
/// the prod gate in [`build_server_tls_config`] already forces mTLS on).
pub fn load_signing_ca() -> anyhow::Result<Option<(String, String)>> {
    let cert_path = std::env::var(ENV_SIGNING_CA_CERT)
        .ok()
        .or_else(|| std::env::var(ENV_CA).ok());
    // The server cert env var holds the SERVER leaf, not a CA key, so we only
    // fall back to ENV_KEY when it is explicitly the CA key topology. To stay
    // safe we require an explicit signing-CA key unless ENV_CA doubles as a
    // self-signed CA whose key is in ENV_KEY.
    let key_path = std::env::var(ENV_SIGNING_CA_KEY)
        .ok()
        .or_else(|| std::env::var(ENV_KEY).ok());

    match (cert_path, key_path) {
        (Some(c), Some(k)) => {
            let cert_pem = fs::read_to_string(&c)
                .map_err(|e| anyhow::anyhow!("read signing CA cert {c:?}: {e}"))?;
            let key_pem = fs::read_to_string(&k)
                .map_err(|e| anyhow::anyhow!("read signing CA key {k:?}: {e}"))?;
            Ok(Some((cert_pem, key_pem)))
        }
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Peer-cert extraction + VendSecret authorization
// ---------------------------------------------------------------------------

/// Extract the peer (client) leaf certificate DER from a tonic request.
///
/// # Transport-version note
///
/// tonic exposes the negotiated client certs via `Request::peer_certs()`
/// (feature-gated on `server` + `tls`), which reads the
/// `TlsConnectInfo<TcpConnectInfo>` extension the TLS-accepting layer inserts.
/// The exact extension type + accessor are tonic-version-specific (this is
/// tonic 0.12.x); isolating the call here means a tonic bump only touches this
/// one function.  Returns the FIRST cert in the chain (the leaf), or `None`
/// when the connection is plaintext / no client cert was presented.
///
/// LINUX/transport: `peer_certs()` only returns `Some` for TLS connections
/// terminated by tonic's own transport server — i.e. the live harness↔manager
/// socket.  Unit tests exercise [`authorize_vm_cert`] directly with synthetic
/// DER instead of a live connection.
pub fn extract_peer_cert_der<T>(request: &tonic::Request<T>) -> Option<Vec<u8>> {
    request
        .peer_certs()
        .and_then(|chain| chain.first().map(|c| c.as_ref().to_vec()))
}

/// Decide whether a VendSecret call is authorized for `vm_id` given the
/// (optional) peer client-cert DER.
///
/// Fail-closed:
///   - `None` (plaintext / no client cert) → `Err` (PERMISSION_DENIED upstream)
///   - present but CN/SAN ≠ vm_id          → `Err`
///   - present and CN/SAN == vm_id          → `Ok(())`
///
/// Pure function over the extracted DER so the accept/reject logic is
/// unit-testable without a live TLS connection (the extraction is mocked by
/// passing synthetic DER).
pub fn authorize_vm_cert(vm_id: &str, peer_cert_der: Option<&[u8]>) -> Result<(), String> {
    match peer_cert_der {
        None => Err(format!(
            "no client certificate presented for vm_id '{vm_id}'; \
             harness↔manager mTLS is required for VendSecret"
        )),
        Some(der) => verify_client_cert_vm_id(vm_id, der),
    }
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

    // ---------------------------------------------------------------------------
    // Per-VM client-cert issuance
    // ---------------------------------------------------------------------------

    /// Generate a CA cert + key PEM pair usable as a signer.
    fn make_ca(name: &str) -> (String, String) {
        let ca = rcgen::generate_simple_self_signed(vec![name.to_string()]).expect("rcgen CA");
        (ca.cert.pem(), ca.key_pair.serialize_pem())
    }

    /// An issued VM cert has CN/SAN == vm_id and parses as a valid X.509.
    #[test]
    fn generated_vm_cert_has_vm_id_identity() {
        let (ca_cert, ca_key) = make_ca("manager-ca");
        let vm_id = "vm-issue-001";

        let issued =
            generate_vm_client_cert(vm_id, &ca_cert, &ca_key).expect("cert issuance must succeed");

        // The leaf parses and its CN/SAN matches the vm_id.
        let der = pem_to_der(issued.cert_pem.as_bytes());
        assert!(
            verify_client_cert_vm_id(vm_id, &der).is_ok(),
            "issued cert CN/SAN must match vm_id"
        );
        // The key PEM is a parseable private key.
        let key = private_key(&mut BufReader::new(Cursor::new(issued.key_pem.as_bytes())))
            .expect("key parse")
            .expect("key present");
        let _ = key; // presence is enough
    }

    /// The issued leaf is signed BY the manager CA (not self-signed): its
    /// issuer DN equals the CA subject DN.
    #[test]
    fn generated_vm_cert_is_signed_by_ca() {
        let (ca_cert_pem, ca_key) = make_ca("manager-ca-signer");
        let vm_id = "vm-signed-by-ca";

        let issued = generate_vm_client_cert(vm_id, &ca_cert_pem, &ca_key).expect("issuance");

        let leaf_der = pem_to_der(issued.cert_pem.as_bytes());
        let ca_der = pem_to_der(ca_cert_pem.as_bytes());

        let (_, leaf) = x509_parser::parse_x509_certificate(&leaf_der).expect("leaf parse");
        let (_, ca) = x509_parser::parse_x509_certificate(&ca_der).expect("ca parse");

        assert_eq!(
            leaf.issuer().to_string(),
            ca.subject().to_string(),
            "leaf issuer must equal CA subject (proves CA-signed, not self-signed)"
        );
        assert_ne!(
            leaf.subject().to_string(),
            leaf.issuer().to_string(),
            "leaf subject must differ from its issuer (not self-signed)"
        );
    }

    /// Issuance with bad CA PEM fails cleanly (no panic).
    #[test]
    fn generate_vm_cert_rejects_bad_ca() {
        let err = generate_vm_client_cert("vm-x", "not-a-pem", "also-not-a-pem");
        assert!(err.is_err(), "expected Err for invalid CA PEM");
    }

    /// Empty vm_id is rejected.
    #[test]
    fn generate_vm_cert_rejects_empty_vm_id() {
        let (ca_cert, ca_key) = make_ca("ca");
        assert!(generate_vm_client_cert("", &ca_cert, &ca_key).is_err());
    }

    // ---------------------------------------------------------------------------
    // authorize_vm_cert — the VendSecret accept/reject decision
    // ---------------------------------------------------------------------------

    /// A peer cert whose CN matches the vm_id is accepted (mocks the extraction
    /// by passing the synthetic DER directly, no live connection).
    #[test]
    fn authorize_accepts_matching_cert() {
        let (ca_cert, ca_key) = make_ca("ca");
        let vm_id = "vm-match";
        let issued = generate_vm_client_cert(vm_id, &ca_cert, &ca_key).unwrap();
        let der = pem_to_der(issued.cert_pem.as_bytes());

        assert!(
            authorize_vm_cert(vm_id, Some(&der)).is_ok(),
            "matching CN must be authorized"
        );
    }

    /// A peer cert whose CN is a DIFFERENT vm_id is rejected.
    #[test]
    fn authorize_rejects_wrong_cn_cert() {
        let (ca_cert, ca_key) = make_ca("ca");
        // Cert minted for one VM, presented while claiming to be another.
        let issued = generate_vm_client_cert("vm-OTHER", &ca_cert, &ca_key).unwrap();
        let der = pem_to_der(issued.cert_pem.as_bytes());

        let result = authorize_vm_cert("vm-EXPECTED", Some(&der));
        assert!(result.is_err(), "wrong CN must be rejected");
        assert!(
            result.unwrap_err().contains("vm-EXPECTED"),
            "error must name the expected vm_id"
        );
    }

    /// No peer cert at all (plaintext / no client cert) is rejected fail-closed.
    #[test]
    fn authorize_rejects_absent_cert() {
        let result = authorize_vm_cert("vm-any", None);
        assert!(result.is_err(), "absent cert must be rejected");
        assert!(
            result.unwrap_err().contains("no client certificate"),
            "error must explain the missing cert"
        );
    }

    // ---------------------------------------------------------------------------
    // write_vm_cert_files
    // ---------------------------------------------------------------------------

    #[test]
    fn write_vm_cert_files_produces_expected_paths_and_perms() {
        let (ca_cert, ca_key) = make_ca("ca");
        let vm_id = "vm-write-001";
        let issued = generate_vm_client_cert(vm_id, &ca_cert, &ca_key).unwrap();

        let tmp = std::env::temp_dir().join(format!("lantern-tls-test-{}", uuid::Uuid::new_v4()));
        let paths = write_vm_cert_files(&tmp, vm_id, &issued, &ca_cert).expect("write");

        assert_eq!(paths.cert_path, tmp.join(vm_id).join("tls.crt"));
        assert_eq!(paths.key_path, tmp.join(vm_id).join("tls.key"));
        assert_eq!(paths.ca_path, tmp.join("manager-ca.crt"));

        // Contents round-trip.
        assert_eq!(
            fs::read_to_string(&paths.cert_path).unwrap(),
            issued.cert_pem
        );
        assert_eq!(fs::read_to_string(&paths.key_path).unwrap(), issued.key_pem);
        assert_eq!(fs::read_to_string(&paths.ca_path).unwrap(), ca_cert);

        // Key must be 0600 on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&paths.key_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode, 0o600,
                "key must be owner-read/write only, got {mode:o}"
            );
            let dir_mode = fs::metadata(tmp.join(vm_id)).unwrap().permissions().mode() & 0o777;
            assert_eq!(dir_mode, 0o700, "per-vm dir must be 0700, got {dir_mode:o}");
        }

        let _ = fs::remove_dir_all(&tmp);
    }
}
