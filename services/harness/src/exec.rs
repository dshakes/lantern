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
//   - The FIRST ExecRequest frame carries `command` (+ optional argv) and,
//     for interactive execs, `tty = true` + initial geometry (`term_rows`,
//     `term_cols`) + `term`.
//   - tty == false (one-shot, unchanged): subsequent frames (stdin) are
//     drained but NOT piped, same as the docker backend.
//   - tty == true (interactive): the command runs under a freshly-allocated
//     PTY; subsequent frames carry stdin bytes that are written to the PTY
//     master, and everything the PTY emits streams back as `stdout` chunks
//     (a PTY merges stdout and stderr — that is terminal semantics).
//   - The FINAL frame carries the exit code with `done = true` either way.
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

// ---------------------------------------------------------------------------
// Interactive (tty) exec — PTY-backed
// ---------------------------------------------------------------------------

/// Build the initial PTY window size for an interactive exec. Zero rows or
/// cols (caller didn't measure its terminal) fall back to a conventional
/// 24x80 so the guest shell always has a sane geometry; values beyond
/// `u16::MAX` are clamped to the ioctl's field width.
fn tty_winsize(rows: u32, cols: u32) -> nix::pty::Winsize {
    let clamp = |v: u32, default: u16| -> u16 {
        if v == 0 {
            default
        } else {
            u16::try_from(v).unwrap_or(u16::MAX)
        }
    };
    nix::pty::Winsize {
        ws_row: clamp(rows, 24),
        ws_col: clamp(cols, 80),
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

/// Spawn `command argv...` with the PTY slave as stdin/stdout/stderr and as
/// the controlling terminal (setsid + TIOCSCTTY in `pre_exec`). `TERM` is
/// exported for the child (empty → "xterm").
fn spawn_on_pty(
    command: &str,
    argv: &[String],
    term: &str,
    slave: &std::os::fd::OwnedFd,
) -> std::io::Result<tokio::process::Child> {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(argv)
        .env("TERM", if term.is_empty() { "xterm" } else { term })
        .stdin(std::process::Stdio::from(slave.try_clone()?))
        .stdout(std::process::Stdio::from(slave.try_clone()?))
        .stderr(std::process::Stdio::from(slave.try_clone()?))
        .kill_on_drop(true);
    // SAFETY: `pre_exec` runs in the forked child before exec; setsid(2) and
    // ioctl(2) are both async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            // New session, then adopt the PTY slave (the child's stdin, fd 0)
            // as the controlling terminal.
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn()
}

/// Run `command argv...` under a freshly-allocated PTY and pump the master
/// side bidirectionally: PTY output → `ExecResponse.stdout` frames (stdout
/// and stderr are merged — that is PTY semantics), inbound stdin bytes
/// (`stdin_rx`) → PTY master. The final frame carries the exit code with
/// `done = true`; a spawn failure surfaces as a single `Err(Status)`.
///
/// The PTY allocation, spawn, and pumps are unit-testable headless — no
/// controlling terminal is needed because the child gets a NEW session whose
/// controlling tty is the freshly-opened slave. Only the full
/// CLI ↔ manager ↔ harness round trip is guest/tty-runtime-only.
async fn run_exec_tty(
    command: String,
    argv: Vec<String>,
    term: String,
    winsize: nix::pty::Winsize,
    mut stdin_rx: mpsc::Receiver<Vec<u8>>,
    tx: mpsc::Sender<Result<pb::ExecResponse, Status>>,
) {
    // openpty applies `winsize` to the slave at allocation — equivalent to a
    // TIOCSWINSZ immediately after open.
    let nix::pty::OpenptyResult { master, slave } = match nix::pty::openpty(Some(&winsize), None) {
        Ok(p) => p,
        Err(e) => {
            let _ = tx
                .send(Err(Status::internal(format!("exec: openpty failed: {e}"))))
                .await;
            return;
        }
    };

    let mut child = match spawn_on_pty(&command, &argv, &term, &slave) {
        Ok(child) => child,
        Err(e) => {
            let _ = tx
                .send(Err(Status::internal(format!(
                    "exec: failed to spawn '{command}' on pty: {e}"
                ))))
                .await;
            return;
        }
    };
    // The parent must close its copy of the slave or the master never sees
    // EOF/EIO when the child exits.
    drop(slave);

    // PTY master fds are not pollable through tokio's `File` wrapper (and
    // hangup semantics differ per platform: EOF on macOS, EIO on Linux), so
    // pump them on dedicated blocking threads via `spawn_blocking` — never
    // on the async executor itself.
    let read_file = match master.try_clone() {
        Ok(fd) => std::fs::File::from(fd),
        Err(e) => {
            let _ = tx
                .send(Err(Status::internal(format!(
                    "exec: dup of pty master failed: {e}"
                ))))
                .await;
            return;
        }
    };
    let write_file = std::fs::File::from(master);

    let out_tx = tx.clone();
    let reader = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut pty = read_file;
        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            match pty.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let frame = pb::ExecResponse {
                        stdout: buf[..n].to_vec(),
                        stderr: vec![],
                        exit_code: 0,
                        done: false,
                    };
                    if out_tx.blocking_send(Ok(frame)).is_err() {
                        // Manager hung up; stop reading.
                        break;
                    }
                }
                // EIO is the normal Linux signal that the last slave fd
                // closed (child exited) — treat any error as end-of-stream.
                Err(_) => break,
            }
        }
    });

    // stdin pump: ends when the client half-closes its send stream
    // (`stdin_rx` yields `None`) or the PTY goes away. The thread may park
    // on `blocking_recv` past child exit until the client closes — that is
    // fine, it holds nothing but a master dup.
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let mut pty = write_file;
        while let Some(bytes) = stdin_rx.blocking_recv() {
            if pty.write_all(&bytes).is_err() {
                break;
            }
        }
    });

    let status = child.wait().await;
    // Drain the reader so every output byte is flushed before the final
    // frame; it terminates on EOF/EIO once the child is gone.
    let _ = reader.await;

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

        let (tx, rx) = mpsc::channel::<Result<pb::ExecResponse, Status>>(64);

        if first.tty {
            // Interactive: forward inbound stdin frames into the PTY. Once
            // the exec finishes (receiver dropped) keep draining so the
            // manager-side relay never stalls on a blocked send.
            let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>(64);
            tokio::spawn(async move {
                let mut sink_closed = false;
                while let Ok(Some(frame)) = stream.message().await {
                    if sink_closed || frame.stdin.is_empty() {
                        continue;
                    }
                    if stdin_tx.send(frame.stdin).await.is_err() {
                        sink_closed = true;
                    }
                }
            });
            tokio::spawn(run_exec_tty(
                first.command,
                first.argv,
                first.term,
                tty_winsize(first.term_rows, first.term_cols),
                stdin_rx,
                tx,
            ));
        } else {
            // One-shot (unchanged): drain any stdin frames so the
            // manager-side relay never stalls on a blocked send. Stdin is
            // not piped (mirrors the docker backend path).
            tokio::spawn(async move { while let Ok(Some(_)) = stream.message().await {} });
            tokio::spawn(run_exec(first.command, first.argv, tx));
        }

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
            ..Default::default()
        };
        let err = validate_first_frame(&frame, "vm-1").expect_err("empty command must fail");
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[test]
    fn first_frame_rejects_mismatched_vm_id() {
        let frame = pb::ExecRequest {
            vm_id: "vm-other".to_string(),
            command: "ls".to_string(),
            ..Default::default()
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
                ..Default::default()
            };
            assert!(
                validate_first_frame(&frame, "vm-mine").is_ok(),
                "vm_id {vm_id:?} should be accepted"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Interactive (tty) exec.
    //
    // These run headless: openpty does not need a controlling terminal (the
    // child gets a fresh session whose controlling tty is the new slave).
    // The full CLI ↔ manager ↔ harness interactive round trip is
    // guest/tty-runtime-only and is NOT covered here.
    // -----------------------------------------------------------------------

    #[test]
    fn tty_winsize_defaults_to_24x80() {
        let ws = tty_winsize(0, 0);
        assert_eq!(ws.ws_row, 24);
        assert_eq!(ws.ws_col, 80);
        assert_eq!(ws.ws_xpixel, 0);
        assert_eq!(ws.ws_ypixel, 0);
    }

    #[test]
    fn tty_winsize_uses_caller_geometry_and_clamps() {
        let ws = tty_winsize(50, 120);
        assert_eq!(ws.ws_row, 50);
        assert_eq!(ws.ws_col, 120);

        let ws = tty_winsize(u32::MAX, 1);
        assert_eq!(ws.ws_row, u16::MAX, "rows beyond u16 must clamp");
        assert_eq!(ws.ws_col, 1);
    }

    #[test]
    fn first_frame_with_tty_fields_validates() {
        let frame = pb::ExecRequest {
            vm_id: "vm-1".to_string(),
            command: "sh".to_string(),
            tty: true,
            term_rows: 40,
            term_cols: 132,
            term: "xterm-256color".to_string(),
            ..Default::default()
        };
        assert!(validate_first_frame(&frame, "vm-1").is_ok());
    }

    /// Drain every frame from a run_exec_tty channel, feeding `stdin_writes`
    /// into the PTY first.
    async fn collect_tty(
        command: &str,
        argv: &[&str],
        stdin_writes: Vec<Vec<u8>>,
    ) -> Vec<Result<pb::ExecResponse, Status>> {
        let (stdin_tx, stdin_rx) = mpsc::channel(8);
        for w in stdin_writes {
            stdin_tx.send(w).await.expect("stdin channel open");
        }
        drop(stdin_tx); // half-close, like a client ending its send stream

        let (tx, mut rx) = mpsc::channel(64);
        run_exec_tty(
            command.to_string(),
            argv.iter().map(|s| s.to_string()).collect(),
            "dumb".to_string(),
            tty_winsize(24, 80),
            stdin_rx,
            tx,
        )
        .await;
        let mut frames = Vec::new();
        while let Some(f) = rx.recv().await {
            frames.push(f);
        }
        frames
    }

    /// Concatenate stdout bytes and pull the final frame out of a tty run.
    fn tty_output(frames: &[Result<pb::ExecResponse, Status>]) -> (Vec<u8>, pb::ExecResponse) {
        let mut stdout = Vec::new();
        for f in frames {
            let f = f.as_ref().expect("no error frames expected");
            stdout.extend_from_slice(&f.stdout);
            assert!(
                f.stderr.is_empty(),
                "tty exec must never emit stderr frames"
            );
        }
        let last = frames
            .last()
            .expect("at least the final frame must arrive")
            .as_ref()
            .expect("final frame must be Ok")
            .clone();
        (stdout, last)
    }

    #[tokio::test]
    async fn tty_exec_merges_stderr_into_stdout_and_reports_exit_code() {
        let frames = collect_tty(
            "/bin/sh",
            &["-c", "printf out; printf err 1>&2; exit 3"],
            vec![],
        )
        .await;
        let (stdout, last) = tty_output(&frames);

        assert_eq!(
            stdout, b"outerr",
            "on a PTY both streams arrive merged, in write order"
        );
        assert!(last.done, "final frame must carry done=true");
        assert_eq!(last.exit_code, 3, "final frame must carry the exit code");
    }

    #[tokio::test]
    async fn tty_exec_pipes_stdin_through_the_pty() {
        // `read` pulls one line from the controlling tty, so the child only
        // exits if the stdin pump delivered the bytes to the PTY master.
        let frames = collect_tty(
            "/bin/sh",
            &["-c", r#"read line && printf "got:%s" "$line""#],
            vec![b"hi\n".to_vec()],
        )
        .await;
        let (stdout, last) = tty_output(&frames);

        let text = String::from_utf8_lossy(&stdout);
        assert!(
            text.contains("got:hi"),
            "stdin must reach the child through the PTY, got: {text:?}"
        );
        assert!(last.done);
        assert_eq!(last.exit_code, 0);
    }

    #[tokio::test]
    async fn tty_exec_exports_term() {
        let frames = collect_tty("/bin/sh", &["-c", "printf \"%s\" \"$TERM\""], vec![]).await;
        let (stdout, last) = tty_output(&frames);

        assert_eq!(
            stdout, b"dumb",
            "TERM from the request must reach the child"
        );
        assert_eq!(last.exit_code, 0);
    }

    #[tokio::test]
    async fn tty_exec_spawn_failure_surfaces_internal_status() {
        let frames = collect_tty("/nonexistent/lantern-test-binary", &[], vec![]).await;

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
}
