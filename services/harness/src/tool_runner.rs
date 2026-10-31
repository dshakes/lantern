// In-guest tool registry.
//
// JSON-over-Exec channel envelope (manager → harness)
// ---------------------------------------------------
// Adding a typed ExecTool RPC to RuntimeHarness would require re-running
// protoc and updating gen/go stubs. Instead we reuse the existing
// RuntimeHarness.Exec stream at port 50056 with a magic command sentinel:
//
//   ExecRequest { command: "__pal_tool_call__", argv: [<envelope_json>] }
//
// Envelope format (argv[0], compact JSON):
//   { "tool": "<name>", "args": {…}, "idempotency_key": "…", "timeout_sec": 30 }
//
// args content is NEVER logged here (may carry secrets — invariant #10).
//
// Result written as stdout bytes before the done=true frame:
//   { "ok": true, "result": {…} }      — tool ran and succeeded
//   { "ok": false, "error": "<msg>" }  — tool failed or unknown name
//
// Built-in tools
// --------------
//   shell_exec  args: { command: string, timeout_sec?: number }
//               Runs `/bin/sh -c <command>` AS THE WORKLOAD UID, returns
//               stdout/stderr/exit_code. Each stream capped at 1 MiB.
//
//   http_fetch  args: { url: string, method?: string, headers?: object, body?: string }
//               HTTP request THROUGH the egress proxy at 127.0.0.1:3128 so the
//               egress allowlist applies. Response body capped at 1 MiB.
//
//   read_file   args: { path: string, max_bytes?: number }
//   write_file  args: { path: string, content: string, mode?: number|"0644" }
//   list_dir    args: { path: string }
//               Confined to the fixed workspace root /workspace (NOT
//               configurable: workload env reaches the harness's own env, so
//               an env-chosen root could be `/`); `..`/symlink escapes
//               rejected. On Linux every open runs under the workload's
//               fsuid/fsgid, so the kernel applies the workload's own file
//               permissions and new files are owned by it.
//
// Every captured output is capped at TOOL_OUTPUT_MAX_BYTES; a truncated value
// ends with TRUNCATED_MARKER and the result carries `"truncated": true`.
// Unknown tool → {"ok":false,"error":"unknown tool: <name>"}.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::mpsc;
use tonic::Status;

use crate::manager_client::ManagerClient;
use crate::proto::{self, AuditEvent, HarnessReport, pb};

// ---------------------------------------------------------------------------
// Wire types shared with the manager
// ---------------------------------------------------------------------------

/// Tool envelope decoded from argv[0] of the magic ExecRequest.
#[derive(Debug, Deserialize)]
pub struct ToolEnvelope {
    pub tool: String,
    #[serde(default)]
    pub args: serde_json::Value,
    #[serde(default)]
    pub idempotency_key: String,
    /// Per-tool execution timeout in seconds; 0 means use the default (30s).
    #[serde(default)]
    pub timeout_sec: u64,
}

