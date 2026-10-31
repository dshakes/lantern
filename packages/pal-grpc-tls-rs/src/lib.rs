//! Service-mesh mTLS for PAL's internal gRPC hops (ADR 0043) — the Rust twin
//! of Go `packages/grpctls`. Same env, same policy:
//!
//!   - `PAL_GRPC_TLS_CA` / `_CERT` / `_KEY` — the service CA and this process's
//!     identity (one cert, serverAuth + clientAuth). Servers REQUIRE and verify a
//!     client cert; clients pin the CA (no system roots) and present the cert.
//!   - `PAL_GRPC_TLS_ALLOWED_PEERS` — comma-separated SPIFFE IDs a server
//!     accepts (URI SAN, checked per request by [`peer_interceptor`]).
//!   - `PAL_GRPC_INSECURE=1` — the only way a prod-like env runs plaintext.
//!   - A per-VM guest cert (OU `pal-vm`) is never accepted as a service.
//!
//! Reads are plain `std::env::var` lookups of the `PAL_*` names.

use tonic::transport::{Certificate, ClientTlsConfig, Endpoint, Identity, ServerTlsConfig};
use tonic::{Request, Status};
use x509_parser::extensions::GeneralName;

/// OU stamped on per-VM guest certs by the runtime-manager (`VM_CERT_OU`).
pub const VM_CERT_OU: &str = "pal-vm";

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// `PAL_ENV` ∈ {prod, production, staging}.
pub fn is_prod() -> bool {
    var("PAL_ENV").is_some_and(|v| {
        matches!(
            v.to_ascii_lowercase().as_str(),
            "prod" | "production" | "staging"
        )
    })
}

/// `PAL_GRPC_INSECURE` ∈ {1, true, on}.
pub fn insecure_override() -> bool {
    var("PAL_GRPC_INSECURE")
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "on"))
}

