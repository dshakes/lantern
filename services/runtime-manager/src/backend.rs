use anyhow::Result;
use async_trait::async_trait;
use futures::stream::BoxStream;

use crate::proto::{
    IsolationClass, RestoreRequest, RuntimeEvent, ScheduleRequest, SnapshotRequest,
};

/// What a backend can say about a handle right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Liveness {
    /// Confirmed running.
    Alive,
    /// Confirmed finished — it ran and is over. Safe to reap at once; there is
    /// no "maybe it is still coming up" ambiguity to wait out.
    Exited,
    /// Not running, and the backend cannot say whether it ever started. The
    /// spawn grace applies so a workload mid-create is never reaped.
    Starting,
}

/// A handle to a running sandbox instance.
#[derive(Clone, Debug)]
pub struct Handle {
    /// Unique identifier for this handle (container ID, pod name, or VM ID).
    pub id: String,
    /// The node or host where the sandbox is running.
    pub node_name: String,
    /// Time in milliseconds to start the sandbox (cold start latency).
    pub cold_start_ms: f64,
}

/// Information returned after creating a snapshot.
#[derive(Clone, Debug)]
pub struct SnapshotInfo {
    /// URI where the snapshot is stored (e.g., Docker image tag, S3 path).
    pub snapshot_uri: String,
    /// Size of the snapshot in bytes.
    pub size_bytes: i64,
}

/// Exec result: combined output (stdout and stderr interleaved) and exit code.
#[derive(Clone, Debug)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

/// A single stats sample for a running sandbox.
#[derive(Clone, Debug, Default)]
pub struct StatsSample {
    /// CPU time consumed by the container in milliseconds (vcpu·ms).
    pub vcpu_ms_used: i64,
    /// Current memory usage in bytes.
    pub memory_bytes: i64,
    /// Total bytes received from the network across all interfaces.
    pub network_bytes_in: i64,
    /// Total bytes sent over the network across all interfaces.
    pub network_bytes_out: i64,
}

/// Trait that each runtime backend must implement.
///
/// Backends translate high-level scheduling operations into concrete
/// infrastructure calls (Docker, K8s, Firecracker).
#[async_trait]
pub trait RuntimeBackend: Send + Sync {
    /// Schedule a new sandbox for the given run.
    async fn schedule(&self, req: &ScheduleRequest) -> Result<Handle>;

    /// Cancel a running sandbox, with a reason for auditing.
    async fn cancel(&self, handle_id: &str, reason: &str) -> Result<()>;

    /// Stream runtime events from the sandbox.
    /// Returns a `'static` stream so it can be moved into spawned tasks.
    async fn stream(&self, handle_id: &str) -> Result<BoxStream<'static, RuntimeEvent>>;

    /// Create a snapshot of the sandbox's current state.
    async fn snapshot(&self, req: &SnapshotRequest) -> Result<SnapshotInfo>;

    /// Restore a sandbox from a previously-created snapshot.
    async fn restore(&self, snapshot_uri: &str, req: &RestoreRequest) -> Result<Handle>;

    /// Return a human-readable name for this backend.
    fn name(&self) -> &'static str;

    /// Return whether this backend can satisfy the required isolation level.
    ///
    /// # Security invariant
    ///
    /// The default is **conservative**: `UNTRUSTED` and `HOSTILE` return `false`
    /// so any backend that does not explicitly opt in cannot accidentally accept
    /// hostile or untrusted workloads. Only microVM backends (Firecracker, the
    /// Kata Docker backend) and the K8s backend with the appropriate hardened
    /// RuntimeClass configured may return `true` for those classes.
    ///
    /// Backends that override this method MUST preserve the invariant: never
    /// return `true` for `UNTRUSTED`/`HOSTILE` unless the workload will run
    /// inside a hardware-isolated boundary (gVisor or a microVM).
    fn satisfies_isolation(&self, class: IsolationClass) -> bool {
        // Conservative default: accept everything except the two classes that
        // require hardware/kernel isolation. Any backend that can genuinely
        // satisfy UNTRUSTED or HOSTILE must override this method.
        !matches!(class, IsolationClass::Untrusted | IsolationClass::Hostile)
    }

    /// Return whether this backend can run a *confidential-compute* workload
    /// (memory-encrypted VM on SEV-SNP / TDX under a Kata-CC RuntimeClass).
    ///
    /// # Security invariant
    ///
    /// The default is **conservative**: `false`. Confidential compute requires
    /// hardware memory encryption plus a CC-capable node + RuntimeClass, so any
    /// backend that does not explicitly opt in cannot accidentally accept a
    /// confidential workload and silently run it un-encrypted. Only the K8s
    /// backend with the Kata-CC RuntimeClass configured returns `true`.
    fn satisfies_confidential(&self) -> bool {
        false
    }