/// Tool result serialized to stdout before the done=true frame.
#[derive(Debug, Serialize)]
pub struct ToolResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ToolResult {
    fn ok(result: serde_json::Value) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(msg.into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point called by exec.rs when the magic command is detected
// ---------------------------------------------------------------------------

/// Handle a `__pal_tool_call__` ExecRequest. Parses the envelope from
/// `argv[0]`, dispatches to the tool registry, and sends the result as a
/// single stdout frame followed by `done = true`.
///
/// Emits a `tool_exec` audit event with tool name, duration, and ok/fail
/// status — args and result are NOT included (invariant #10).
pub async fn run_tool_call(
    vm_id: String,
    argv: Vec<String>,
    manager: ManagerClient,
    tx: mpsc::Sender<Result<pb::ExecResponse, Status>>,
) {
    let envelope_str = match argv.first() {
        Some(s) => s.as_str(),
        None => {
            let _ = tx
                .send(Err(Status::invalid_argument(
                    "tool call: argv[0] (envelope JSON) is required",
                )))
                .await;
            return;
        }
    };

    let env: ToolEnvelope = match serde_json::from_str(envelope_str) {
        Ok(e) => e,
        Err(e) => {
            let _ = tx
                .send(Err(Status::invalid_argument(format!(
                    "tool call: invalid envelope JSON: {e}"
                ))))
                .await;
            return;
        }
    };

    let tool_name = env.tool.clone();
    let idempotency_key = env.idempotency_key.clone();
    let started = Instant::now();

    let result = dispatch(env).await;
    let elapsed_ms = started.elapsed().as_millis() as i64;

    // Audit: tool name, duration, outcome — NEVER args or result content (#10).
    let attrs = HashMap::from([
        ("tool".to_string(), tool_name.clone()),
        ("duration_ms".to_string(), elapsed_ms.to_string()),
        ("ok".to_string(), result.ok.to_string()),
        ("idempotency_key".to_string(), idempotency_key),
    ]);
    manager
        .enqueue_report(HarnessReport::Audit(AuditEvent {
            vm_id: vm_id.clone(),
            action: "tool_exec".to_string(),
            at_unix_ms: proto::now_unix_ms(),
            attrs,
        }))
        .await;

    // Serialize result and send as a single stdout frame.
    let json_bytes = match serde_json::to_vec(&result) {
        Ok(b) => b,
        Err(e) => {
            let _ = tx
                .send(Err(Status::internal(format!(
                    "tool call: failed to serialize result: {e}"
                ))))
                .await;
            return;
        }
    };

    if tx
        .send(Ok(pb::ExecResponse {
            stdout: json_bytes,
            stderr: vec![],
            exit_code: 0,
            done: false,
        }))
        .await
        .is_err()
    {
        return; // manager hung up
    }

    // done=true signals end of this one-shot exchange.
    let _ = tx
        .send(Ok(pb::ExecResponse {
            stdout: vec![],
            stderr: vec![],
            exit_code: 0,
            done: true,
        }))
        .await;
}

// ---------------------------------------------------------------------------
// Registry dispatch
// ---------------------------------------------------------------------------

/// Dispatch `env` to the registered tool. Never panics; all tool errors are
/// returned as `ToolResult::err`.
async fn dispatch(env: ToolEnvelope) -> ToolResult {
    let timeout = if env.timeout_sec > 0 {
        Duration::from_secs(env.timeout_sec)
    } else {
        Duration::from_secs(30)
    };

    match env.tool.as_str() {
        "shell_exec" => shell_exec(env.args, timeout).await,
        "http_fetch" => http_fetch(env.args, timeout).await,
        "read_file" | "write_file" | "list_dir" => {
            let tool = env.tool;
            let args = env.args;
            // Blocking fs syscalls stay off the executor. Credentials are
            // per-thread, so they are assumed on (and restored for) the
            // blocking thread that does the work.
            let task = tokio::task::spawn_blocking(move || {
                let _creds = match FsCreds::assume(crate::supervisor::workload_identity()) {
                    Ok(c) => c,
                    Err(e) => return ToolResult::err(format!("{tool}: {e}")),
                };
                match workspace_root() {
                    Ok(root) => fs_tool(&tool, &args, &root),
                    Err(e) => ToolResult::err(format!("{tool}: {e}")),
                }
            });
            match tokio::time::timeout(timeout, task).await {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => ToolResult::err(format!("fs tool panicked: {e}")),
                Err(_) => {
                    ToolResult::err(format!("fs tool timed out after {}s", timeout.as_secs()))
                }
            }
        }
        other => ToolResult::err(format!("unknown tool: {other}")),
    }
}

// ---------------------------------------------------------------------------
// shell_exec
// ---------------------------------------------------------------------------

/// Every captured tool output (shell stdout/stderr, HTTP body, file content)
/// is capped at this many bytes (1 MiB).
const TOOL_OUTPUT_MAX_BYTES: usize = 1 << 20;

/// Appended to a value that was cut at the cap.
const TRUNCATED_MARKER: &str = "\n<truncated: output exceeded the cap>";

/// Lossy-decode `bytes`, appending the marker when it was cut.
fn capped_text(bytes: &[u8], truncated: bool) -> String {
    let mut s = String::from_utf8_lossy(bytes).into_owned();
    if truncated {
        s.push_str(TRUNCATED_MARKER);
    }
    s
}

/// Read `r` to EOF keeping at most `cap` bytes; the rest is drained and
/// discarded (so the writer never blocks on a full pipe). Returns
/// `(kept, truncated)`. Memory is bounded by `cap` regardless of input size.
async fn read_capped<R: AsyncRead + Unpin>(
    mut r: R,
    cap: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut kept = Vec::new();
    let mut chunk = vec![0u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let n = r.read(&mut chunk).await?;
        if n == 0 {
            return Ok((kept, truncated));
        }
        let room = cap.saturating_sub(kept.len());
        if n > room {
            truncated = true;
        }
        kept.extend_from_slice(&chunk[..n.min(room)]);
    }
}

/// Run `/bin/sh -c <command>` as the workload uid, capture capped
/// stdout/stderr and the exit code. The whole run (including output
/// draining) is bounded by `timeout`; on expiry the child is killed.
/// Args: `{ command: string }`.
async fn shell_exec(args: serde_json::Value, timeout: Duration) -> ToolResult {
    let command = match args.get("command").and_then(|v| v.as_str()) {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => return ToolResult::err("shell_exec: args.command (string) is required"),
    };

    let mut cmd = tokio::process::Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(&command)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::supervisor::as_workload(&mut cmd);

    // Increment BEFORE spawn so the zombie_reaper sees it before the child
    // can exit and trigger SIGCHLD.  Decremented after wait() returns.
    crate::signals::ACTIVE_TOOL_CHILDREN.fetch_add(1, Ordering::AcqRel);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            crate::signals::ACTIVE_TOOL_CHILDREN.fetch_sub(1, Ordering::AcqRel);
            return ToolResult::err(format!("shell_exec: spawn failed: {e}"));
        }
    };
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        crate::signals::ACTIVE_TOOL_CHILDREN.fetch_sub(1, Ordering::AcqRel);
        return ToolResult::err("shell_exec: child stdio unavailable");
    };

    // Dropping `child` on timeout kills the shell (kill_on_drop). A
    // backgrounded grandchild holding the pipes cannot stall us past the
    // deadline either: the whole future is abandoned.
    let run = tokio::time::timeout(timeout, async {
        let (out, err) = tokio::join!(
            read_capped(stdout, TOOL_OUTPUT_MAX_BYTES),
            read_capped(stderr, TOOL_OUTPUT_MAX_BYTES)
        );
        (out, err, child.wait().await)
    })
    .await;
    crate::signals::ACTIVE_TOOL_CHILDREN.fetch_sub(1, Ordering::AcqRel);

    match run {
        Err(_) => ToolResult::err(format!(
            "shell_exec: timed out after {}s",
            timeout.as_secs()
        )),
        Ok((Ok((out, out_trunc)), Ok((err, err_trunc)), Ok(status))) => {
            ToolResult::ok(serde_json::json!({
                "stdout": capped_text(&out, out_trunc),
                "stderr": capped_text(&err, err_trunc),
                "exit_code": status.code().unwrap_or(-1),
                "truncated": out_trunc || err_trunc,
            }))
        }
        Ok((out, err, status)) => {
            let e = out.err().or(err.err()).or(status.err());
            ToolResult::err(format!("shell_exec: io error: {e:?}"))
        }
    }
}

