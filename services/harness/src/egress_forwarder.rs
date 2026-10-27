//! Broker-mode guest forwarder (ADR 0026).
//!
//! The workload keeps using `HTTP(S)_PROXY=http://127.0.0.1:3128`; in broker
//! mode nothing in the guest enforces or terminates anything. Each accepted
//! connection is bridged, byte for byte, to a fresh vsock stream to the
//! host-side egress broker, which owns the allowlist, the upstream dial and
//! credential injection. The guest never holds a credential.
//!
//! Dependency-free beyond tokio/tracing on purpose: the runtime-manager's
//! end-to-end broker test compiles this exact file (`#[path]`) so the test
//! exercises the real guest half, not a copy of it.

use std::future::Future;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;

/// Accept workload proxy connections on `listener` and splice each to a
/// stream from `dial` (vsock in production, a Unix socket in tests).
pub async fn run<F, Fut, S>(listener: TcpListener, dial: F)
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = std::io::Result<S>> + Send,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let dial = Arc::new(dial);
    loop {
        let (mut client, _) = match listener.accept().await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "egress forwarder: accept failed");
                continue;
            }
        };
        let dial = Arc::clone(&dial);
        tokio::spawn(async move {
            match dial().await {
                Ok(mut upstream) => {
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                }
                Err(e) => {
                    // No broker, no egress: fail closed, and say so to the client.
                    tracing::warn!(error = %e, "egress forwarder: broker unreachable");
                    let _ = tokio::io::AsyncWriteExt::write_all(
                        &mut client,
                        b"HTTP/1.1 502 Bad Gateway\r\nX-Lantern-Reason: egress-broker-unreachable\r\nContent-Length: 0\r\n\r\n",
                    )
                    .await;
                }
            }
        });
    }
}
