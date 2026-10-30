// Supervisor: spawns the workload binary as a child process, tails stdio,
// restarts on crash up to N times, and exits cleanly when the workload
// exits successfully.
//
// PID 1 contract: the harness is the init process. Linux gives PID 1 the
// responsibility of reaping orphaned zombies — we do that in a separate
// task in `signals.rs`. The supervisor itself only `wait`s on its direct
// child.

use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use anyhow::{Context, Result};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::Mutex;

use crate::activity::ActivityTracker;
use crate::manager_client::ManagerClient;
use crate::proto::{AuditEvent, HarnessReport, now_unix_ms};

const DEFAULT_MAX_RESTARTS: i32 = 5;

/// Localhost addresses + suffixes the workload must NOT proxy — the egress
/// proxy itself, the secrets socket host, and link-local metadata are all
/// reached (or blocked) directly, never through the CONNECT proxy.
const DEFAULT_NO_PROXY: &str = "127.0.0.1,localhost,::1,169.254.169.254";

/// Compute the proxy environment to inject into the workload, given the proxy
/// endpoint host:port. Returns the `(KEY, VALUE)` pairs.
///
/// P2-B7 (2): the egress allowlist proxy (`egress.rs`) is only *advisory*
/// unless traffic is forced through it. The harness forces it two ways:
///   1. iptables REDIRECT in the VM image (true enforcement; see egress.rs
///      header + the boot preflight in `main.rs`), and
///   2. proxy env injection here, so well-behaved clients (most HTTP libs,
///      curl, requests, openai-python) honor the allowlist even where the
///      REDIRECT layer is absent (defence in depth, not a substitute).
///
/// We set both upper- and lower-case forms because libraries disagree on which
/// they read (curl reads lower-case `http_proxy`; many read upper-case).
#[must_use]
pub fn proxy_env_pairs(proxy_addr: &str) -> Vec<(String, String)> {
    let url = format!("http://{proxy_addr}");
    let no_proxy = std::env::var("PAL_NO_PROXY").unwrap_or_else(|_| DEFAULT_NO_PROXY.to_string());
    let mut pairs = Vec::with_capacity(9);
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
        pairs.push((key.to_string(), url.clone()));
        pairs.push((key.to_lowercase(), url.clone()));
    }
    pairs.push(("NO_PROXY".to_string(), no_proxy.clone()));
    pairs.push(("no_proxy".to_string(), no_proxy));
    pairs
}

/// The unprivileged identity every workload-side child runs as.
///
/// The harness is PID 1 (root). Before this, the workload, `shell_exec` tool
/// calls and `vm exec` children all inherited that uid — which made the
/// SO_PEERCRED secrets check meaningless (workload uid == harness uid, always
/// allowed), exempted the workload from the iptables REDIRECT (it skips the
/// harness uid, see egress.rs), and let it read the mTLS private key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkloadIdentity {
    pub uid: u32,
    pub gid: u32,
}

/// Parse the manager-injected uid/gid. gid defaults to the uid: dropping the
/// uid while keeping gid 0 would leave the child in the root group.
fn parse_identity(uid: Option<&str>, gid: Option<&str>) -> Option<WorkloadIdentity> {
    let uid = uid?.trim().parse::<u32>().ok()?;
    let gid = gid
        .and_then(|g| g.trim().parse::<u32>().ok())
        .unwrap_or(uid);
    Some(WorkloadIdentity { uid, gid })
}

/// `PAL_WORKLOAD_UID` / `PAL_WORKLOAD_GID`, if set. Unset is the dev
/// path (children keep the harness uid); prod refuses to boot without a uid
/// (see `SecretCache::serve`).
pub fn workload_identity() -> Option<WorkloadIdentity> {
    parse_identity(
        std::env::var("PAL_WORKLOAD_UID").ok().as_deref(),
        std::env::var("PAL_WORKLOAD_GID").ok().as_deref(),
    )
}

/// Make `cmd` exec as `id`. std's child setup calls `setgroups(0, NULL)`
/// before `setuid` when no explicit groups are given, so supplementary groups
/// are cleared too — no `pre_exec` needed.
pub fn apply_workload_identity(cmd: &mut Command, id: Option<WorkloadIdentity>) -> &mut Command {
    if let Some(id) = id {
        cmd.uid(id.uid).gid(id.gid);
    }
    cmd
}