// ---------------------------------------------------------------------------
// http_fetch
// ---------------------------------------------------------------------------

/// Make an HTTP request through the harness egress proxy at 127.0.0.1:3128.
/// All connections route through the proxy regardless of the harness UID (the
/// iptables REDIRECT rule skips the harness UID, so we set the proxy
/// explicitly on the reqwest client to keep the egress allowlist enforced).
/// Args: `{ url: string, method?: string, headers?: object, body?: string }`.
async fn http_fetch(args: serde_json::Value, timeout: Duration) -> ToolResult {
    let url = match args.get("url").and_then(|v| v.as_str()) {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => return ToolResult::err("http_fetch: args.url (string) is required"),
    };

    let method = args
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .to_ascii_uppercase();

    // ponytail: explicit proxy; the iptables REDIRECT rule skips the harness
    // UID so env-var injection only covers child processes, not this process.
    let proxy = match reqwest::Proxy::all("http://127.0.0.1:3128") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(format!("http_fetch: cannot build proxy config: {e}")),
    };
    let mut builder = reqwest::Client::builder().proxy(proxy).timeout(timeout);
    // Broker egress mode (ADR 0026): hosts with a credential-injection rule
    // are presented under the per-VM broker CA; trust it in addition to the
    // built-in roots so http_fetch behaves like the workload does.
    if let Some(ca) = broker_ca_cert() {
        builder = builder.add_root_certificate(ca);
    }
    let client = match builder.build() {
        Ok(c) => c,
        Err(e) => return ToolResult::err(format!("http_fetch: cannot build client: {e}")),
    };

    let method_val: reqwest::Method = method.parse().unwrap_or(reqwest::Method::GET);
    let mut req = client.request(method_val, &url);

    if let Some(headers) = args.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in headers {
            if let Some(val) = v.as_str() {
                req = req.header(k.as_str(), val);
            }
        }
    }

    if let Some(body) = args.get("body").and_then(|v| v.as_str()) {
        req = req.body(body.to_string());
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return ToolResult::err(format!("http_fetch: request failed: {e}")),
    };

    let status = resp.status().as_u16();
    let resp_headers: HashMap<String, String> = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|val| (k.as_str().to_string(), val.to_string()))
        })
        .collect();

    // Stream the body and stop at the cap — never buffer an arbitrarily large
    // (attacker-sized) response first and check afterwards.
    let mut resp = resp;
    let mut body: Vec<u8> = Vec::new();
    let mut truncated = false;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                let room = TOOL_OUTPUT_MAX_BYTES - body.len();
                if chunk.len() > room {
                    body.extend_from_slice(&chunk[..room]);
                    truncated = true;
                    break; // dropping `resp` aborts the transfer
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return ToolResult::err(format!("http_fetch: reading body failed: {e}")),
        }
    }

    ToolResult::ok(serde_json::json!({
        "status": status,
        "headers": resp_headers,
        "body": capped_text(&body, truncated),
        "truncated": truncated,
    }))
}

// ---------------------------------------------------------------------------
// read_file / write_file / list_dir — confined to the workspace root
// ---------------------------------------------------------------------------

/// Max entries `list_dir` returns.
const LIST_DIR_MAX_ENTRIES: usize = 10_000;

/// Confinement root of the file tools. A constant, deliberately: spawn.json
/// `env` and `pal.env.*` boot-args are hydrated into the harness's OWN
/// environment, so any env-chosen root is workload-chosen (`/` would expose
/// the mTLS key under /run/pal).
const WORKSPACE_ROOT: &str = "/workspace";

fn workspace_root() -> Result<PathBuf, String> {
    check_workspace_root(Path::new(WORKSPACE_ROOT))
}

/// `root` must already be canonical (no symlink anywhere in it) and must not
/// be `/`: a workload that could swap /workspace for a link to `/` or
/// /run/pal would otherwise move the confinement root itself.
fn check_workspace_root(root: &Path) -> Result<PathBuf, String> {
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("workspace root {root:?} unavailable: {e}"))?;
    if canonical != root || canonical == Path::new("/") {
        return Err(format!(
            "workspace root {root:?} resolves to {canonical:?}; refusing"
        ));
    }
    Ok(canonical)
}

/// The workload's filesystem credentials on the CURRENT thread for as long as
/// the guard lives (Linux `setfsuid`/`setfsgid` are per-thread syscalls). With
/// a non-root fsuid the kernel drops the fs capabilities (DAC override,
/// chown, …), so every open below is checked against the workload's own
/// permissions — root-owned guest files are out of reach even if a path check
/// were wrong. Restored on drop: the blocking pool reuses threads.
///
/// ponytail: supplementary groups stay the harness's (root's); files readable
/// only via the root GROUP remain readable. Per-thread setgroups if that ever
/// matters.
#[cfg(target_os = "linux")]
struct FsCreds(Option<(libc::c_long, libc::c_long)>);

