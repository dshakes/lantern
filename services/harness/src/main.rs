// lantern-harness — PID 1 init process running inside every Lantern microVM.
//
// Responsibilities (see README.md for the full boot contract):
//   1. Init: prep /run/lantern, mount tmpfs, set rlimits.
//   2. Supervisor: spawn the workload as a child, restart on crash, exit
//      clean on success.
//   3. Heartbeat: bidirectional gRPC stream to runtime-manager.
//   4. Secrets: vend + cache + refresh, exposed at /run/lantern/secrets.sock.
//   5. Egress: HTTP CONNECT proxy on 127.0.0.1:3128 with allowlist.
//   6. Logs: tail workload stdio, forward as LogLine via Report stream.
//   7. OTel: read OTLP from /run/lantern/otlp.sock, batch + forward.
//   8. Signals: SIGTERM=drain, SIGUSR1=snapshot, SIGCHLD=reap zombies.
//   9. Audit: emit on every secret vend, egress decision, exec, snapshot.

#![allow(clippy::needless_return)]

mod egress;
mod heartbeat;
mod init;
mod logs;
mod manager_client;
mod otel;
mod proto;
mod report;
mod secrets;
mod signals;
mod supervisor;
mod tls;

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::mpsc;
use tracing_subscriber::EnvFilter;

use crate::egress::EgressPolicy;
use crate::heartbeat::Heartbeat;
use crate::manager_client::ManagerClient;
use crate::proto::SecretRef;
use crate::secrets::SecretCache;
use crate::supervisor::Supervisor;

#[derive(Debug)]
struct HarnessEnv {
    vm_id: String,
    manager_addr: String,
    workload_cmd: Vec<String>,
    declared_secrets: Vec<SecretRef>,
}

fn parse_env() -> Result<HarnessEnv> {
    let vm_id = std::env::var("LANTERN_VM_ID").context("LANTERN_VM_ID env var required")?;
    let manager_addr =
        std::env::var("LANTERN_MANAGER_ADDR").unwrap_or_else(|_| "127.0.0.1:50054".to_string());
    let workload_cmd_raw = std::env::var("LANTERN_WORKLOAD_CMD")
        .context("LANTERN_WORKLOAD_CMD env var required (space-separated argv)")?;
    let workload_cmd: Vec<String> = workload_cmd_raw
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();

    // LANTERN_DECLARED_SECRETS is a JSON array of {env_name, secret_uri}.
    // Missing or unparseable -> empty list; secrets module rejects all
    // requests in that case.
    let declared_secrets: Vec<SecretRef> = std::env::var("LANTERN_DECLARED_SECRETS")
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    Ok(HarnessEnv {
        vm_id,
        manager_addr,
        workload_cmd,
        declared_secrets,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,lantern_harness=debug")),
        )
        .json()
        .with_target(false)
        .init();

    let env = parse_env()?;
    tracing::info!(
        vm_id = %env.vm_id,
        manager = %env.manager_addr,
        workload = ?env.workload_cmd,
        secrets = env.declared_secrets.len(),
        "starting lantern-harness (PID 1)"
    );

    // 1. Init: mount tmpfs, prep dirs, set rlimits.
    init::boot().await?;

    let manager = ManagerClient::new(env.manager_addr.clone(), env.vm_id.clone());

    // 2. Report fan-in channel — every subsystem enqueues HarnessReport here.
    let (report_tx, report_rx) = report::channel();
    manager.set_report_channel(report_tx).await;
    let report_handle = {
        let m = manager.clone();
        tokio::spawn(async move {
            report::run(m, report_rx).await;
        })
    };

    // 3. Secrets server — bind /run/lantern/secrets.sock.
    let secrets = Arc::new(SecretCache::new(
        manager.clone(),
        env.declared_secrets.clone(),
    ));
    {
        let s = Arc::clone(&secrets);
        tokio::spawn(async move {
            if let Err(e) = s.serve().await {
                tracing::error!(error = %e, "secrets: server exited");
            }
        });
        let s = Arc::clone(&secrets);
        tokio::spawn(async move {
            s.refresh_loop().await;
        });
    }

    // 4. Egress proxy.
    let egress_policy = Arc::new(EgressPolicy::new(Vec::new(), manager.clone()));
    {
        let p = Arc::clone(&egress_policy);
        tokio::spawn(async move {
            if let Err(e) = egress::run_proxy(p).await {
                tracing::error!(error = %e, "egress: proxy exited");
            }
        });
    }

    // 5. OTel forwarder.
    {
        let m = manager.clone();
        tokio::spawn(async move {
            if let Err(e) = otel::run(m).await {
                tracing::error!(error = %e, "otel: forwarder exited");
            }
        });
    }

    // 6. Supervisor — spawn workload, hand stdio to log forwarder.
    let (stdio_tx, stdio_rx) = mpsc::channel(4);
    let supervisor = Supervisor::new(env.workload_cmd.clone(), manager.clone());
    let supervisor_handles = supervisor.handles();

    // 7. Signal handlers — drain, snapshot, zombie reap.
    let control_tx = signals::install(manager.clone(), supervisor_handles.clone());

    // 8. Log forwarder — drains stdio handles forever.
    {
        let m = manager.clone();
        tokio::spawn(async move {
            logs::run(m, stdio_rx).await;
        });
    }

    // 9. Heartbeat — bidirectional stream, retries with backoff.
    {
        let hb = Heartbeat::new(
            manager.clone(),
            supervisor_handles.clone(),
            Arc::clone(&egress_policy),
            control_tx.clone(),
        );
        let usage = hb.usage_handle();
        tokio::spawn(async move {
            heartbeat::sample_usage_loop(usage).await;
        });
        tokio::spawn(async move {
            hb.run().await;
        });
    }

    // 10. Main task: run the supervisor on the foreground. When it returns,
    //     the workload either succeeded (exit clean) or exhausted restarts.
    let supervisor_task = tokio::spawn(async move { supervisor.run(stdio_tx).await });

    let result = tokio::select! {
        r = supervisor_task => match r {
            Ok(Ok(exit_code)) => {
                tracing::info!(exit_code, "supervisor exited cleanly");
                Ok(())
            }
            Ok(Err(e)) => {
                tracing::error!(error = %e, "supervisor errored");
                Err(e)
            }
            Err(e) => {
                tracing::error!(error = %e, "supervisor task panicked");
                Err(anyhow::anyhow!("supervisor join error: {e}"))
            }
        },
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("ctrl-c received");
            Ok(())
        }
    };

    // Stop the report forwarder so the runtime can drop.
    report_handle.abort();
    result
}