    /// Run a one-shot command inside a running sandbox and collect its output.
    ///
    /// `command` is the executable; `argv` are additional arguments.  The call
    /// blocks until the command exits and returns the combined output.
    ///
    /// Backends that do not support in-container exec (e.g. Firecracker, K8s)
    /// return an `unimplemented` error with a clear message rather than
    /// silently failing.  The default implementation does exactly that so
    /// new backends are fail-safe until they add first-class exec support.
    async fn exec_command(
        &self,
        handle_id: &str,
        _command: &str,
        _argv: &[String],
    ) -> Result<ExecOutput> {
        anyhow::bail!(
            "exec not supported by the '{}' backend (handle_id={})",
            self.name(),
            handle_id,
        );
    }

    /// Like [`Self::exec_command`] but with a TTY allocated for the command.
    ///
    /// PTY semantics merge stdout and stderr into one stream, so the result's
    /// `stdout` carries everything and `stderr` is empty. `rows`/`cols` set
    /// the initial geometry (0 → backend default) and `term` is exported as
    /// `TERM` (empty → backend default). Stdin is not piped — the TTY gives
    /// programs a terminal, not interactivity; interactive execs ride the
    /// harness dial-back path, never a backend.
    ///
    /// The default implementation fails with a message containing
    /// "exec not supported by" so the dispatch layer maps it to
    /// `UNIMPLEMENTED`, same as [`Self::exec_command`].
    async fn exec_command_tty(
        &self,
        handle_id: &str,
        _command: &str,
        _argv: &[String],
        _rows: u32,
        _cols: u32,
        _term: &str,
    ) -> Result<ExecOutput> {
        anyhow::bail!(
            "tty exec not supported by the '{}' backend (handle_id={})",
            self.name(),
            handle_id,
        );
    }

    /// Return a single resource-usage sample for a running sandbox.
    ///
    /// Backends that do not expose real-time metrics (Firecracker, K8s)
    /// return an `unimplemented` error.  The default implementation does
    /// exactly that — new backends are fail-safe without extra boilerplate.
    async fn stats_sample(&self, handle_id: &str) -> Result<StatsSample> {
        anyhow::bail!(
            "stats not supported by the '{}' backend (handle_id={})",
            self.name(),
            handle_id,
        );
    }

    /// What the backend can say about a handle's liveness.
    ///
    /// The distinction that matters is `Starting` vs `Exited`. A workload can
    /// finish faster than the reaper's sweep interval, so "not running" alone
    /// is ambiguous: it covers both a container that has not started yet and
    /// one that already ran to completion. Treating both as "maybe starting"
    /// forces every short-lived agent to wait out the full spawn grace before
    /// its exit is noticed; treating both as "exited" would reap workloads
    /// mid-spawn. Backends that can tell them apart should.
    ///
    /// Report whether the workload behind `handle_id` is still running.
    ///
    /// This is the liveness signal the registry reaper uses to notice that a
    /// workload exited on its own. Without it a batch agent — the normal case
    /// for a headless runtime — stays "running" forever in the manager's
    /// registry and, via the heartbeat, in the scheduler's placement and quota
    /// accounting.
    ///
    /// # Safety contract
    ///
    /// The default is **conservative: `Ok(true)`** — unknown means alive.
    /// Reaping a live VM is far worse than carrying a stale entry: it would
    /// orphan a running workload with no way to stop or bill it. Backends that
    /// can answer accurately override this; those that cannot keep today's
    /// behavior rather than guessing.
    ///
    /// An `Err` is "could not determine" and MUST NOT be treated as dead.
    async fn is_alive(&self, _handle_id: &str) -> Result<bool> {
        Ok(true)
    }

    /// Richer liveness: distinguishes a workload that has not started yet from
    /// one that has already exited.
    ///
    /// The default derives from [`Self::is_alive`] and is deliberately
    /// conservative — a non-running handle reports [`Liveness::Starting`], so
    /// backends that cannot tell the difference keep the spawn-grace behavior
    /// they had. Overriding this is what makes exit detection fast.
    async fn liveness(&self, handle_id: &str) -> Result<Liveness> {
        Ok(if self.is_alive(handle_id).await? {
            Liveness::Alive
        } else {
            Liveness::Starting
        })
    }
}