/// `PAL_*` keys a workload child may see: identity/locator values the
/// workload SDK reads, none of them secret.
const WORKLOAD_VISIBLE_PAL_KEYS: [&str; 14] = [
    // Crash re-drive marker: the agent skips steps already in the journal (09-agent-runtime.md).
    "PAL_RESUME",
    "PAL_VM_ID",
    "PAL_RUN_ID",
    // Manager-stamped from the authenticated spawn (the SDK reads the tenant).
    "PAL_TENANT_ID",
    "PAL_AGENT_VERSION_ID",
    "PAL_ENV",
    "PAL_SECRETS_SOCKET",
    "PAL_OTLP_SOCKET",
    "PAL_WORKSPACE",
    "PAL_TRACE_PARENT",
    "PAL_WORKLOAD_UID",
    "PAL_WORKLOAD_GID",
    "PAL_WORKLOAD_CMD",
    "PAL_WORKLOAD_ARGV",
];

/// Whether an env var of the harness may be passed to a workload child.
///
/// Every variable the harness itself reads lives in the `PAL_*`
/// namespace — exec token, agent-instance token, TLS key/cert/CA paths,
/// declared secret URIs, manager address. All of it is withheld except the
/// allowlist above. Everything else (PATH, HOME, the spec's own env from
/// spawn.json / `pal.env.*` / a container runtime) is the workload's and
/// passes through.
///
/// ponytail: namespace rule, so a user env key that itself starts with
/// `PAL_` is withheld too. Track declared keys explicitly if a spec ever
/// needs one.
fn workload_may_see(key: &str) -> bool {
    !key.starts_with("PAL_") || WORKLOAD_VISIBLE_PAL_KEYS.contains(&key)
}

/// Filter an environment down to what a workload child may inherit.
/// Output order: pass-through keys in input order, then the visible
/// harness-namespace keys sorted by name.
fn workload_env_from(
    vars: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    use std::collections::BTreeMap;
    let mut out = Vec::new();
    let mut ns: BTreeMap<String, std::ffi::OsString> = BTreeMap::new();
    for (k, v) in vars {
        let Some(key) = k.to_str().filter(|key| workload_may_see(key)) else {
            continue;
        };
        if key.starts_with("PAL_") {
            ns.insert(key.to_owned(), v);
        } else {
            out.push((k, v));
        }
    }
    out.extend(ns.into_iter().map(|(k, v)| (k.into(), v)));
    out
}

/// Prepare `cmd` to run as the workload: an explicitly-built environment
/// (`env_clear` + the filtered harness env, so no harness secret is
/// inherited) and the unprivileged uid/gid. Callers add their own vars
/// (proxy, TERM) AFTER this.
pub fn as_workload(cmd: &mut Command) -> &mut Command {
    cmd.env_clear().envs(workload_env_from(std::env::vars_os()));
    apply_workload_identity(cmd, workload_identity())
}

/// The proxy address the workload should be pointed at — the same bind the
/// egress proxy listens on (`PAL_EGRESS_BIND`, default `127.0.0.1:3128`).
fn egress_proxy_addr() -> String {
    std::env::var("PAL_EGRESS_BIND").unwrap_or_else(|_| "127.0.0.1:3128".to_string())
}

#[derive(Clone)]
pub struct Supervisor {
    workload_cmd: Vec<String>,
    max_restarts: i32,
    manager: ManagerClient,
    activity: ActivityTracker,
    /// When true, inject HTTP(S)_PROXY/ALL_PROXY/NO_PROXY into the workload env
    /// so its HTTP clients route through the egress allowlist proxy. Set when
    /// the AgentSpec declares egress rules (P2-B7 fix #2).
    inject_proxy_env: bool,
    /// Extra workload env (broker-mode CA bundle paths, ADR 0026).
    extra_env: Vec<(String, String)>,

