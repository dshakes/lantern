//! Live mTLS handshake tests for :50053 (ADR 0043): the real server stack
//! (TLS + `pal_grpc_tls::peer_interceptor` + service-token gate) over loopback
//! with real certificates. The policy itself is unit-tested in
//! `packages/pal-grpc-tls-rs`.

use pal_grpc_tls::{Files, VM_CERT_OU, client_tls, endpoint, peer_interceptor, server_tls};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair, SanType,
};
use tonic::transport::Server;

use crate::proto::{CompleteRequest, CompleteResponse, ModelServiceServer};

const GW: &str = "spiffe://pal.internal/svc/gateway";

struct Ca {
    cert: rcgen::Certificate,
    key: KeyPair,
}

fn ca() -> Ca {
    let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
    p.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    p.distinguished_name.push(DnType::CommonName, "test-ca");
    let key = KeyPair::generate().unwrap();
    Ca {
        cert: p.self_signed(&key).unwrap(),
        key,
    }
}

struct Dir(std::path::PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Write ca.crt / tls.crt / tls.key for a localhost leaf signed by `ca`,
/// trusting `trust` (optional SPIFFE ID and OU).
fn issue(
    dir: &Dir,
    name: &str,
    ca: &Ca,
    trust: &Ca,
    spiffe: Option<&str>,
    ou: Option<&str>,
) -> Files {
    let mut p = CertificateParams::new(vec!["localhost".to_string()]).unwrap();
    if let Some(s) = spiffe {
        p.subject_alt_names
            .push(SanType::URI(s.try_into().unwrap()));
    }
    if let Some(o) = ou {
        p.distinguished_name.push(DnType::OrganizationalUnitName, o);
    }
    p.extended_key_usages = vec![
        ExtendedKeyUsagePurpose::ServerAuth,
        ExtendedKeyUsagePurpose::ClientAuth,
    ];
    let key = KeyPair::generate().unwrap();
    let cert = p.signed_by(&key, &ca.cert, &ca.key).unwrap();
    let write = |suffix: &str, body: String| {
        let path = dir.0.join(format!("{name}-{suffix}"));
        std::fs::write(&path, body).unwrap();
        Some(path.to_string_lossy().into_owned())
    };
    Files {
        ca: write("ca.crt", trust.cert.pem()),
        cert: write("tls.crt", cert.pem()),
        key: write("tls.key", key.serialize_pem()),
    }
}

async fn call(addr: std::net::SocketAddr, files: &Files, token: bool) -> tonic::Code {
    let tls = client_tls(files, false, false).unwrap();
    let ep = endpoint(&format!("localhost:{}", addr.port()), tls).unwrap();
    let Ok(chan) = ep.connect().await else {
        return tonic::Code::Unavailable;
    };
    let mut grpc = tonic::client::Grpc::new(chan);
    if grpc.ready().await.is_err() {
        return tonic::Code::Unavailable;
    }
    let mut req = tonic::Request::new(CompleteRequest::default());
    if token {
        req.metadata_mut()
            .insert(crate::auth::TOKEN_HEADER, "tok".parse().unwrap());
    }
    let codec = tonic::codec::ProstCodec::<CompleteRequest, CompleteResponse>::default();
    let path = http::uri::PathAndQuery::from_static("/pal.v1.ModelService/Complete");
    match grpc.unary(req, path, codec).await {
        Ok(_) => tonic::Code::Ok,
        Err(s) => s.code(),
    }
}

/// The router has no providers, so a call that clears every gate is answered
/// by the handler itself with NotFound ("no provider"). Anything else — a
/// TLS alert (Unknown/Unavailable), Unauthenticated, PermissionDenied —
/// means a gate stopped it.
fn reached_handler(c: tonic::Code) -> bool {
    c == tonic::Code::NotFound
}

#[tokio::test]
async fn handshake_accept_and_reject() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = Dir(std::env::temp_dir().join(format!("mr-mtls-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let ca = ca();
    let other = self::ca();

    let srv_files = issue(
        &dir,
        "srv",
        &ca,
        &ca,
        Some("spiffe://pal.internal/svc/model-router"),
        None,
    );
    let tls = server_tls(&srv_files, true, false).unwrap().unwrap();
    let svc = crate::service::ModelServiceImpl::new(
        std::sync::Arc::new(crate::router::ModelRouter::new(Vec::new())),
        None,
    );
    let lis = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = lis.local_addr().unwrap();
    tokio::spawn(async move {
        Server::builder()
            .tls_config(tls)
            .unwrap()
            .layer(tonic::service::interceptor(peer_interceptor(vec![
                GW.to_string(),
            ])))
            .layer(tonic::service::interceptor(crate::auth::interceptor(Some(
                "tok".into(),
            ))))
            .add_service(ModelServiceServer::new(svc))
            .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(lis))
            .await
            .unwrap();
    });

    let gw = issue(&dir, "gw", &ca, &ca, Some(GW), None);
    let code = call(addr, &gw, true).await;
    assert!(
        reached_handler(code),
        "allowlisted cert + token must reach the handler, got {code:?}"
    );
    assert_eq!(
        call(addr, &gw, false).await,
        tonic::Code::Unauthenticated,
        "token still required"
    );

    let no_cert = Files {
        ca: srv_files.ca.clone(),
        ..Default::default()
    };
    let c = call(addr, &no_cert, true).await;
    assert!(!reached_handler(c), "no client cert: {c:?}");
    let wrong_san = issue(
        &dir,
        "dash",
        &ca,
        &ca,
        Some("spiffe://pal.internal/svc/dashboard"),
        None,
    );
    assert!(
        !reached_handler(call(addr, &wrong_san, true).await),
        "wrong SAN"
    );
    let vm = issue(&dir, "vm", &ca, &ca, Some(GW), Some(VM_CERT_OU));
    assert!(
        !reached_handler(call(addr, &vm, true).await),
        "VM guest cert"
    );
    let foreign = issue(&dir, "foreign", &other, &ca, Some(GW), None);
    assert!(
        !reached_handler(call(addr, &foreign, true).await),
        "wrong CA"
    );
}
