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

mod bootenv;
mod cc_attest;
mod egress;
mod exec;
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
mod tool_runner;

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::mpsc;
use tracing_subscriber::EnvFilter;

use crate::egress::EgressPolicy;
use crate::heartbeat::Heartbeat;
use crate::manager_client::ManagerClient;
use crate::proto::{EgressRule, SecretRef};
use crate::secrets::SecretCache;
use crate::supervisor::Supervisor;

#[derive(Debug)]
struct HarnessEnv {
    vm_id: String,
    manager_addr: String,
    workload_cmd: Vec<String>,
    declared_secrets: Vec<SecretRef>,
    declared_egress: Vec<EgressRule>,
}

fn parse_env() -> Result<HarnessEnv> {
    let vm_id = std::env::var("LANTERN_VM_ID").context("LANTERN_VM_ID env var required")?;
    let manager_addr =
        std::env::var("LANTERN_MANAGER_ADDR").unwrap_or_else(|_| "127.0.0.1:50054".to_string());
    // Space-separated argv. A VM may legitimately declare NO workload — a
    // boot/verification VM whose job is to come up, serve the secrets + exec
    // channels, and heartbeat until it is stopped. Absent or blank therefore
    // means "supervise nothing", not a configuration error.
    let workload_cmd: Vec<String> = std::env::var("LANTERN_WORKLOAD_CMD")
        .unwrap_or_default()
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

    // LANTERN_EGRESS_RULES is a JSON array of {pattern, http_methods, rate_bps}
    // declared in the AgentSpec, injected by the manager at spawn. Present →
    // egress is "configured" (the proxy must be enforced); absent/empty → no
    // egress declared (default-deny applies once the manager pushes rules via
    // heartbeat). Parsing failure is treated as "no rules".
    let declared_egress: Vec<EgressRule> = std::env::var("LANTERN_EGRESS_RULES")
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    Ok(HarnessEnv {
        vm_id,
        manager_addr,
        workload_cmd,
        declared_secrets,
        declared_egress,
    })
}

/// Single-threaded startup, then the async runtime.
///
/// NOT `#[tokio::main]`. That macro builds the (multi-threaded) runtime and
/// only then runs the async body — so its worker threads are already alive by
/// the time the body's first statement executes. Every `std::env::set_var` in
/// `bootenv` would then be mutating process-global state with other threads
/// running, which is unsound; that is exactly why `set_var` is `unsafe` in
/// edition 2024. Doing the environment work here, before the runtime exists,
/// is what makes those SAFETY comments true rather than aspirational.
fn main() -> Result<()> {
    // ---- single-threaded phase: no runtime, no threads ---------------------

    // EnvFilter reads RUST_LOG once, when the subscriber is built, so a filter
    // arriving via boot-args has to be published before that or it can never
    // take effect. Silent by necessity — there is nothing to log to yet.
    bootenv::preinit_log_filter();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,lantern_harness=debug")),
        )
        .json()
        .with_target(false)
        .init();

    // As PID 1 in a microVM the harness starts with an essentially empty
    // environment — the kernel passes the spawn contract on the command line
    // instead. Translate it before anything reads configuration (including
    // LANTERN_TRACE_PARENT below).
    bootenv::bootstrap();

    // ---- async phase: the environment is now frozen ------------------------
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to build the Tokio runtime")?
        .block_on(run())
}

async fn run() -> Result<()> {
    // Set the W3C propagator globally and parse LANTERN_TRACE_PARENT so every
    // outgoing gRPC call to the manager carries the spawn trace's traceparent.
    let _spawn_cx = otel::init_propagator();

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

    // 2b. CC attestation — best-effort; never blocks or aborts boot.
    cc_attest::run(&manager).await;

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
        // Warm the cache before the workload can ask, so the mTLS vend path
        // runs on every boot rather than only when something requests a
        // secret. Spawned: a slow or unreachable manager must not delay boot.
        let s = Arc::clone(&secrets);
        tokio::spawn(async move {
            s.prefetch_declared().await;
        });
        let s = Arc::clone(&secrets);
        tokio::spawn(async move {
            s.refresh_loop().await;
        });
    }

    // 4. Egress proxy. Seed it with the AgentSpec's declared rules so the
    //    allowlist is live the moment the workload starts (don't wait for the
    //    first heartbeat ack).
    let egress_configured = !env.declared_egress.is_empty();
    let egress_policy = Arc::new(EgressPolicy::new(
        env.declared_egress.clone(),
        manager.clone(),
    ));

    // 4a. Boot-time enforcement preflight (P2-B7 fix #2). When egress rules are
    //     declared but the iptables REDIRECT layer is absent, this fails closed
    //     (refuses to spawn the workload) if LANTERN_EGRESS_FAIL_CLOSED=1, else
    //     logs a prominent SECURITY warning + audit event. Runs BEFORE the
    //     workload is spawned so a bypassable allowlist never silently ships.
    egress::enforcement_preflight(&manager, egress_configured).await?;

    {
        let p = Arc::clone(&egress_policy);
        tokio::spawn(async move {
            if let Err(e) = egress::run_proxy(p).await {
                tracing::error!(error = %e, "egress: proxy exited");
            }
        });
    }

    // 4b. In-guest exec server — serves RuntimeHarness.Exec so the manager
    //     can dial back for `lantern vm exec`. Failure is tolerated: the
    //     workload always runs even if exec is unavailable.
    {
        let m = manager.clone();
        let vm_id = env.vm_id.clone();
        tokio::spawn(async move {
            if let Err(e) = exec::run(vm_id, m).await {
                tracing::error!(error = %e, "exec: server exited");
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
    let supervisor = Supervisor::new(env.workload_cmd.clone(), manager.clone())
        .with_proxy_env(egress_configured);
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
    //     With no workload declared there is nothing to supervise, and the
    //     supervisor treats an empty argv as fatal — so idle on the shutdown
    //     signal instead, keeping the secrets/exec/heartbeat channels served.
    if env.workload_cmd.is_empty() {
        tracing::info!("no workload declared — idling until stopped (boot-only VM)");
        drop(supervisor);
        drop(stdio_tx);
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %e, "failed to await shutdown signal");
        }
        tracing::info!("shutdown signal received");
        report_handle.abort();
        return Ok(());
    }

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
