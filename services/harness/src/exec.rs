// In-guest exec server — serves `RuntimeHarness.Exec` so the manager can
// dial back into the guest for `lantern vm exec` against Firecracker VMs.
//
// Direction note: Heartbeat / VendSecret / Report are RPCs the harness
// CALLS on the manager. Exec is the one RPC the harness SERVES: the
// manager learns this guest's address from the Heartbeat peer and dials
// `LANTERN_HARNESS_EXEC_ADDR` (default 0.0.0.0:50056) to run a one-shot
// command inside the guest.
//
// Framing mirrors the manager's docker exec path exactly:
//   - The FIRST ExecRequest frame carries `command` (+ optional argv).
//   - Subsequent frames (stdin) are drained but NOT piped — exec is
//     one-shot / non-interactive, same as the docker backend.
//   - stdout/stderr stream back as chunks; the FINAL frame carries the
//     exit code with `done = true`.
//
// Transport: plaintext inside the guest's tap network (host ↔ guest only).
// This matches the current harness↔manager posture — mTLS server identity
// for this listener rides on the same per-VM cert provisioning work
// tracked in `tls.rs` ("Remaining work").

use std::pin::Pin;

use anyhow::{Context, Result};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

use crate::manager_client::ManagerClient;
use crate::proto::{self, AuditEvent, HarnessReport, pb};

/// Default listen address for the in-guest exec server.
pub const DEFAULT_EXEC_ADDR: &str = "0.0.0.0:50056";

/// Size of the stdout/stderr read chunks streamed back to the manager.
const CHUNK_SIZE: usize = 8 * 1024;

/// gRPC service implementing the harness-served side of `RuntimeHarness`.
///
/// Only `Exec` is live here. Heartbeat / VendSecret / Report are
/// manager-served RPCs (this process is their *client*, via
/// `ManagerClient`); a peer calling them on the guest gets UNIMPLEMENTED.
pub struct ExecService {
    vm_id: String,
    manager: ManagerClient,
}

impl ExecService {
    pub fn new(vm_id: String, manager: ManagerClient) -> Self {
        Self { vm_id, manager }
    }
}

/// Validate the first frame of an Exec stream.
///
/// `command` is required; when the frame carries a `vm_id` it must match
/// this guest's identity (the manager always stamps it — a mismatch means
/// the dial-back resolved to the wrong guest).
// `Status` is ~176 bytes by design (tonic uses it everywhere); boxing a
// one-shot validation error gains nothing.
#[allow(clippy::result_large_err)]
fn validate_first_frame(first: &pb::ExecRequest, my_vm_id: &str) -> Result<(), Status> {
    if first.command.is_empty() {
        return Err(Status::invalid_argument(
            "exec: command is required in first message",
        ));
    }
    if !first.vm_id.is_empty() && first.vm_id != my_vm_id {
        return Err(Status::invalid_argument(format!(
            "exec: vm_id '{}' does not match this guest ('{}')",
            first.vm_id, my_vm_id
        )));
    }
    Ok(())
}

/// Spawn `command argv...` inside the guest and stream output frames into
/// `tx`. The final frame carries the exit code with `done = true`. A spawn
/// failure (e.g. binary not found) surfaces as a single `Err(Status)`.
///
/// Factored out of the gRPC handler so it is unit-testable without
/// constructing a `tonic::Streaming` request.
async fn run_exec(
    command: String,
    argv: Vec<String>,
    tx: mpsc::Sender<Result<pb::ExecResponse, Status>>,
) {
    let mut child = match tokio::process::Command::new(&command)
        .args(&argv)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            let _ = tx
                .send(Err(Status::internal(format!(
                    "exec: failed to spawn '{command}': {e}"
                ))))
                .await;
            return;
        }
    };

    // Stream stdout and stderr concurrently as they arrive. The reader
    // tasks stop early if the manager hangs up (send fails); kill_on_drop
    // then reaps the child when this function returns.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let out_task =
        stdout.map(|pipe| tokio::spawn(pump(pipe, tx.clone(), /* is_stdout */ true)));
    let err_task =
        stderr.map(|pipe| tokio::spawn(pump(pipe, tx.clone(), /* is_stdout */ false)));

    let status = child.wait().await;

    if let Some(t) = out_task {
        let _ = t.await;
    }
    if let Some(t) = err_task {
        let _ = t.await;
    }

    match status {
        Ok(status) => {
            // On Unix a signal-terminated child has no exit code; report -1
            // so the caller can distinguish it from a clean zero.
            let exit_code = status.code().unwrap_or(-1);
            let _ = tx
                .send(Ok(pb::ExecResponse {
                    stdout: vec![],
                    stderr: vec![],
                    exit_code,
                    done: true,
                }))
                .await;
        }
        Err(e) => {
            let _ = tx
                .send(Err(Status::internal(format!(
                    "exec: wait on '{command}' failed: {e}"
                ))))
                .await;
        }
    }
}