/// Comma-separated `PAL_GRPC_TLS_ALLOWED_PEERS`.
pub fn allowed_peers() -> Vec<String> {
    var("PAL_GRPC_TLS_ALLOWED_PEERS")
        .map(|v| {
            v.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// A PEM triplet (paths).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Files {
    pub ca: Option<String>,
    pub cert: Option<String>,
    pub key: Option<String>,
}

impl Files {
    /// `PAL_GRPC_TLS_CA` / `_CERT` / `_KEY`.
    pub fn from_env() -> Self {
        Self {
            ca: var("PAL_GRPC_TLS_CA"),
            cert: var("PAL_GRPC_TLS_CERT"),
            key: var("PAL_GRPC_TLS_KEY"),
        }
    }

    fn is_empty(&self) -> bool {
        self.ca.is_none() && self.cert.is_none() && self.key.is_none()
    }
}

/// Install `ring` as the process-wide rustls provider (idempotent). Without
/// it, a binary that links both `ring` and `aws-lc-rs` panics at the first
/// handshake ("Could not automatically determine the process-level
/// CryptoProvider") — observed live in the gateway.
fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn read(path: &str, name: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| anyhow::anyhow!("cannot read {name} {path:?}: {e}"))
}

fn read_ca(path: &str) -> anyhow::Result<Certificate> {
    let pem = read(path, "PAL_GRPC_TLS_CA")?;
    if !String::from_utf8_lossy(&pem).contains("-----BEGIN CERTIFICATE-----") {
        anyhow::bail!("PAL_GRPC_TLS_CA {path:?} contains no PEM certificate");
    }
    Ok(Certificate::from_pem(pem))
}

fn plaintext_refused() -> anyhow::Error {
    anyhow::anyhow!(
        "PAL_GRPC_TLS_CA/_CERT/_KEY are unset in a production-like env; refusing plaintext \
         gRPC. Mount the service cert (ADR 0043), or set PAL_GRPC_INSECURE=1 to accept \
         plaintext explicitly"
    )
}

/// Server config: `Ok(None)` = plaintext (dev, or prod with `allow_insecure`).
/// Prod without TLS, half config or unreadable files are errors. A client
/// certificate signed by the CA is mandatory at the handshake.
pub fn server_tls(
    files: &Files,
    is_prod: bool,
    allow_insecure: bool,
) -> anyhow::Result<Option<ServerTlsConfig>> {
    if files.is_empty() {
        if is_prod && !allow_insecure {
            return Err(plaintext_refused());
        }
        return Ok(None);
    }
    ensure_crypto_provider();
    let (Some(ca), Some(cert), Some(key)) = (&files.ca, &files.cert, &files.key) else {
        anyhow::bail!(
            "gRPC server TLS is half-configured: set all of PAL_GRPC_TLS_CA, PAL_GRPC_TLS_CERT, \
             PAL_GRPC_TLS_KEY (or none)"
        );
    };
    Ok(Some(
        ServerTlsConfig::new()
            .identity(Identity::from_pem(
                read(cert, "PAL_GRPC_TLS_CERT")?,
                read(key, "PAL_GRPC_TLS_KEY")?,
            ))
            .client_ca_root(read_ca(ca)?)
            .client_auth_optional(false),
    ))
}

/// Client config: `Ok(None)` = plaintext (dev, or prod with `allow_insecure`).
/// In prod a client cert is mandatory (every service-mesh server demands one).
pub fn client_tls(
    files: &Files,
    is_prod: bool,
    allow_insecure: bool,
) -> anyhow::Result<Option<ClientTlsConfig>> {
    if files.cert.is_some() != files.key.is_some() {
        anyhow::bail!(
            "gRPC client TLS is half-configured: set BOTH PAL_GRPC_TLS_CERT and PAL_GRPC_TLS_KEY (or neither)"
        );
    }
    let Some(ca) = &files.ca else {
        if files.cert.is_some() {
            anyhow::bail!(
                "PAL_GRPC_TLS_CERT is set without PAL_GRPC_TLS_CA — refusing to dial without pinning the server CA"
            );
        }
        if is_prod && !allow_insecure {
            return Err(plaintext_refused());
        }
        return Ok(None);
    };
    if is_prod && files.cert.is_none() {
        anyhow::bail!(
            "PAL_GRPC_TLS_CERT/_KEY are unset — service-mesh servers verify client certificates in production; set both"
        );
    }
    ensure_crypto_provider();
    let mut tls = ClientTlsConfig::new().ca_certificate(read_ca(ca)?);
    if let (Some(cert), Some(key)) = (&files.cert, &files.key) {
        tls = tls.identity(Identity::from_pem(
            read(cert, "PAL_GRPC_TLS_CERT")?,
            read(key, "PAL_GRPC_TLS_KEY")?,
        ));
    }
    Ok(Some(tls))
}

/// Build an endpoint for `addr` (`host:port`, `http://…` or `https://…`).
/// The scheme is forced to match `tls`: tonic silently skips TLS for an
/// `http://` URI even with a TLS config set, and refuses `https://` without one.
pub fn endpoint(addr: &str, tls: Option<ClientTlsConfig>) -> anyhow::Result<Endpoint> {
    let host = addr
        .strip_prefix("https://")
        .or_else(|| addr.strip_prefix("http://"))
        .unwrap_or(addr);
    let scheme = if tls.is_some() { "https" } else { "http" };
    let ep = Endpoint::from_shared(format!("{scheme}://{host}"))
        .map_err(|e| anyhow::anyhow!("invalid gRPC address {addr:?}: {e}"))?;
    Ok(match tls {
        Some(t) => ep.tls_config(t)?,
        None => ep,
    })
}

/// Authorize a CA-verified peer leaf (DER): never a VM guest cert; with an
/// allowlist, one of its URI SANs must be listed.
pub fn check_peer(der: &[u8], allowed: &[String]) -> Result<(), String> {
    let (_, cert) = x509_parser::parse_x509_certificate(der)
        .map_err(|e| format!("unparseable peer cert: {e}"))?;
    if cert
        .subject()
        .iter_organizational_unit()
        .any(|ou| ou.as_str().is_ok_and(|v| v == VM_CERT_OU))
    {
        return Err("peer presented a VM guest certificate; services only".into());
    }
    if allowed.is_empty() {
        return Ok(());
    }
    let uris: Vec<&str> = match cert.subject_alternative_name() {
        Ok(Some(san)) => san
            .value
            .general_names
            .iter()
            .filter_map(|n| match n {
                GeneralName::URI(u) => Some(*u),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    if uris.iter().any(|u| allowed.iter().any(|a| a == u)) {
        Ok(())
    } else {
        Err(format!("peer identity {uris:?} is not in the allowlist"))
    }
}

/// Per-request identity gate for an mTLS server. tonic has verified the chain
/// at the handshake; this checks WHO the peer is. Install it only when TLS is on.
#[allow(clippy::result_large_err)] // tonic::Status is the mandated interceptor error type
pub fn peer_interceptor(
    allowed: Vec<String>,
) -> impl Fn(Request<()>) -> Result<Request<()>, Status> + Clone {
    move |req: Request<()>| {
        let certs = req.peer_certs();
        let Some(leaf) = certs.as_ref().and_then(|c| c.first()) else {
            return Err(Status::unauthenticated("client certificate required"));
        };
        match check_peer(leaf.as_ref(), &allowed) {
            Ok(()) => Ok(req),
            Err(why) => {
                tracing::warn!(reason = %why, "mTLS: peer refused");
                Err(Status::permission_denied("peer identity not allowed"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{
        BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
        SanType,
    };

    const GW: &str = "spiffe://pal.internal/svc/gateway";

    fn leaf_der(spiffe: Option<&str>, ou: Option<&str>) -> Vec<u8> {
        let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca_key = KeyPair::generate().unwrap();
        let ca_cert = ca.self_signed(&ca_key).unwrap();
        let mut p = CertificateParams::new(vec!["localhost".to_string()]).unwrap();
        if let Some(s) = spiffe {
            p.subject_alt_names
                .push(SanType::URI(s.try_into().unwrap()));
        }
        if let Some(o) = ou {
            p.distinguished_name.push(DnType::OrganizationalUnitName, o);
        }
        p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        let key = KeyPair::generate().unwrap();
        let pem = p.signed_by(&key, &ca_cert, &ca_key).unwrap().pem();
        rustls_pemfile::certs(&mut pem.as_bytes())
            .next()
            .unwrap()
            .unwrap()
            .to_vec()
    }

    #[test]
    fn check_peer_rules() {
        let allow = vec![GW.to_string()];
        assert!(check_peer(&leaf_der(Some(GW), None), &allow).is_ok());
        assert!(
            check_peer(
                &leaf_der(Some("spiffe://pal.internal/svc/dashboard"), None),
                &allow
            )
            .is_err(),
            "wrong SAN"
        );
        assert!(check_peer(&leaf_der(None, None), &allow).is_err(), "no SAN");
        assert!(
            check_peer(&leaf_der(None, None), &[]).is_ok(),
            "no allowlist"
        );
        assert!(
            check_peer(&leaf_der(None, Some(VM_CERT_OU)), &[]).is_err(),
            "VM cert always refused"
        );
        assert!(check_peer(b"garbage", &[]).is_err());
    }

    #[test]
    fn server_policy() {
        let none = Files::default();
        assert!(
            server_tls(&none, false, false).unwrap().is_none(),
            "dev → plaintext"
        );
        assert!(server_tls(&none, true, false).is_err(), "prod → refuse");
        assert!(
            server_tls(&none, true, true).unwrap().is_none(),
            "prod + override"
        );
        let half = Files {
            ca: Some("/x".into()),
            ..Default::default()
        };
        assert!(server_tls(&half, false, false).is_err(), "half");
        let missing = Files {
            ca: Some("/nonexistent/ca".into()),
            cert: Some("/nonexistent/c".into()),
            key: Some("/nonexistent/k".into()),
        };
        assert!(server_tls(&missing, false, false).is_err(), "unreadable");
    }

    #[test]
    fn client_policy() {
        let none = Files::default();
        assert!(client_tls(&none, false, false).unwrap().is_none());
        assert!(client_tls(&none, true, false).is_err());
        assert!(client_tls(&none, true, true).unwrap().is_none());
        let cert_only = Files {
            cert: Some("/c".into()),
            key: Some("/k".into()),
            ..Default::default()
        };
        assert!(
            client_tls(&cert_only, false, false).is_err(),
            "cert without CA"
        );
        let half = Files {
            ca: Some("/ca".into()),
            cert: Some("/c".into()),
            ..Default::default()
        };
        assert!(client_tls(&half, false, false).is_err(), "cert without key");
        let ca_only = Files {
            ca: Some("/ca".into()),
            ..Default::default()
        };
        assert!(
            client_tls(&ca_only, true, false).is_err(),
            "prod needs a client cert"
        );
    }

    #[test]
    fn endpoint_scheme_follows_tls() {
        for addr in ["cp:50051", "http://cp:50051", "https://cp:50051"] {
            assert_eq!(
                endpoint(addr, None).unwrap().uri().scheme_str(),
                Some("http")
            );
            let ep = endpoint(addr, Some(ClientTlsConfig::new())).unwrap();
            assert_eq!(ep.uri().scheme_str(), Some("https"), "{addr}");
            assert_eq!(ep.uri().host(), Some("cp"));
        }
    }
}
