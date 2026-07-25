// In-guest tool registry.
//
// JSON-over-Exec channel envelope (manager → harness)
// ---------------------------------------------------
// Adding a typed ExecTool RPC to RuntimeHarness would require re-running
// protoc and updating gen/go stubs. Instead we reuse the existing
// RuntimeHarness.Exec stream at port 50056 with a magic command sentinel:
//
//   ExecRequest { command: "__lantern_tool_call__", argv: [<envelope_json>] }
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
//               Runs `/bin/sh -c <command>`, returns stdout/stderr/exit_code.
//
//   http_fetch  args: { url: string, method?: string, headers?: object, body?: string }
//               HTTP request THROUGH the egress proxy at 127.0.0.1:3128 so the
//               egress allowlist applies. Response body capped at 1 MiB.
//               Unknown tool → {"ok":false,"error":"unknown tool: <name>"}.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
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

/// Handle a `__lantern_tool_call__` ExecRequest. Parses the envelope from
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
        other => ToolResult::err(format!("unknown tool: {other}")),
    }
}

// ---------------------------------------------------------------------------
// shell_exec
// ---------------------------------------------------------------------------

/// Run `/bin/sh -c <command>`, capture stdout/stderr/exit_code.
/// Args: `{ command: string }`.
async fn shell_exec(args: serde_json::Value, timeout: Duration) -> ToolResult {
    let command = match args.get("command").and_then(|v| v.as_str()) {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => return ToolResult::err("shell_exec: args.command (string) is required"),
    };

    let run = tokio::time::timeout(timeout, async {
        tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&command)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .output()
            .await
    })
    .await;

    match run {
        Err(_) => ToolResult::err(format!(
            "shell_exec: timed out after {}s",
            timeout.as_secs()
        )),
        Ok(Err(e)) => ToolResult::err(format!("shell_exec: spawn failed: {e}")),
        Ok(Ok(out)) => ToolResult::ok(serde_json::json!({
            "stdout": String::from_utf8_lossy(&out.stdout).into_owned(),
            "stderr": String::from_utf8_lossy(&out.stderr).into_owned(),
            "exit_code": out.status.code().unwrap_or(-1),
        })),
    }
}

// ---------------------------------------------------------------------------
// http_fetch
// ---------------------------------------------------------------------------

/// Maximum response body size (1 MiB). Bodies exceeding this are truncated.
const HTTP_FETCH_MAX_BODY: usize = 1 << 20;

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
    let client = match reqwest::Client::builder()
        .proxy(proxy)
        .timeout(timeout)
        .build()
    {
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

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return ToolResult::err(format!("http_fetch: reading body failed: {e}")),
    };

    let body_str = if bytes.len() > HTTP_FETCH_MAX_BODY {
        format!(
            "<truncated: response body exceeded {} bytes>",
            HTTP_FETCH_MAX_BODY
        )
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    ToolResult::ok(serde_json::json!({
        "status": status,
        "headers": resp_headers,
        "body": body_str,
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
}
