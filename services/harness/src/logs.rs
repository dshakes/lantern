// Log forwarder: receives fresh ChildStdout / ChildStderr handles from the
// supervisor (one set per workload spawn / restart), tails them line by
// line, parses JSON if possible, and forwards each line as a LogLine over
// the Report stream.

use std::collections::HashMap;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use crate::manager_client::ManagerClient;
use crate::proto::{HarnessReport, LogLine, now_unix_ms};
use crate::supervisor::WorkloadStdio;

/// Drain the channel of stdio handles forever. Each entry corresponds to
/// one workload spawn; on restart, the supervisor pushes new handles.
pub async fn run(manager: ManagerClient, mut stdio_rx: mpsc::Receiver<WorkloadStdio>) {
    while let Some(stdio) = stdio_rx.recv().await {
        if let Some(stdout) = stdio.stdout {
            let m = manager.clone();
            tokio::spawn(async move {
                tail_stream(m, BufReader::new(stdout), "stdout").await;
            });
        }
        if let Some(stderr) = stdio.stderr {
            let m = manager.clone();
            tokio::spawn(async move {
                tail_stream(m, BufReader::new(stderr), "stderr").await;
            });
        }
    }
}

async fn tail_stream<R>(manager: ManagerClient, mut reader: BufReader<R>, stream: &'static str)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf).await {
            Ok(0) => return,
            Ok(_) => {
                let text = buf.trim_end_matches(['\n', '\r']).to_string();
                if text.is_empty() {
                    continue;
                }
                let attrs = parse_json_attrs(&text).unwrap_or_default();
                let line = LogLine {
                    vm_id: manager.vm_id.clone(),
                    at_unix_ms: now_unix_ms(),
                    stream: stream.to_string(),
                    text,
                    attrs,
                };
                manager.enqueue_report(HarnessReport::Log(line)).await;
            }
            Err(e) => {
                tracing::debug!(error = %e, %stream, "log tail ended");
                return;
            }
        }
    }
}

/// If the line is valid JSON with a flat string map, hoist its keys into
/// structured attrs. Anything fancier (nested objects, numeric values) is
/// left in `text` for downstream parsers.
fn parse_json_attrs(text: &str) -> Option<HashMap<String, String>> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let obj = v.as_object()?;
    let mut out = HashMap::with_capacity(obj.len());
    for (k, val) in obj {
        let s = match val {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::Bool(b) => b.to_string(),
            serde_json::Value::Null => "null".to_string(),
            _ => continue,
        };
        out.insert(k.clone(), s);
    }
    Some(out)
}

/// Drain pending buffers — called from the signal handler before exec'ing
/// a snapshot or terminating.
pub fn flush() {
    // The forwarder uses tokio mpsc with a bounded buffer; tracing's writer
    // is line-buffered. Nothing to do beyond letting the Report stream task
    // finish — but we expose this entry point so signals.rs can stay loud
    // about intent.
    tracing::info!("logs: flush requested");
}
