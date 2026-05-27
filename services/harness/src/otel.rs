// OTel pass-through: reads pre-serialized OTLP span batches from a unix
// socket (`/run/lantern/otlp.sock`) and forwards them via the Report
// stream. The workload's tracing setup writes OTLP/protobuf bytes here.
//
// Wire protocol: length-prefixed (u32 big-endian) OTLP batches. One batch
// per connection or many — both are supported.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use tokio::io::AsyncReadExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::time::Instant;

use crate::manager_client::ManagerClient;
use crate::proto::HarnessReport;

const BATCH_INTERVAL: Duration = Duration::from_secs(2);
const MAX_BATCH_BYTES: usize = 1024 * 1024;

pub async fn run(manager: ManagerClient) -> Result<()> {
    let path: PathBuf = std::env::var("LANTERN_OTLP_SOCKET")
        .unwrap_or_else(|_| "/run/lantern/otlp.sock".to_string())
        .into();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let _ = tokio::fs::remove_file(&path).await;
    let listener = UnixListener::bind(&path)?;
    tracing::info!(?path, "otel: OTLP socket listening");

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, "otel: accept failed");
                continue;
            }
        };
        let m = manager.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(m, stream).await {
                tracing::debug!(error = %e, "otel: conn ended");
            }
        });
    }
}

async fn handle_conn(manager: ManagerClient, mut stream: UnixStream) -> Result<()> {
    let mut pending: Vec<u8> = Vec::new();
    let mut last_flush = Instant::now();

    loop {
        let mut len_buf = [0u8; 4];
        match stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                if !pending.is_empty() {
                    flush(&manager, &mut pending).await;
                }
                return Ok(());
            }
            Err(e) => return Err(e.into()),
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        if len > MAX_BATCH_BYTES {
            return Err(anyhow::anyhow!("otlp batch too large: {len}"));
        }
        let mut buf = vec![0u8; len];
        stream.read_exact(&mut buf).await?;
        pending.extend_from_slice(&buf);

        if pending.len() >= MAX_BATCH_BYTES / 2 || last_flush.elapsed() >= BATCH_INTERVAL {
            flush(&manager, &mut pending).await;
            last_flush = Instant::now();
        }
    }
}

async fn flush(manager: &ManagerClient, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let bytes = std::mem::take(pending);
    manager
        .enqueue_report(HarnessReport::OtlpTraces { bytes })
        .await;
}