/// Read `pipe` to EOF in `CHUNK_SIZE` chunks, sending each as an
/// ExecResponse frame on either the stdout or stderr field.
async fn pump<R>(mut pipe: R, tx: mpsc::Sender<Result<pb::ExecResponse, Status>>, is_stdout: bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = vec![0u8; CHUNK_SIZE];
    loop {
        match pipe.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let chunk = buf[..n].to_vec();
                let frame = if is_stdout {
                    pb::ExecResponse {
                        stdout: chunk,
                        stderr: vec![],
                        exit_code: 0,
                        done: false,
                    }
                } else {
                    pb::ExecResponse {
                        stdout: vec![],
                        stderr: chunk,
                        exit_code: 0,
                        done: false,
                    }
                };
                if tx.send(Ok(frame)).await.is_err() {
                    // Manager hung up; stop reading.
                    break;
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "exec: pipe read error");
                break;
            }
        }
    }
}

#[tonic::async_trait]
impl pb::runtime_harness_server::RuntimeHarness for ExecService {
    type HeartbeatStream = Pin<
        Box<dyn tokio_stream::Stream<Item = Result<pb::HeartbeatAck, Status>> + Send + 'static>,
    >;

    async fn heartbeat(
        &self,
        _request: Request<tonic::Streaming<pb::HeartbeatRequest>>,
    ) -> Result<Response<Self::HeartbeatStream>, Status> {
        Err(Status::unimplemented(
            "heartbeat is served by the manager; the in-guest harness only serves Exec",
        ))
    }

    async fn vend_secret(
        &self,
        _request: Request<pb::VendSecretRequest>,
    ) -> Result<Response<pb::VendSecretResponse>, Status> {
        Err(Status::unimplemented(
            "vend_secret is served by the manager; the in-guest harness only serves Exec",
        ))
    }

    async fn report(
        &self,
        _request: Request<tonic::Streaming<pb::HarnessReport>>,
    ) -> Result<Response<pb::HarnessAck>, Status> {
        Err(Status::unimplemented(
            "report is served by the manager; the in-guest harness only serves Exec",
        ))
    }

    type ExecStream = Pin<
        Box<dyn tokio_stream::Stream<Item = Result<pb::ExecResponse, Status>> + Send + 'static>,
    >;

    async fn exec(
        &self,
        request: Request<tonic::Streaming<pb::ExecRequest>>,
    ) -> Result<Response<Self::ExecStream>, Status> {
        let mut stream = request.into_inner();

        let first = stream
            .message()
            .await
            .map_err(|e| Status::internal(format!("exec: stream read error: {e}")))?
            .ok_or_else(|| Status::invalid_argument("exec: empty request stream"))?;

        validate_first_frame(&first, &self.vm_id)?;

        tracing::info!(
            vm_id = %self.vm_id,
            command = %first.command,
            argv = ?first.argv,
            "exec: running command in guest"
        );

        // Audit every exec (responsibility #9). Best-effort via the report
        // fan-in; never blocks the exec itself.
        self.manager
            .enqueue_report(HarnessReport::Audit(AuditEvent {
                vm_id: self.vm_id.clone(),
                action: "exec".to_string(),
                at_unix_ms: proto::now_unix_ms(),
                attrs: std::collections::HashMap::from([
                    ("command".to_string(), first.command.clone()),
                    ("argv".to_string(), first.argv.join(" ")),
                ]),
            }))
            .await;

        // Drain any stdin frames so the manager-side relay never stalls on
        // a blocked send. Exec is one-shot — stdin is not piped (mirrors
        // the docker backend path).
        tokio::spawn(async move { while let Ok(Some(_)) = stream.message().await {} });

        let (tx, rx) = mpsc::channel::<Result<pb::ExecResponse, Status>>(64);
        tokio::spawn(run_exec(first.command, first.argv, tx));

        let out: Self::ExecStream = Box::pin(ReceiverStream::new(rx));
        Ok(Response::new(out))
    }
}