#[cfg(target_os = "linux")]
impl FsCreds {
    fn assume(id: Option<crate::supervisor::WorkloadIdentity>) -> Result<Self, String> {
        let Some(id) = id else {
            return Ok(Self(None)); // dev: no workload uid, harness creds
        };
        // Raw syscalls, not libc wrappers: explicitly this thread only.
        // SAFETY: setfsuid/setfsgid take an id and return the previous one.
        let prev_gid = unsafe { libc::syscall(libc::SYS_setfsgid, id.gid) };
        // SAFETY: as above.
        let prev_uid = unsafe { libc::syscall(libc::SYS_setfsuid, id.uid) };
        let guard = Self(Some((prev_uid, prev_gid)));
        // The calls report no error; an invalid id (-1) queries the current one.
        // SAFETY: as above; -1 is never applied.
        let (uid, gid) = unsafe {
            (
                libc::syscall(libc::SYS_setfsuid, u32::MAX),
                libc::syscall(libc::SYS_setfsgid, u32::MAX),
            )
        };
        if uid != libc::c_long::from(id.uid) || gid != libc::c_long::from(id.gid) {
            return Err("could not assume the workload's filesystem credentials".into());
        }
        Ok(guard)
    }
}

#[cfg(target_os = "linux")]
impl Drop for FsCreds {
    fn drop(&mut self) {
        if let Some((uid, gid)) = self.0 {
            // SAFETY: restoring the ids returned by `assume`.
            unsafe {
                libc::syscall(libc::SYS_setfsuid, uid);
                libc::syscall(libc::SYS_setfsgid, gid);
            }
        }
    }
}

/// Non-Linux dev hosts: no per-thread fs credentials; the harness's own apply.
#[cfg(not(target_os = "linux"))]
struct FsCreds;

#[cfg(not(target_os = "linux"))]
impl FsCreds {
    fn assume(_id: Option<crate::supervisor::WorkloadIdentity>) -> Result<Self, String> {
        Ok(Self)
    }
}

/// Resolve `requested` (absolute, or relative to `root`) to a canonical path
/// that is `root` or beneath it. Canonicalization resolves every `..` and
/// symlink, so an escape by either is caught by the component-wise prefix
/// check. Returns `(canonical_root, canonical_path)`.
///
/// With `must_exist = false` (writes) the final component may not exist yet:
/// the PARENT is canonicalized and checked, and the leaf must be a plain name.
///
/// This check alone is check-then-open: a workload could swap a parent dir for
/// a symlink after it. `open_confined` closes that window on Linux.
fn resolve_in_workspace(
    root: &Path,
    requested: &str,
    must_exist: bool,
) -> Result<(PathBuf, PathBuf), String> {
    if requested.is_empty() {
        return Err("path is required".into());
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("workspace root {root:?} unavailable: {e}"))?;
    let joined = root.join(requested);
    let resolved = if must_exist {
        joined
            .canonicalize()
            .map_err(|e| format!("{requested}: {e}"))?
    } else {
        let name = match joined.file_name() {
            Some(n) if Path::new(n) != Path::new("..") => n.to_owned(),
            _ => return Err(format!("{requested}: not a file path")),
        };
        let parent = joined
            .parent()
            .ok_or_else(|| format!("{requested}: no parent directory"))?
            .canonicalize()
            .map_err(|e| format!("{requested}: parent: {e}"))?;
        parent.join(name)
    };
    if resolved.starts_with(&root) {
        Ok((root, resolved))
    } else {
        Err(format!("{requested}: outside the workspace root"))
    }
}

/// Plain `open(2)` of an already-validated path. `O_NOFOLLOW` covers the leaf;
/// parents are trusted from the preceding canonicalization.
fn open_path(path: &Path, flags: i32, mode: u32) -> std::io::Result<std::fs::File> {
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: valid NUL-terminated path; the returned fd is owned below.
    let fd = unsafe { libc::open(c.as_ptr(), flags | libc::O_CLOEXEC, mode as libc::c_uint) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `fd` is a fresh descriptor nobody else owns.
    Ok(std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) }))
}

/// Open `path` (canonical, inside canonical `root`) so the KERNEL re-checks
/// containment at open time: openat2 relative to a root fd with
/// RESOLVE_BENEATH (no escape above the root) + RESOLVE_NO_SYMLINKS. The path
/// is canonical, so it legitimately contains no symlink — any symlink seen now
/// was planted after the check, and the open fails (ELOOP) instead of
/// following it out of the workspace. Kernels without openat2 (< 5.6, ENOSYS)
/// fall back to `open_path`.
#[cfg(target_os = "linux")]
fn open_confined(
    root: &Path,
    path: &Path,
    flags: i32,
    mode: u32,
) -> std::io::Result<std::fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    let rel = path
        .strip_prefix(root)
        .map_err(|_| std::io::Error::other("path outside the workspace root"))?;
    let rel = if rel.as_os_str().is_empty() {
        Path::new(".")
    } else {
        rel
    };
    let root_c = std::ffi::CString::new(root.as_os_str().as_bytes())?;
    let rel_c = std::ffi::CString::new(rel.as_os_str().as_bytes())?;
    // SAFETY: valid NUL-terminated path; fd ownership taken immediately.
    let root_fd = unsafe {
        libc::open(
            root_c.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fresh descriptor, owned here.
    let root_fd = unsafe { OwnedFd::from_raw_fd(root_fd) };

    // SAFETY: open_how is plain integers (and #[non_exhaustive], so it cannot
    // be built with a literal); all-zero is a valid value.
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (flags | libc::O_CLOEXEC) as u64;
    // The kernel rejects a non-zero mode without O_CREAT.
    how.mode = if flags & libc::O_CREAT != 0 {
        mode as u64
    } else {
        0
    };
    how.resolve = libc::RESOLVE_BENEATH | libc::RESOLVE_NO_SYMLINKS | libc::RESOLVE_NO_MAGICLINKS;
    // SAFETY: arguments match openat2(2): dirfd, path, &open_how, its size.
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root_fd.as_raw_fd(),
            rel_c.as_ptr(),
            &how as *const libc::open_how,
            std::mem::size_of::<libc::open_how>(),
        )
    };
    if fd >= 0 {
        // SAFETY: fresh descriptor returned by the kernel, owned here.
        return Ok(std::fs::File::from(unsafe {
            OwnedFd::from_raw_fd(fd as i32)
        }));
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ENOSYS) {
        // ponytail: pre-5.6 kernel keeps the check-then-open window.
        return open_path(path, flags, mode);
    }
    Err(err)
}