    restart_count: Arc<AtomicI32>,
    worker_pid: Arc<AtomicI32>,
    draining: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

/// Handles the supervisor exposes so other subsystems can read live state.
#[derive(Clone)]
pub struct SupervisorHandles {
    pub restart_count: Arc<AtomicI32>,
    pub worker_pid: Arc<AtomicI32>,
    pub draining: Arc<AtomicBool>,
    pub child: Arc<Mutex<Option<Child>>>,
}

/// Stdio handles for the log forwarder. Re-issued on every restart.
pub struct WorkloadStdio {
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

impl Supervisor {
    pub fn new(
        workload_cmd: Vec<String>,
        manager: ManagerClient,
        activity: ActivityTracker,
    ) -> Self {
        Self {
            workload_cmd,
            max_restarts: std::env::var("PAL_MAX_RESTARTS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(DEFAULT_MAX_RESTARTS),
            manager,
            activity,
            inject_proxy_env: false,
            extra_env: Vec::new(),
            restart_count: Arc::new(AtomicI32::new(0)),
            worker_pid: Arc::new(AtomicI32::new(0)),
            draining: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
        }
    }

    /// Enable proxy-env injection into the workload. Call with `true` when the
    /// AgentSpec declares egress rules so the workload's HTTP clients route
    /// through the allowlist proxy (P2-B7 fix #2).
    #[must_use]
    pub fn with_proxy_env(mut self, enabled: bool) -> Self {
        self.inject_proxy_env = enabled;
        self
    }

    /// Add env vars to every workload spawn (after the env filter).
    #[must_use]
    pub fn with_extra_env(mut self, env: Vec<(String, String)>) -> Self {
        self.extra_env = env;
        self
    }

    pub fn handles(&self) -> SupervisorHandles {
        SupervisorHandles {
            restart_count: Arc::clone(&self.restart_count),
            worker_pid: Arc::clone(&self.worker_pid),
            draining: Arc::clone(&self.draining),
            child: Arc::clone(&self.child),
        }
    }

    /// Spawn the workload. Returns the stdio handles to feed the log
    /// forwarder. Subsequent restarts re-issue fresh handles via the
    /// `stdio_tx` channel.
    pub async fn run(self, stdio_tx: tokio::sync::mpsc::Sender<WorkloadStdio>) -> Result<i32> {
        if self.workload_cmd.is_empty() {
            anyhow::bail!("PAL_WORKLOAD_CMD is empty — nothing to supervise");
        }

        loop {
            if self.draining.load(Ordering::SeqCst) {
                tracing::info!("supervisor: draining, not restarting workload");
                return Ok(0);
            }

            let attempt = self.restart_count.load(Ordering::SeqCst);
            tracing::info!(
                attempt,
                cmd = ?self.workload_cmd,
                "supervisor: spawning workload"
            );

            let mut cmd = Command::new(&self.workload_cmd[0]);
            cmd.args(&self.workload_cmd[1..])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null())
                .kill_on_drop(true);
            as_workload(&mut cmd);

            // P2-B7 (2): point the workload's HTTP clients at the egress
            // allowlist proxy. Only when egress rules are declared — otherwise
            // there's nothing to enforce and an unset proxy is correct.
            if self.inject_proxy_env {
                let addr = egress_proxy_addr();
                for (k, v) in proxy_env_pairs(&addr) {
                    cmd.env(k, v);
                }
                tracing::info!(
                    proxy = %addr,
                    "supervisor: injected HTTP(S)_PROXY/ALL_PROXY/NO_PROXY into workload env \
                     (egress allowlist)"
                );
            }

            cmd.envs(self.extra_env.iter().map(|(k, v)| (k, v)));

            let mut child = cmd
                .spawn()
                .with_context(|| format!("failed to spawn {:?}", self.workload_cmd))?;

            let pid = child.id().map(|p| p as i32).unwrap_or(-1);
            self.worker_pid.store(pid, Ordering::SeqCst);

            // Mark this workload process as active for the idle-suspend logic.
            // The guard is dropped when the child exits (end of this loop iteration).
            let _activity_guard = self.activity.child_started();

            // Emit an audit event for the exec.
            self.manager
                .enqueue_report(HarnessReport::Audit(AuditEvent {
                    vm_id: self.manager.vm_id(),
                    action: "exec".into(),
                    at_unix_ms: now_unix_ms(),
                    attrs: [
                        ("pid".into(), pid.to_string()),
                        ("cmd".into(), self.workload_cmd.join(" ")),
                        ("attempt".into(), attempt.to_string()),
                    ]
                    .into_iter()
                    .collect(),
                }))
                .await;

            // Hand stdio off to the log forwarder.
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let _ = stdio_tx.send(WorkloadStdio { stdout, stderr }).await;

            // Park the child so signal handlers + other subsystems can see it.
            {
                let mut slot = self.child.lock().await;
                *slot = Some(child);
            }

            // Wait on the child without holding the mutex for the await.
            // We pop the child out of the slot so other subsystems that
            // only need the pid can still observe it via `worker_pid`.
            let mut child_opt = {
                let mut slot = self.child.lock().await;
                slot.take()
            };
            let status = if let Some(c) = child_opt.as_mut() {
                c.wait().await.context("waiting on workload")?
            } else {
                // Drained between spawn and wait.
                return Ok(0);
            };

            // Child has exited — drop the activity guard so the tracker stamps
            // last_activity_unix_ms before the restart loop decides what to do.
            drop(_activity_guard);

            tracing::info!(?status, "workload exited");
            let exit_code = status.code().unwrap_or(-1);

            if status.success() {
                tracing::info!("supervisor: workload exited successfully, harness shutting down");
                return Ok(exit_code);
            }

            let next = self.restart_count.fetch_add(1, Ordering::SeqCst) + 1;
            if next > self.max_restarts {
                tracing::error!(
                    next,
                    max = self.max_restarts,
                    "supervisor: workload exhausted restart budget"
                );
                return Ok(exit_code);
            }

            // Linear-ish backoff. Avoid hammering the system on crash loops.
            let backoff_ms = (next as u64).saturating_mul(500).min(10_000);
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn workload_sees_resume_marker() {
        let env = workload_env_from(
            [("PAL_RESUME", "1"), ("PAL_EGRESS_FAIL_CLOSED", "0")]
                .into_iter()
                .map(|(k, v)| (k.into(), v.into())),
        );
        let keys: Vec<_> = env
            .iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert!(keys.contains(&"PAL_RESUME".to_string()));
        assert!(!keys.contains(&"PAL_EGRESS_FAIL_CLOSED".to_string()));
    }

    fn env_map(vars: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
        workload_env_from(vars.iter().map(|(k, v)| ((*k).into(), (*v).into())))
            .into_iter()
            .map(|(k, v)| (k.into_string().unwrap(), v.into_string().unwrap()))
            .collect()
    }

    /// The harness's own config (exec token, agent-instance token, TLS
    /// paths, declared secret URIs) is withheld from the workload.
    #[test]
    fn workload_never_sees_pal_harness_config() {
        let env = env_map(&[
            ("PAL_HARNESS_EXEC_TOKEN", "secret"),
            ("PAL_AGENT_INSTANCE_TOKEN", "secret"),
            ("PAL_VM_TLS_KEY", "/k"),
            ("PAL_DECLARED_SECRETS", "[]"),
            ("PAL_EGRESS_FAIL_CLOSED", "0"),
            ("PAL_", "x"),
            ("PATH", "/bin"),
        ]);
        assert_eq!(env.keys().collect::<Vec<_>>(), vec!["PATH"]);
    }

    /// The 14 visible keys reach the workload unchanged.
    #[test]
    fn visible_keys_pass_through() {
        let env = env_map(&[
            ("PAL_RUN_ID", "r1"),
            ("PAL_VM_ID", "vm1"),
            ("PAL_TENANT_ID", "t1"),
            ("PAL_WORKSPACE", "/w"),
        ]);
        for (k, v) in [
            ("PAL_RUN_ID", "r1"),
            ("PAL_VM_ID", "vm1"),
            ("PAL_TENANT_ID", "t1"),
            ("PAL_WORKSPACE", "/w"),
        ] {
            assert_eq!(env.get(k).map(String::as_str), Some(v), "{k}");
        }
        assert_eq!(env.len(), 4);
        for key in WORKLOAD_VISIBLE_PAL_KEYS {
            assert!(workload_may_see(key), "{key}");
        }
    }

    #[test]
    fn proxy_env_sets_all_three_proxy_vars_both_cases() {
        let pairs = proxy_env_pairs("127.0.0.1:3128");
        let map: HashMap<_, _> = pairs.into_iter().collect();
        let want = "http://127.0.0.1:3128";
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
            assert_eq!(
                map.get(key).map(String::as_str),
                Some(want),
                "{key} must be set"
            );
            assert_eq!(
                map.get(&key.to_lowercase()).map(String::as_str),
                Some(want),
                "{} (lower-case) must be set",
                key.to_lowercase()
            );
        }
    }

    #[test]
    fn proxy_env_no_proxy_keeps_loopback_and_metadata_direct() {
        let pairs = proxy_env_pairs("127.0.0.1:3128");
        let map: HashMap<_, _> = pairs.into_iter().collect();
        let no_proxy = map.get("NO_PROXY").expect("NO_PROXY must be set");
        // Loopback + metadata must bypass the proxy so the secrets socket host,
        // the proxy itself, and metadata-blocking stay direct.
        assert!(no_proxy.contains("127.0.0.1"));
        assert!(no_proxy.contains("169.254.169.254"));
        assert_eq!(
            map.get("no_proxy").map(String::as_str),
            map.get("NO_PROXY").map(String::as_str),
            "lower-case no_proxy must mirror NO_PROXY"
        );
    }

    #[test]
    fn identity_gid_defaults_to_uid_and_garbage_is_none() {
        assert_eq!(
            parse_identity(Some("1000"), None),
            Some(WorkloadIdentity {
                uid: 1000,
                gid: 1000
            })
        );
        assert_eq!(
            parse_identity(Some(" 1000 "), Some("2000")),
            Some(WorkloadIdentity {
                uid: 1000,
                gid: 2000
            })
        );
        assert_eq!(parse_identity(None, Some("2000")), None);
        assert_eq!(parse_identity(Some("root"), None), None);
    }

    /// The identity must actually reach the exec'd child. Non-root (dev/CI):
    /// switching to another uid is EPERM, which proves setuid was attempted;
    /// root: the child really reports the target uid.
    #[tokio::test]
    async fn workload_identity_is_applied_to_the_child() {
        let me = unsafe { libc::getuid() };
        let target = 65534; // nobody
        let mut cmd = Command::new("id");
        cmd.arg("-u");
        apply_workload_identity(
            &mut cmd,
            Some(WorkloadIdentity {
                uid: target,
                gid: target,
            }),
        );
        let out = cmd.output().await;
        if me == 0 {
            let out = out.expect("root can drop to nobody");
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "65534");
        } else {
            let err = out.expect_err("non-root cannot setuid to another uid");
            assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        }

        // Same-uid "drop" is always permitted and the child runs as it.
        let me_gid = unsafe { libc::getgid() };
        let mut cmd = Command::new("id");
        cmd.arg("-u");
        apply_workload_identity(
            &mut cmd,
            Some(WorkloadIdentity {
                uid: me,
                gid: me_gid,
            }),
        );
        let out = cmd.output().await.expect("same-uid spawn");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), me.to_string());
    }