/// Bind and serve the in-guest exec server. Address comes from
/// `LANTERN_HARNESS_EXEC_ADDR` (default [`DEFAULT_EXEC_ADDR`]). Runs until
/// process exit; the caller spawns it and the harness tolerates failure
/// (the workload always runs even if exec is unavailable).
pub async fn run(vm_id: String, manager: ManagerClient) -> Result<()> {
    let addr_raw = std::env::var("LANTERN_HARNESS_EXEC_ADDR")
        .unwrap_or_else(|_| DEFAULT_EXEC_ADDR.to_string());
    let addr: std::net::SocketAddr = addr_raw
        .parse()
        .with_context(|| format!("exec: invalid LANTERN_HARNESS_EXEC_ADDR '{addr_raw}'"))?;

    tracing::info!(%addr, "exec: in-guest exec server listening");

    let svc =
        pb::runtime_harness_server::RuntimeHarnessServer::new(ExecService::new(vm_id, manager));
    tonic::transport::Server::builder()
        .add_service(svc)
        .serve(addr)
        .await
        .context("exec: server exited")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Drain every frame from a run_exec channel.
    async fn collect(command: &str, argv: &[&str]) -> Vec<Result<pb::ExecResponse, Status>> {
        let (tx, mut rx) = mpsc::channel(64);
        run_exec(
            command.to_string(),
            argv.iter().map(|s| s.to_string()).collect(),
            tx,
        )
        .await;
        let mut frames = Vec::new();
        while let Some(f) = rx.recv().await {
            frames.push(f);
        }
        frames
    }

    #[tokio::test]
    async fn exec_streams_stdout_stderr_and_exit_code() {
        let frames = collect("/bin/sh", &["-c", "printf out; printf err 1>&2; exit 3"]).await;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut last: Option<pb::ExecResponse> = None;
        for f in frames {
            let f = f.expect("no error frames expected");
            stdout.extend_from_slice(&f.stdout);
            stderr.extend_from_slice(&f.stderr);
            last = Some(f);
        }

        assert_eq!(stdout, b"out", "stdout must stream through verbatim");
        assert_eq!(stderr, b"err", "stderr must stream through verbatim");
        let last = last.expect("at least the final frame must arrive");
        assert!(last.done, "final frame must carry done=true");
        assert_eq!(last.exit_code, 3, "final frame must carry the exit code");
    }

    #[tokio::test]
    async fn exec_clean_exit_reports_zero() {
        let frames = collect("/bin/echo", &["hello"]).await;

        let stdout: Vec<u8> = frames
            .iter()
            .filter_map(|f| f.as_ref().ok())
            .flat_map(|f| f.stdout.clone())
            .collect();
        assert_eq!(stdout, b"hello\n");

        let last = frames
            .last()
            .expect("frames must not be empty")
            .as_ref()
            .expect("final frame must be Ok");
        assert!(last.done);
        assert_eq!(last.exit_code, 0);
    }

    #[tokio::test]
    async fn exec_spawn_failure_surfaces_internal_status() {
        let frames = collect("/nonexistent/lantern-test-binary", &[]).await;

        assert_eq!(
            frames.len(),
            1,
            "spawn failure should yield exactly one frame"
        );
        let err = frames[0].as_ref().expect_err("expected an error frame");
        assert_eq!(err.code(), tonic::Code::Internal);
        assert!(
            err.message().contains("failed to spawn"),
            "message should name the spawn failure, got: {}",
            err.message()
        );
    }

    #[test]
    fn first_frame_requires_command() {
        let frame = pb::ExecRequest {
            vm_id: "vm-1".to_string(),
            command: String::new(),
            argv: vec![],
            stdin: vec![],
            tty: false,
        };
        let err = validate_first_frame(&frame, "vm-1").expect_err("empty command must fail");
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[test]
    fn first_frame_rejects_mismatched_vm_id() {
        let frame = pb::ExecRequest {
            vm_id: "vm-other".to_string(),
            command: "ls".to_string(),
            argv: vec![],
            stdin: vec![],
            tty: false,
        };
        let err = validate_first_frame(&frame, "vm-mine").expect_err("vm_id mismatch must fail");
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
        assert!(
            err.message().contains("vm-other") && err.message().contains("vm-mine"),
            "message should name both ids, got: {}",
            err.message()
        );
    }

    #[test]
    fn first_frame_accepts_empty_vm_id_and_matching_vm_id() {
        for vm_id in ["", "vm-mine"] {
            let frame = pb::ExecRequest {
                vm_id: vm_id.to_string(),
                command: "ls".to_string(),
                argv: vec![],
                stdin: vec![],
                tty: false,
            };
            assert!(
                validate_first_frame(&frame, "vm-mine").is_ok(),
                "vm_id {vm_id:?} should be accepted"
            );
        }
    }
}