/// Non-Linux (dev hosts): no openat2; the validated path is opened directly.
#[cfg(not(target_os = "linux"))]
fn open_confined(
    _root: &Path,
    path: &Path,
    flags: i32,
    mode: u32,
) -> std::io::Result<std::fs::File> {
    open_path(path, flags, mode)
}

/// Flags shared by read and write: never follow a final-component symlink,
/// never block on a FIFO the workload planted.
const FS_OPEN_FLAGS: i32 = libc::O_NOFOLLOW | libc::O_NONBLOCK;

/// Reject anything that is not a single-link regular file. A hard link in the
/// workspace to e.g. /etc/shadow would otherwise pass the path check (hard
/// links have no path to canonicalize) while the harness reads/writes it as
/// root.
fn check_regular_file(f: &std::fs::File, requested: &str) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let m = f.metadata().map_err(|e| format!("{requested}: {e}"))?;
    if !m.is_file() {
        return Err(format!("{requested}: not a regular file"));
    }
    if m.nlink() > 1 {
        return Err(format!("{requested}: refusing a hard-linked file"));
    }
    Ok(())
}

fn fs_tool(tool: &str, args: &serde_json::Value, root: &Path) -> ToolResult {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let result = match tool {
        "read_file" => read_file(args, path, root),
        "write_file" => write_file(args, path, root),
        _ => list_dir(path, root),
    };
    result.unwrap_or_else(|e| ToolResult::err(format!("{tool}: {e}")))
}

fn read_file(args: &serde_json::Value, path: &str, root: &Path) -> Result<ToolResult, String> {
    use std::io::Read;
    let max = args
        .get("max_bytes")
        .and_then(|v| v.as_u64())
        .map_or(TOOL_OUTPUT_MAX_BYTES, |m| {
            (m as usize).min(TOOL_OUTPUT_MAX_BYTES)
        });
    let (root, target) = resolve_in_workspace(root, path, true)?;
    let f = open_confined(&root, &target, libc::O_RDONLY | FS_OPEN_FLAGS, 0)
        .map_err(|e| format!("{path}: {e}"))?;
    check_regular_file(&f, path)?;
    let mut buf = Vec::new();
    // One extra byte tells "exactly max" apart from "more than max".
    f.take(max as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("{path}: {e}"))?;
    let truncated = buf.len() > max;
    buf.truncate(max);
    Ok(ToolResult::ok(serde_json::json!({
        "content": capped_text(&buf, truncated),
        "truncated": truncated,
    })))
}

/// `mode` as a JSON number (decimal mode bits) or an octal string ("0644").
/// Only permission bits are honoured — never setuid/setgid/sticky.
fn parse_mode(v: Option<&serde_json::Value>) -> Result<u32, String> {
    let raw = match v {
        None | Some(serde_json::Value::Null) => return Ok(0o644),
        Some(serde_json::Value::Number(n)) => n.as_u64().and_then(|n| u32::try_from(n).ok()),
        Some(serde_json::Value::String(s)) => {
            u32::from_str_radix(s.trim_start_matches("0o"), 8).ok()
        }
        _ => None,
    };
    raw.map(|m| m & 0o777)
        .ok_or_else(|| "mode must be a number or an octal string".into())
}

fn write_file(args: &serde_json::Value, path: &str, root: &Path) -> Result<ToolResult, String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("args.content (string) is required")?;
    if content.len() > TOOL_OUTPUT_MAX_BYTES {
        return Err(format!("content exceeds {TOOL_OUTPUT_MAX_BYTES} bytes"));
    }
    let mode = parse_mode(args.get("mode"))?;
    let (root, target) = resolve_in_workspace(root, path, false)?;
    // No O_TRUNC: truncate only after the file is vetted.
    let mut f = open_confined(
        &root,
        &target,
        libc::O_WRONLY | libc::O_CREAT | FS_OPEN_FLAGS,
        mode,
    )
    .map_err(|e| format!("{path}: {e}"))?;
    check_regular_file(&f, path)?;
    f.set_len(0).map_err(|e| format!("{path}: {e}"))?;
    f.write_all(content.as_bytes())
        .map_err(|e| format!("{path}: {e}"))?;
    // `mode` at create is umask-filtered and ignored for an existing file.
    // Ownership needs no chown: the file was created under the workload's
    // fsuid/fsgid (see `FsCreds`).
    f.set_permissions(std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("{path}: {e}"))?;
    Ok(ToolResult::ok(
        serde_json::json!({ "bytes_written": content.len() }),
    ))
}

fn list_dir(path: &str, root: &Path) -> Result<ToolResult, String> {
    let (root, target) = resolve_in_workspace(root, path, true)?;
    // Open confined, then list THAT directory through its fd, so a swap after
    // the check cannot redirect the listing.
    let dir = open_confined(
        &root,
        &target,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        0,
    )
    .map_err(|e| format!("{path}: {e}"))?;
    let rd = {
        #[cfg(target_os = "linux")]
        let listed = {
            use std::os::fd::AsRawFd;
            std::path::PathBuf::from(format!("/proc/self/fd/{}", dir.as_raw_fd()))
        };
        #[cfg(not(target_os = "linux"))]
        let listed = target.clone();
        std::fs::read_dir(&listed).map_err(|e| format!("{path}: {e}"))?
    };
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in rd {
        if entries.len() == LIST_DIR_MAX_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        // DirEntry metadata does not follow symlinks — a link is reported as
        // a link, never as what it points at.
        let (kind, size) = match entry.metadata() {
            Ok(m) if m.is_symlink() => ("symlink", 0),
            Ok(m) if m.is_dir() => ("dir", 0),
            Ok(m) if m.is_file() => ("file", m.len()),
            _ => ("other", 0),
        };
        entries.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy(),
            "type": kind,
            "size": size,
        }));
    }
    drop(dir);
    Ok(ToolResult::ok(serde_json::json!({
        "entries": entries,
        "truncated": truncated,
    })))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The broker CA from `PAL_EGRESS_CA_PEM`, in broker mode only.