    #[test]
    fn workload_env_withholds_harness_namespace() {
        for k in [
            "PAL_HARNESS_EXEC_TOKEN",
            "PAL_AGENT_INSTANCE_TOKEN",
            "PAL_VM_TLS_KEY",
            "PAL_VM_TLS_CERT",
            "PAL_MANAGER_TLS_CA",
            "PAL_DECLARED_SECRETS",
            "PAL_MANAGER_ADDR",
        ] {
            assert!(!workload_may_see(k), "{k} must not reach the workload");
        }
        for k in [
            "PATH",
            "HOME",
            "OPENAI_BASE_URL",
            "PAL_SECRETS_SOCKET",
            "PAL_VM_ID",
            "PAL_TENANT_ID",
            "PAL_AGENT_VERSION_ID",
        ] {
            assert!(workload_may_see(k), "{k} must reach the workload");
        }
    }

    /// End to end through a real child: the token is not in its environment.
    #[tokio::test]
    async fn child_does_not_inherit_exec_token() {
        let vars = [
            ("PAL_HARNESS_EXEC_TOKEN", "tok-secret"),
            ("PAL_VM_TLS_KEY", "/run/pal/harness/tls.key"),
            ("PATH", "/usr/bin:/bin"),
            ("MY_APP_VAR", "kept"),
        ]
        .map(|(k, v)| (k.into(), v.into()));
        let mut cmd = Command::new("/usr/bin/env");
        cmd.env_clear().envs(workload_env_from(vars.into_iter()));
        let out = cmd.output().await.expect("spawn env");
        let env = String::from_utf8_lossy(&out.stdout);
        assert!(!env.contains("PAL_HARNESS_EXEC_TOKEN"), "{env}");
        assert!(!env.contains("tok-secret"), "{env}");
        assert!(!env.contains("tls.key"), "{env}");
        assert!(env.contains("MY_APP_VAR=kept"), "{env}");
        assert!(env.contains("PATH=/usr/bin:/bin"), "{env}");
    }

    #[test]
    fn proxy_env_uses_configured_bind() {
        let pairs = proxy_env_pairs("10.0.0.5:8080");
        let map: HashMap<_, _> = pairs.into_iter().collect();
        assert_eq!(
            map.get("HTTP_PROXY").map(String::as_str),
            Some("http://10.0.0.5:8080")
        );
    }
}