fn broker_ca_cert() -> Option<reqwest::Certificate> {
    // The installed file first: re-identify (resume/fork) rewrites it with
    // the new incarnation's CA; the boot env would still hold the old one.
    let pem = std::fs::read_to_string(crate::egress::BROKER_CA_FILE)
        .ok()
        .or_else(|| std::env::var("PAL_EGRESS_CA_PEM").ok());
    broker_ca_from(
        std::env::var("PAL_EGRESS_MODE").ok().as_deref(),
        pem.as_deref(),
    )
}

fn broker_ca_from(mode: Option<&str>, pem: Option<&str>) -> Option<reqwest::Certificate> {
    if !crate::egress::is_broker_mode(mode) {
        return None;
    }
    // reqwest (rustls) defers PEM parsing to `build()`, where a bad CA would
    // fail every fetch; reject non-certificate input up front instead.
    let pem = pem.filter(|p| p.contains("-----BEGIN CERTIFICATE-----"))?;
    match reqwest::Certificate::from_pem(pem.as_bytes()) {
        Ok(c) => Some(c),
        Err(e) => {
            tracing::warn!(error = %e, "http_fetch: broker CA unparseable; injected hosts will fail TLS");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(tool: &str, args: serde_json::Value) -> ToolEnvelope {
        ToolEnvelope {
            tool: tool.to_string(),
            args,
            idempotency_key: "test:1".to_string(),
            timeout_sec: 10,
        }
    }

    // --- dispatch + shell_exec ---

    #[tokio::test]
    async fn shell_exec_captures_stdout_and_exit_zero() {
        let res = dispatch(env(
            "shell_exec",
            serde_json::json!({"command": "printf hello"}),
        ))
        .await;
        assert!(res.ok, "expected ok, got error: {:?}", res.error);
        let r = res.result.unwrap();
        assert_eq!(r["stdout"].as_str().unwrap(), "hello");
        assert_eq!(r["exit_code"], 0);
    }

    #[tokio::test]
    async fn shell_exec_propagates_exit_code() {
        let res = dispatch(env("shell_exec", serde_json::json!({"command": "exit 7"}))).await;
        assert!(res.ok);
        assert_eq!(res.result.unwrap()["exit_code"], 7);
    }

    #[tokio::test]
    async fn shell_exec_captures_stderr() {
        let res = dispatch(env(
            "shell_exec",
            serde_json::json!({"command": "printf err 1>&2"}),
        ))
        .await;
        assert!(res.ok);
        assert_eq!(res.result.unwrap()["stderr"].as_str().unwrap(), "err");
    }

    #[tokio::test]
    async fn shell_exec_missing_command_field() {
        let res = dispatch(env("shell_exec", serde_json::json!({}))).await;
        assert!(!res.ok);
        assert!(
            res.error.unwrap().contains("command"),
            "error must mention the missing field"
        );
    }

    #[tokio::test]
    async fn unknown_tool_returns_typed_error() {
        let res = dispatch(env("not_a_real_tool", serde_json::Value::Null)).await;
        assert!(!res.ok);
        assert!(
            res.error
                .as_deref()
                .unwrap_or("")
                .contains("unknown tool: not_a_real_tool"),
            "error must name the unknown tool, got: {:?}",
            res.error
        );
    }

    // --- http_fetch arg validation (no actual network needed) ---

    #[tokio::test]
    async fn http_fetch_missing_url_field() {
        let res = dispatch(env("http_fetch", serde_json::json!({}))).await;
        assert!(!res.ok);
        assert!(
            res.error.as_deref().unwrap_or("").contains("url"),
            "error must mention the missing field"
        );
    }

    #[tokio::test]
    async fn shell_exec_caps_output_with_marker() {
        // 1 MiB + 1000 bytes: must come back at exactly the cap + marker.
        let res = dispatch(env(
            "shell_exec",
            serde_json::json!({"command": "head -c 1049576 /dev/zero | tr '\\0' a"}),
        ))
        .await;
        assert!(res.ok, "{:?}", res.error);
        let r = res.result.unwrap();
        let out = r["stdout"].as_str().unwrap();
        assert!(out.ends_with(TRUNCATED_MARKER));
        assert_eq!(out.len(), TOOL_OUTPUT_MAX_BYTES + TRUNCATED_MARKER.len());
        assert_eq!(r["truncated"], true);
        assert_eq!(
            r["exit_code"], 0,
            "draining past the cap lets the child finish"
        );
    }

    #[tokio::test]
    async fn shell_exec_enforces_timeout() {
        let mut e = env("shell_exec", serde_json::json!({"command": "sleep 5"}));
        e.timeout_sec = 1;
        let started = Instant::now();
        let res = dispatch(e).await;
        assert!(!res.ok);
        assert!(res.error.unwrap().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[tokio::test]
    async fn read_capped_bounds_memory_and_flags_truncation() {
        let data = [7u8; 100];
        let (kept, trunc) = read_capped(&data[..], 10).await.unwrap();
        assert_eq!((kept.len(), trunc), (10, true));
        let (kept, trunc) = read_capped(&data[..], 100).await.unwrap();
        assert_eq!(
            (kept.len(), trunc),
            (100, false),
            "exactly-at-cap is not truncated"
        );
    }

    // --- fs tools ---

    /// A fresh workspace root plus a sibling "outside" dir holding a secret.
    fn sandbox(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("pal-ws-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let ws = base.join("ws");
        std::fs::create_dir_all(ws.join("sub")).unwrap();
        std::fs::create_dir_all(base.join("outside")).unwrap();
        std::fs::write(base.join("outside/secret"), "s3cret").unwrap();
        std::fs::write(ws.join("sub/hello.txt"), "hello world").unwrap();
        (base, ws)
    }

    #[test]
    fn fs_tools_read_write_list_inside_root() {
        let (base, ws) = sandbox("ok");
        let r = fs_tool(
            "read_file",
            &serde_json::json!({"path": "sub/hello.txt"}),
            &ws,
        );
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(r.result.as_ref().unwrap()["content"], "hello world");

        let r = fs_tool(
            "read_file",
            &serde_json::json!({"path": "sub/hello.txt", "max_bytes": 5}),
            &ws,
        );
        let v = r.result.unwrap();
        assert_eq!(v["content"], format!("hello{TRUNCATED_MARKER}"));
        assert_eq!(v["truncated"], true);

        let abs = ws.join("sub/new.txt");
        let r = fs_tool(
            "write_file",
            &serde_json::json!({"path": abs.to_str().unwrap(), "content": "hi", "mode": "0600"}),
            &ws,
        );
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "hi");
        {
            use std::os::unix::fs::PermissionsExt;
            let m = std::fs::metadata(&abs).unwrap().permissions().mode() & 0o7777;
            assert_eq!(m, 0o600);
        }

        let r = fs_tool("list_dir", &serde_json::json!({"path": "sub"}), &ws);
        let v = r.result.unwrap();
        let mut names: Vec<&str> = v["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, vec!["hello.txt", "new.txt"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fs_tools_reject_dotdot_traversal() {
        let (base, ws) = sandbox("dotdot");
        for (tool, args) in [
            (
                "read_file",
                serde_json::json!({"path": "../outside/secret"}),
            ),
            (
                "read_file",
                serde_json::json!({"path": "sub/../../outside/secret"}),
            ),
            (
                "write_file",
                serde_json::json!({"path": "../outside/pwn", "content": "x"}),
            ),
            (
                "write_file",
                serde_json::json!({"path": "sub/..", "content": "x"}),
            ),
            ("list_dir", serde_json::json!({"path": ".."})),
            ("read_file", serde_json::json!({"path": "/etc/passwd"})),
            ("read_file", serde_json::json!({"path": ""})),
        ] {
            let r = fs_tool(tool, &args, &ws);
            assert!(!r.ok, "{tool} {args} must be rejected");
        }
        assert!(!base.join("outside/pwn").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fs_tools_reject_symlink_escape() {
        let (base, ws) = sandbox("symlink");
        std::os::unix::fs::symlink(base.join("outside/secret"), ws.join("leak")).unwrap();
        std::os::unix::fs::symlink(base.join("outside"), ws.join("outdir")).unwrap();

        let r = fs_tool("read_file", &serde_json::json!({"path": "leak"}), &ws);
        assert!(!r.ok, "file symlink out of the root must be rejected");
        let r = fs_tool(
            "read_file",
            &serde_json::json!({"path": "outdir/secret"}),
            &ws,
        );
        assert!(!r.ok, "dir symlink out of the root must be rejected");
        let r = fs_tool("list_dir", &serde_json::json!({"path": "outdir"}), &ws);
        assert!(!r.ok);
        // Writing THROUGH a leaf symlink must not clobber its target.
        let r = fs_tool(
            "write_file",
            &serde_json::json!({"path": "leak", "content": "pwned"}),
            &ws,
        );
        assert!(!r.ok, "write through a symlink must be rejected");
        let r = fs_tool(
            "write_file",
            &serde_json::json!({"path": "outdir/new", "content": "pwned"}),
            &ws,
        );
        assert!(!r.ok);
        assert_eq!(
            std::fs::read_to_string(base.join("outside/secret")).unwrap(),
            "s3cret"
        );
        assert!(!base.join("outside/new").exists());

        // An in-root symlink to an in-root file is fine.
        std::os::unix::fs::symlink(ws.join("sub/hello.txt"), ws.join("alias")).unwrap();
        let r = fs_tool("read_file", &serde_json::json!({"path": "alias"}), &ws);
        assert!(r.ok, "{:?}", r.error);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The parent-dir TOCTOU: the path is validated, THEN a parent is swapped
    /// for a symlink out of the root. openat2 must refuse the open.
    #[cfg(target_os = "linux")]
    #[test]
    fn open_confined_refuses_a_parent_swapped_after_the_check() {
        let (base, ws) = sandbox("toctou");
        std::fs::write(base.join("outside/hello.txt"), "outside").unwrap();
        let (root, target) = resolve_in_workspace(&ws, "sub/hello.txt", true).unwrap();
        std::fs::rename(ws.join("sub"), ws.join("sub_old")).unwrap();
        std::os::unix::fs::symlink(base.join("outside"), ws.join("sub")).unwrap();

        // Precondition: the plain open really would land outside the root.
        let mut escaped = String::new();
        std::io::Read::read_to_string(
            &mut open_path(&target, libc::O_RDONLY | FS_OPEN_FLAGS, 0).unwrap(),
            &mut escaped,
        )
        .unwrap();
        assert_eq!(escaped, "outside");

        let r = open_confined(&root, &target, libc::O_RDONLY | FS_OPEN_FLAGS, 0);
        assert!(r.is_err(), "swapped parent must not be followed");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fs_tools_reject_hard_links() {
        let (base, ws) = sandbox("hardlink");
        std::fs::hard_link(base.join("outside/secret"), ws.join("hl")).unwrap();
        let r = fs_tool("read_file", &serde_json::json!({"path": "hl"}), &ws);
        assert!(!r.ok);
        let r = fs_tool(
            "write_file",
            &serde_json::json!({"path": "hl", "content": "x"}),
            &ws,
        );
        assert!(!r.ok);
        assert_eq!(
            std::fs::read_to_string(base.join("outside/secret")).unwrap(),
            "s3cret"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The confinement root is fixed: a workload-supplied PAL_WORKSPACE
    /// (spawn.json env / pal.env.* both land in the harness env) cannot
    /// widen it to `/`.
    #[tokio::test]
    async fn workload_pal_workspace_cannot_widen_the_root() {
        // SAFETY: PAL_WORKSPACE is read by no harness code (that is the
        // point of the test); std's env lock serialises std readers.
        unsafe { std::env::set_var("PAL_WORKSPACE", "/") };
        let r = dispatch(env("read_file", serde_json::json!({"path": "etc/passwd"}))).await;
        unsafe { std::env::remove_var("PAL_WORKSPACE") };
        assert!(!r.ok, "read outside /workspace must fail: {:?}", r.result);
        assert_eq!(WORKSPACE_ROOT, "/workspace");
    }

    #[test]
    fn workspace_root_must_be_canonical_and_not_slash() {
        assert!(check_workspace_root(Path::new("/")).is_err());
        let (base, ws) = sandbox("rootcheck");
        let ws = ws.canonicalize().unwrap();
        assert_eq!(check_workspace_root(&ws).unwrap(), ws);
        // A root that is (or passes through) a symlink is refused, even when
        // it points somewhere harmless.
        let cbase = base.canonicalize().unwrap();
        std::os::unix::fs::symlink(&ws, cbase.join("link-to-ws")).unwrap();
        assert!(check_workspace_root(&cbase.join("link-to-ws")).is_err());
        std::os::unix::fs::symlink("/", cbase.join("link-to-slash")).unwrap();
        assert!(check_workspace_root(&cbase.join("link-to-slash")).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// File tools run under the workload's fs credentials. As root (the
    /// in-guest harness): a root-only file is unreadable while assumed and
    /// readable again after the guard drops. As non-root (CI): assuming
    /// another uid is impossible and reported, never silently ignored.
    #[cfg(target_os = "linux")]
    #[test]
    fn fs_creds_apply_the_workload_identity_per_thread() {
        use crate::supervisor::WorkloadIdentity;
        use std::os::unix::fs::PermissionsExt;
        // SAFETY: plain id getters.
        let (euid, egid) = unsafe { (libc::geteuid(), libc::getegid()) };
        if euid == 0 {
            let (base, ws) = sandbox("fscreds");
            let f = ws.join("root-only");
            std::fs::write(&f, "x").unwrap();
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
            {
                let _g = FsCreds::assume(Some(WorkloadIdentity {
                    uid: 65534,
                    gid: 65534,
                }))
                .expect("root can assume");
                assert_eq!(
                    std::fs::read(&f).unwrap_err().kind(),
                    std::io::ErrorKind::PermissionDenied
                );
            }
            assert!(std::fs::read(&f).is_ok(), "creds restored on drop");
            let _ = std::fs::remove_dir_all(&base);
        } else {
            assert!(
                FsCreds::assume(Some(WorkloadIdentity {
                    uid: euid,
                    gid: egid
                }))
                .is_ok()
            );
            assert!(
                FsCreds::assume(Some(WorkloadIdentity {
                    uid: euid + 1,
                    gid: egid + 1
                }))
                .is_err(),
                "a failed switch must be reported"
            );
        }
    }

    #[test]
    fn write_file_caps_content_and_validates_mode() {
        let (base, ws) = sandbox("wcap");
        let big = "a".repeat(TOOL_OUTPUT_MAX_BYTES + 1);
        let r = fs_tool(
            "write_file",
            &serde_json::json!({"path": "big", "content": big}),
            &ws,
        );
        assert!(!r.ok);
        assert_eq!(parse_mode(Some(&serde_json::json!(0o4755))).unwrap(), 0o755);
        assert!(parse_mode(Some(&serde_json::json!("rwx"))).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    // --- ToolResult serialisation round-trip ---

    #[test]
    fn tool_result_ok_serialises_without_error_key() {
        let r = ToolResult::ok(serde_json::json!({"x": 1}));
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"ok\":true"));
        assert!(!s.contains("\"error\""), "error key must be omitted on ok");
    }

    #[test]
    fn tool_result_err_serialises_without_result_key() {
        let r = ToolResult::err("oops");
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"ok\":false"));
        assert!(
            !s.contains("\"result\""),
            "result key must be omitted on err"
        );
    }

    #[test]
    fn http_fetch_trusts_broker_ca_only_in_broker_mode() {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
        let pem = params.self_signed(&key).unwrap().pem();
        assert!(broker_ca_from(Some("broker"), Some(&pem)).is_some());
        assert!(broker_ca_from(None, Some(&pem)).is_none());
        assert!(broker_ca_from(Some("broker"), None).is_none());
        assert!(broker_ca_from(Some("broker"), Some("not a pem")).is_none());
    }
}
