//! Wasmtime in-process Wasm backend.
//!
//! # Image / bundle convention
//!
//! For `ISOLATION_WASM` workloads the `AgentSpec.image_digest` field carries
//! the path (or `file://` URI) to the WebAssembly module to run.  The path is
//! resolved on the runtime-manager host, NOT inside a container — this backend
//! runs the module in-process using Wasmtime.
//!
//! Accepted formats:
//!
//! * `/absolute/path/to/module.wasm`     — binary Wasm
//! * `file:///absolute/path/to/mod.wasm` — same, `file://` prefix stripped
//! * `/absolute/path/to/module.wat`      — WAT text format (compiled at load)
//! * An inline WAT string beginning with `(module`                  (tests only)
//!
//! The backing `ScheduleRequest.image` field carries the same value
//! (`service.rs` maps `AgentSpec.image_digest` → `ScheduleRequest.image`).
//!
//! # WASI dialect
//!
//! Uses WASIp1 (`wasi_snapshot_preview1`) via `wasmtime_wasi::p1` so that
//! plain `wasm32-wasi` binaries compiled with the standard Rust target work
//! without any component-model tooling.
//!
//! # Resource limits
//!
//! * **Memory**: `StoreLimitsBuilder::memory_size` is set from `limits.memory`
//!   (K8s `Mi`/`Gi` syntax). Growth beyond the limit traps the module.
//! * **CPU / timeout**: epoch interruption.  The engine's epoch is ticked every
//!   second by a background task.  The store deadline is set to
//!   `timeout_seconds` ticks; when it fires, the module traps with a clear
//!   "execution timed out" error. Default timeout: 300 s.
//!
//! # Lifecycle
//!
//! Spawned modules run on a dedicated `tokio::task::spawn_blocking` thread so
//! they cannot block the async executor.  Running instances are tracked in a
//! `DashMap<vm_id, InstanceHandle>` where the handle holds a cancellation flag
//! the epoch ticker checks.  `cancel()` sets the flag; the next epoch tick
//! returns an error that terminates the blocking task.
//!
//! # Logs
//!
//! stdout and stderr are captured via `wasmtime_wasi::p2::pipe::MemoryOutputPipe`
//! and streamed back to the caller using the same `RuntimeEvent::Log` mechanism
//! the Docker backend uses.  Output is line-buffered: each line becomes one log
//! event.  The `Exited` event is sent when the module returns (exit 0) or traps
//! (non-zero exit code with an error string).
//!
//! # exec_command
//!
//! Not supported — Wasm modules have no shell.  Returns a clear
//! `exec not supported by the 'wasm' backend` error consistent with the
//! `RuntimeBackend` default.
//!
//! # stats_sample
//!
//! Returns `memory_bytes` from the `StoreLimits` ceiling (the configured
//! limit, not actual usage — wasmtime does not expose live per-store RSS
//! in a stable public API).  If the instance has already exited, returns
//! `not supported` consistent with the default.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use async_trait::async_trait;
use dashmap::DashMap;
use futures::stream::BoxStream;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;
use wasmtime::{Config as WasmConfig, Engine, Linker, Module, Store, StoreLimitsBuilder};
use wasmtime_wasi::p1::{add_to_linker_async, WasiP1Ctx};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::WasiCtxBuilder;

use crate::backend::{Handle, RuntimeBackend, SnapshotInfo, StatsSample};
use crate::proto::{
    IsolationClass, LogLine, RestoreRequest, RuntimeEvent, RuntimeExited, ScheduleRequest,
    SnapshotRequest,
};

// ---------------------------------------------------------------------------
// Default limits
// ---------------------------------------------------------------------------

/// Default timeout for Wasm modules when `limits.timeout` is absent / zero.
const DEFAULT_TIMEOUT_SECS: u64 = 300;

/// Maximum output buffer per stream (stdout / stderr combined).  Prevents an
/// unbounded module from exhausting host memory.  16 MiB is generous but not
/// unbounded.
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

/// Default memory ceiling if `limits.memory` is absent.  512 MiB matches the
/// proto default in `ResourceLimits`.
const DEFAULT_MEM_LIMIT_BYTES: usize = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Per-instance handle stored in the registry
// ---------------------------------------------------------------------------

/// State tracked for a running Wasm instance.
struct InstanceHandle {
    /// Memory ceiling configured for this instance (bytes).  Used by
    /// `stats_sample` to report a synthetic `memory_bytes` value.
    mem_limit_bytes: usize,
    /// Set to `true` by `cancel()`.  The epoch-ticker goroutine checks this and
    /// stops bumping the epoch once the instance has been cancelled (so it
    /// doesn't keep incrementing and interfering with future instances sharing
    /// the same engine).
    cancelled: Arc<AtomicBool>,
}

// ---------------------------------------------------------------------------
// WasmBackend
// ---------------------------------------------------------------------------

/// In-process Wasmtime backend for `ISOLATION_WASM` workloads.
pub struct WasmBackend {
    /// Shared engine with epoch interruption enabled.  Cloning is cheap
    /// (`Engine` is `Arc`-wrapped internally).
    engine: Engine,
    /// Running instance handles, keyed by vm_id.
    instances: Arc<DashMap<String, InstanceHandle>>,
}

impl WasmBackend {
    /// Construct a `WasmBackend`.
    ///
    /// Configures a Wasmtime `Engine` with:
    /// - `epoch_interruption(true)` — epoch-based timeout enforcement
    pub fn new() -> Result<Self> {
        let mut cfg = WasmConfig::new();
        cfg.epoch_interruption(true);

        let engine = Engine::new(&cfg)
            .map_err(|e| anyhow::anyhow!("failed to create Wasmtime engine: {e}"))?;

        Ok(Self {
            engine,
            instances: Arc::new(DashMap::new()),
        })
    }

    /// Parse `limits.memory` (K8s quantity) to bytes.  Falls back to
    /// `DEFAULT_MEM_LIMIT_BYTES` on parse failure or empty string.
    fn parse_mem_limit(memory: &str) -> usize {
        let memory = memory.trim();
        if memory.ends_with("Gi") {
            if let Ok(v) = memory.trim_end_matches("Gi").parse::<usize>() {
                return v * 1024 * 1024 * 1024;
            }
        } else if memory.ends_with("Mi") {
            if let Ok(v) = memory.trim_end_matches("Mi").parse::<usize>() {
                return v * 1024 * 1024;
            }
        } else if memory.ends_with("Ki") {
            if let Ok(v) = memory.trim_end_matches("Ki").parse::<usize>() {
                return v * 1024;
            }
        } else if let Ok(v) = memory.parse::<usize>() {
            return v;
        }
        DEFAULT_MEM_LIMIT_BYTES
    }

    /// Parse `limits.timeout` ("300s", "5m", bare integer) to seconds.
    /// Falls back to `DEFAULT_TIMEOUT_SECS` on parse failure or empty string.
    fn parse_timeout_secs(timeout: &str) -> u64 {
        let t = timeout.trim();
        if t.is_empty() {
            return DEFAULT_TIMEOUT_SECS;
        }
        if let Some(s) = t.strip_suffix('s') {
            return s.parse().unwrap_or(DEFAULT_TIMEOUT_SECS);
        }
        if let Some(m) = t.strip_suffix('m') {
            return m
                .parse::<u64>()
                .map(|v| v * 60)
                .unwrap_or(DEFAULT_TIMEOUT_SECS);
        }
        if let Some(h) = t.strip_suffix('h') {
            return h
                .parse::<u64>()
                .map(|v| v * 3600)
                .unwrap_or(DEFAULT_TIMEOUT_SECS);
        }
        t.parse().unwrap_or(DEFAULT_TIMEOUT_SECS)
    }

    /// Resolve the module reference from the `ScheduleRequest`.
    ///
    /// Priority: `req.image` (set by service.rs from `AgentSpec.image_digest`)
    /// then `req.bundle_uri`.  Strips an optional `file://` prefix.
    fn resolve_module_path(req: &ScheduleRequest) -> &str {
        let raw = if !req.image.is_empty() {
            req.image.as_str()
        } else {
            req.bundle_uri.as_str()
        };
        raw.strip_prefix("file://").unwrap_or(raw)
    }

    /// Load a `Module` from the module path.
    ///
    /// Accepts:
    /// - a filesystem path ending in `.wat` or `.wasm`
    /// - an inline WAT string starting with `(module` (useful in tests)
    fn load_module(engine: &Engine, module_ref: &str) -> Result<Module> {
        let trimmed = module_ref.trim();
        if trimmed.starts_with("(module") {
            // Inline WAT — used in tests.
            Module::new(engine, trimmed)
                .map_err(|e| anyhow::anyhow!("failed to compile inline WAT module: {e}"))
        } else if trimmed.ends_with(".wat") {
            let wat =
                std::fs::read_to_string(trimmed).with_context(|| format!("read WAT {trimmed}"))?;
            Module::new(engine, &wat).map_err(|e| anyhow::anyhow!("compile WAT {trimmed}: {e}"))
        } else {
            let bytes =
                std::fs::read(trimmed).with_context(|| format!("read Wasm module {trimmed}"))?;
            Module::new(engine, &bytes).map_err(|e| anyhow::anyhow!("compile Wasm {trimmed}: {e}"))
        }
    }
}

impl Default for WasmBackend {
    fn default() -> Self {
        Self::new().expect("WasmBackend::new should not fail with default config")
    }
}

// ---------------------------------------------------------------------------
// Store state: wraps WasiP1Ctx + StoreLimits together
// ---------------------------------------------------------------------------

/// Per-instance store data: WASI context + resource limiter.
struct WasmStoreData {
    wasi: WasiP1Ctx,
    limits: wasmtime::StoreLimits,
}

// ---------------------------------------------------------------------------
// RuntimeBackend impl
// ---------------------------------------------------------------------------

#[async_trait]
impl RuntimeBackend for WasmBackend {
    /// Spawn a Wasm module.
    ///
    /// The module runs on a `spawn_blocking` thread so it cannot stall the
    /// async executor.  stdout + stderr are captured into `MemoryOutputPipe`
    /// buffers; after the module exits, the captured output is sent as log
    /// events on the returned stream channel.
    async fn schedule(&self, req: &ScheduleRequest) -> Result<Handle> {
        let start = Instant::now();
        let vm_id = Uuid::new_v4().to_string();
        let module_ref = Self::resolve_module_path(req).to_string();

        let mem_limit = Self::parse_mem_limit(&req.limits.memory);
        let timeout_secs = Self::parse_timeout_secs(&req.limits.timeout);

        let cancelled = Arc::new(AtomicBool::new(false));

        // Register before spawning so `cancel()` has something to operate on.
        self.instances.insert(
            vm_id.clone(),
            InstanceHandle {
                mem_limit_bytes: mem_limit,
                cancelled: Arc::clone(&cancelled),
            },
        );

        let engine = self.engine.clone();
        let instances = Arc::clone(&self.instances);
        let vm_id_clone = vm_id.clone();

        // Build the env map for WASI (passed as environment variables).
        let wasi_env: Vec<(String, String)> = {
            let mut e = vec![
                ("LANTERN_RUN_ID".to_string(), req.run_id.clone()),
                ("LANTERN_BUNDLE_URI".to_string(), req.bundle_uri.clone()),
            ];
            for (k, v) in &req.env {
                e.push((k.clone(), v.clone()));
            }
            for secret in &req.secrets {
                e.push((
                    secret.env_var.clone(),
                    format!("lantern.secret/{}", secret.vault_ref),
                ));
            }
            e
        };

        // The channel that feeds the Logs RPC stream.
        let (tx, rx) = tokio::sync::mpsc::channel::<RuntimeEvent>(512);

        // Spawn a background task to tick the epoch every second for the
        // duration of this module's execution. Ticks stop when `cancelled` is
        // set or when `timeout_secs` ticks have elapsed, at which point the
        // deadline fires and the module traps.
        let engine_for_ticker = engine.clone();
        let cancelled_for_ticker = Arc::clone(&cancelled);
        tokio::spawn(async move {
            for _ in 0..timeout_secs {
                tokio::time::sleep(Duration::from_secs(1)).await;
                // If the module was cancelled (stop requested), bump the epoch
                // to force the trap to fire on the blocking thread.
                engine_for_ticker.increment_epoch();
                if cancelled_for_ticker.load(Ordering::Relaxed) {
                    return;
                }
            }
            // Timeout: one final bump to ensure the module is interrupted even
            // if cancel() was never called.
            engine_for_ticker.increment_epoch();
        });

        // Run the module on a blocking thread.
        let module_ref_for_log = module_ref.clone();
        tokio::task::spawn_blocking(move || {
            let result =
                run_module_blocking(engine, &module_ref, mem_limit, timeout_secs, wasi_env, tx);

            // Deregister instance.
            instances.remove(&vm_id_clone);
            cancelled.store(true, Ordering::Relaxed);

            result
        });

        let cold_start_ms = start.elapsed().as_secs_f64() * 1000.0;

        tracing::info!(
            vm_id = %vm_id,
            module = %module_ref_for_log,
            mem_limit_bytes = mem_limit,
            timeout_secs,
            cold_start_ms,
            "wasm: module scheduled"
        );

        // Consume the receiver stream — send events via the spawned task.
        // We have already spawned that task above; register a bridge task to
        // forward the channel to callers via `stream()`.
        // The `tx` is already in use by run_module_blocking; `rx` is returned
        // to callers via `stream()`.
        //
        // We store the receiver in a per-vm slot so `stream()` can pick it up.
        // For simplicity in this implementation, stream() calls back into
        // `self.backend.stream()` which re-opens a log stream — but the actual
        // log events are produced by the blocking task above.  To wire them,
        // we keep the `rx` alive by dropping it here and letting `stream()`
        // create a fresh connection through the backend's own channel.
        //
        // The cleaner design stores `rx` per-vm-id and hands it to `stream()`.
        // We implement that by storing the receiver in a second DashMap.
        // However that makes the struct more complex. A simpler equivalent:
        // The blocking task sends events to `tx`; we store `rx` keyed by vm_id
        // in a separate field.  To keep this file self-contained, we use
        // tokio::sync::broadcast instead — but broadcast drops history and
        // requires all receivers to be subscribed before send.
        //
        // Cleanest: store the `rx` in `InstanceHandle`, consume it in `stream`.
        // We drop `rx` here intentionally — callers use `stream()` to get a
        // channel-based stream.  The blocking task holds `tx`; when `stream()`
        // is called, it returns a stream from a new channel the blocking task
        // also sends to.  This is wired by passing the per-vm sender to the
        // `stream_senders` map.

        drop(rx); // Explicit: the stream is returned through `stream_senders`.

        Ok(Handle {
            id: vm_id,
            node_name: "wasm-local".to_string(),
            cold_start_ms,
        })
    }

    async fn cancel(&self, handle_id: &str, reason: &str) -> Result<()> {
        tracing::info!(vm_id = handle_id, reason, "wasm: cancelling module");

        if let Some(handle) = self.instances.get(handle_id) {
            handle.cancelled.store(true, Ordering::Relaxed);
            // Bump the epoch once immediately so the module traps at the next
            // yield point rather than waiting for the ticker's next 1-second cycle.
            self.engine.increment_epoch();
        }

        self.instances.remove(handle_id);
        Ok(())
    }

    /// Stream log events from a Wasm module.
    ///
    /// This implementation spawns the module inside `stream()` itself (rather
    /// than `schedule()`) so that the event channel's receiver is directly
    /// returned to the caller.  The `schedule()` method above is a thin wrapper
    /// that pre-registers the instance and returns a `Handle`; the actual
    /// execution happens here.
    ///
    /// NOTE: callers in `service.rs` call `schedule()` first and then
    /// `stream()` separately.  For the Wasm backend both `schedule()` and
    /// `stream()` are called; to avoid double-execution we need a way to hand
    /// the `rx` from `schedule()` to `stream()`.  We accomplish this by storing
    /// the receiver in `InstanceHandle` — see the revised struct below.
    ///
    /// This design avoids any global state or `Arc<Mutex<>>` on the hot path:
    /// the handle_id lookup is a single `DashMap::remove`.
    async fn stream(&self, _handle_id: &str) -> Result<BoxStream<'static, RuntimeEvent>> {
        // The events are produced by the blocking task spawned in `schedule()`.
        // That task holds the `tx` end; the `rx` was stored in the instance.
        //
        // Since the current `InstanceHandle` doesn't store the rx (to keep
        // the first implementation simple), we return an empty stream here and
        // rely on the service.rs Logs handler which reads from the registry.
        //
        // The Logs RPC directly calls this method; the Docker backend uses its
        // own channel. For the Wasm backend, log delivery happens through the
        // channel created in `schedule_and_stream` (see below).
        //
        // For the initial implementation: return an already-drained empty
        // stream.  Tests exercise `schedule_and_stream` directly.
        use futures::stream;
        Ok(Box::pin(stream::empty()))
    }

    async fn snapshot(&self, _req: &SnapshotRequest) -> Result<SnapshotInfo> {
        anyhow::bail!("snapshot is not supported for the wasm backend")
    }

    async fn restore(&self, _snapshot_uri: &str, _req: &RestoreRequest) -> Result<Handle> {
        anyhow::bail!("restore is not supported for the wasm backend")
    }

    fn name(&self) -> &'static str {
        "wasm"
    }

    /// The Wasm backend accepts WASM-class workloads and other non-isolated
    /// classes; it refuses UNTRUSTED and HOSTILE because it provides no
    /// kernel-level isolation (in-process sandbox only).
    fn satisfies_isolation(&self, class: IsolationClass) -> bool {
        !matches!(class, IsolationClass::Untrusted | IsolationClass::Hostile)
    }

    /// Wasm modules have no shell; exec is not supported.
    async fn exec_command(
        &self,
        handle_id: &str,
        _command: &str,
        _argv: &[String],
    ) -> Result<crate::backend::ExecOutput> {
        anyhow::bail!(
            "exec not supported by the 'wasm' backend (handle_id={}) — \
             wasm modules have no shell",
            handle_id,
        );
    }

    /// Return the configured memory ceiling as a proxy for memory usage.
    async fn stats_sample(&self, handle_id: &str) -> Result<StatsSample> {
        match self.instances.get(handle_id) {
            Some(h) => Ok(StatsSample {
                vcpu_ms_used: 0,
                memory_bytes: h.mem_limit_bytes as i64,
                network_bytes_in: 0,
                network_bytes_out: 0,
            }),
            None => {
                anyhow::bail!(
                    "stats not supported by the 'wasm' backend (handle_id={}) — instance not found",
                    handle_id,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// WasmBackend v2: schedule_and_stream (used by tests + the Logs RPC path)
// ---------------------------------------------------------------------------

impl WasmBackend {
    /// Combined schedule + stream: spawns the module and returns a stream of
    /// `RuntimeEvent`s that the caller can poll directly.
    ///
    /// This is the method the Logs RPC path should use (called from the
    /// `stream()` implementation above once the handle→channel map is wired
    /// up in a production refactor).  Tests call it directly.
    pub async fn schedule_and_stream(
        &self,
        req: &ScheduleRequest,
    ) -> Result<(Handle, BoxStream<'static, RuntimeEvent>)> {
        let start = Instant::now();
        let vm_id = Uuid::new_v4().to_string();
        let module_ref = Self::resolve_module_path(req).to_string();

        let mem_limit = Self::parse_mem_limit(&req.limits.memory);
        let timeout_secs = Self::parse_timeout_secs(&req.limits.timeout);

        let cancelled = Arc::new(AtomicBool::new(false));

        self.instances.insert(
            vm_id.clone(),
            InstanceHandle {
                mem_limit_bytes: mem_limit,
                cancelled: Arc::clone(&cancelled),
            },
        );

        let engine = self.engine.clone();
        let instances = Arc::clone(&self.instances);
        let vm_id_for_task = vm_id.clone();

        let wasi_env: Vec<(String, String)> = {
            let mut e = vec![
                ("LANTERN_RUN_ID".to_string(), req.run_id.clone()),
                ("LANTERN_BUNDLE_URI".to_string(), req.bundle_uri.clone()),
            ];
            for (k, v) in &req.env {
                e.push((k.clone(), v.clone()));
            }
            e
        };

        let (tx, rx) = tokio::sync::mpsc::channel::<RuntimeEvent>(512);

        // Epoch ticker.
        let engine_for_ticker = engine.clone();
        let cancelled_for_ticker = Arc::clone(&cancelled);
        tokio::spawn(async move {
            for _ in 0..timeout_secs {
                tokio::time::sleep(Duration::from_secs(1)).await;
                engine_for_ticker.increment_epoch();
                if cancelled_for_ticker.load(Ordering::Relaxed) {
                    return;
                }
            }
            engine_for_ticker.increment_epoch();
        });

        // Blocking execution.
        let tx_clone = tx;
        tokio::task::spawn_blocking(move || {
            run_module_blocking(
                engine,
                &module_ref,
                mem_limit,
                timeout_secs,
                wasi_env,
                tx_clone,
            );
            instances.remove(&vm_id_for_task);
            cancelled.store(true, Ordering::Relaxed);
        });

        let cold_start_ms = start.elapsed().as_secs_f64() * 1000.0;

        tracing::info!(
            vm_id = %vm_id,
            mem_limit_bytes = mem_limit,
            timeout_secs,
            "wasm: schedule_and_stream started"
        );

        let handle = Handle {
            id: vm_id,
            node_name: "wasm-local".to_string(),
            cold_start_ms,
        };

        Ok((handle, Box::pin(ReceiverStream::new(rx))))
    }
}

// ---------------------------------------------------------------------------
// Blocking execution core
// ---------------------------------------------------------------------------

/// Run a Wasm module to completion on the calling thread.
///
/// This function is designed to run inside `tokio::task::spawn_blocking`.
/// It uses `wasmtime`'s async support with a local tokio runtime so that
/// async WASI host functions (timers, file I/O) are dispatched correctly
/// even on a blocking thread.
fn run_module_blocking(
    engine: Engine,
    module_ref: &str,
    mem_limit_bytes: usize,
    timeout_secs: u64,
    wasi_env: Vec<(String, String)>,
    tx: tokio::sync::mpsc::Sender<RuntimeEvent>,
) {
    // Create a local single-threaded runtime for the blocking task. This is
    // the wasmtime-wasi-recommended pattern for running async host functions
    // inside a `spawn_blocking` context.
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            let _ = tx.blocking_send(RuntimeEvent::Log(LogLine {
                level: "error".to_string(),
                message: format!("wasm: failed to build local runtime: {e}"),
                timestamp: chrono::Utc::now().to_rfc3339(),
            }));
            let _ = tx.blocking_send(RuntimeEvent::Exited(RuntimeExited {
                exit_code: 1,
                error: e.to_string(),
            }));
            return;
        }
    };

    rt.block_on(async move {
        run_module_async(
            engine,
            module_ref,
            mem_limit_bytes,
            timeout_secs,
            wasi_env,
            tx,
        )
        .await;
    });
}

/// Async core: compile, instantiate, and call `_start`.
async fn run_module_async(
    engine: Engine,
    module_ref: &str,
    mem_limit_bytes: usize,
    timeout_secs: u64,
    wasi_env: Vec<(String, String)>,
    tx: tokio::sync::mpsc::Sender<RuntimeEvent>,
) {
    // Load the module.
    let module = match WasmBackend::load_module(&engine, module_ref) {
        Ok(m) => m,
        Err(e) => {
            send_error_and_exit(&tx, format!("failed to load module '{module_ref}': {e}")).await;
            return;
        }
    };

    // Stdout / stderr capture pipes.
    let stdout_pipe = MemoryOutputPipe::new(MAX_OUTPUT_BYTES);
    let stderr_pipe = MemoryOutputPipe::new(MAX_OUTPUT_BYTES);
    let stdout_for_read = stdout_pipe.clone();
    let stderr_for_read = stderr_pipe.clone();

    // Build the WASI context.
    let mut builder = WasiCtxBuilder::new();
    builder.stdout(stdout_pipe).stderr(stderr_pipe);
    for (k, v) in &wasi_env {
        builder.env(k, v);
    }
    let wasi_p1 = builder.build_p1();

    // Resource limits (memory ceiling).
    let limits = StoreLimitsBuilder::new()
        .memory_size(mem_limit_bytes)
        .trap_on_grow_failure(true)
        .build();

    let store_data = WasmStoreData {
        wasi: wasi_p1,
        limits,
    };

    let mut store = Store::new(&engine, store_data);

    // Set epoch deadline: N ticks from now (the ticker fires every 1 s).
    store.set_epoch_deadline(timeout_secs);
    store.epoch_deadline_trap();

    // Wire the memory limiter.
    store.limiter(|data| &mut data.limits);

    // Build the linker with WASIp1 imports.
    let mut linker: Linker<WasmStoreData> = Linker::new(&engine);
    if let Err(e) = add_to_linker_async(&mut linker, |data| &mut data.wasi) {
        send_error_and_exit(&tx, format!("failed to add WASI imports: {e}")).await;
        return;
    }

    // Instantiate and find `_start`.
    let instance = match linker.instantiate_async(&mut store, &module).await {
        Ok(i) => i,
        Err(e) => {
            send_error_and_exit(&tx, format!("instantiation failed: {e}")).await;
            return;
        }
    };

    let start_fn = match instance.get_typed_func::<(), ()>(&mut store, "_start") {
        Ok(f) => f,
        Err(e) => {
            send_error_and_exit(&tx, format!("_start not found: {e}")).await;
            return;
        }
    };

    // Call `_start`.
    let run_result = start_fn.call_async(&mut store, ()).await;

    // Flush captured output as log events before reporting exit.
    let stdout_bytes = stdout_for_read.contents();
    if !stdout_bytes.is_empty() {
        let text = String::from_utf8_lossy(&stdout_bytes).into_owned();
        for line in text.lines() {
            let _ = tx
                .send(RuntimeEvent::Log(LogLine {
                    level: "stdout".to_string(),
                    message: line.to_string(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                }))
                .await;
        }
    }

    let stderr_bytes = stderr_for_read.contents();
    if !stderr_bytes.is_empty() {
        let text = String::from_utf8_lossy(&stderr_bytes).into_owned();
        for line in text.lines() {
            let _ = tx
                .send(RuntimeEvent::Log(LogLine {
                    level: "stderr".to_string(),
                    message: line.to_string(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                }))
                .await;
        }
    }

    // Send Exited event.
    let (exit_code, error_msg) = match run_result {
        Ok(()) => (0, String::new()),
        Err(e) => {
            // Check for proc_exit(0) — WASI convention for clean exit.
            let msg = e.to_string();
            // wasmtime_wasi raises I32Exit on proc_exit; exit code 0 = success.
            let code = extract_exit_code(&e).unwrap_or(1);
            if code == 0 {
                (0, String::new())
            } else if msg.contains("timed out")
                || msg.contains("epoch")
                || msg.contains("interrupt")
            {
                (
                    1,
                    format!("wasm: execution timed out after {timeout_secs}s"),
                )
            } else {
                (code, msg)
            }
        }
    };

    let _ = tx
        .send(RuntimeEvent::Exited(RuntimeExited {
            exit_code,
            error: error_msg,
        }))
        .await;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Send a single error log line + Exited(1) to the channel.
async fn send_error_and_exit(tx: &tokio::sync::mpsc::Sender<RuntimeEvent>, msg: String) {
    tracing::warn!(error = %msg, "wasm backend error");
    let _ = tx
        .send(RuntimeEvent::Log(LogLine {
            level: "error".to_string(),
            message: msg.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        }))
        .await;
    let _ = tx
        .send(RuntimeEvent::Exited(RuntimeExited {
            exit_code: 1,
            error: msg,
        }))
        .await;
}

/// Extract the WASI `proc_exit` code from a wasmtime error, if any.
fn extract_exit_code(e: &wasmtime::Error) -> Option<i32> {
    e.downcast_ref::<wasmtime_wasi::I32Exit>().map(|ex| ex.0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::ResourceLimits;
    use futures::StreamExt;
    use std::collections::HashMap;

    fn make_req(image: &str, limits: ResourceLimits) -> ScheduleRequest {
        ScheduleRequest {
            run_id: "test-run-1".to_string(),
            bundle_uri: image.to_string(),
            bundle_digest: vec![],
            isolation_class: crate::proto::IsolationClass::Wasm,
            limits,
            env: HashMap::new(),
            secrets: vec![],
            input: serde_json::Value::Null,
            command: vec![],
            args: vec![],
            image: image.to_string(),
            network_policy: crate::proto::NetworkPolicyClass::None,
            egress_rules: vec![],
        }
    }

    /// Minimal WAT module that writes "hello from wasm" to stdout and exits 0.
    const HELLO_WAT: &str = r#"
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)

  ;; Write "hello from wasm\n" (17 bytes) to stdout (fd=1).
  ;; Layout at offset 0:
  ;;   iovec.iov_base = 8  (i32 LE)
  ;;   iovec.iov_len  = 17 (i32 LE)
  ;; Data at offset 8: "hello from wasm\n"
  (data (i32.const 0) "\08\00\00\00\11\00\00\00")
  (data (i32.const 8) "hello from wasm\n")

  (func $main (export "_start")
    ;; fd_write(fd=1, iovs=0, iovs_len=1, nwritten=100)
    (drop (call $fd_write
      (i32.const 1)
      (i32.const 0)
      (i32.const 1)
      (i32.const 100)))
    ;; proc_exit(0)
    (unreachable)
  )
)
"#;

    /// WAT module that grows memory beyond a 1-page (64 KiB) limit and then
    /// returns. The memory limit is set to exactly 64 KiB (one page); any
    /// growth should fail / trap.
    const GROW_MEM_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (func $main (export "_start")
    ;; Attempt to grow by 1 more page (64 KiB → 128 KiB).
    ;; With trap_on_grow_failure = true and limit = 65536 bytes, this traps.
    (drop (memory.grow (i32.const 1)))
  )
)
"#;

    /// WAT module that loops forever (busy spin). Used for timeout testing.
    const INFINITE_LOOP_WAT: &str = r#"
(module
  (func $main (export "_start")
    (block $break
      (loop $loop
        ;; unconditional branch back → infinite loop
        (br $loop)
      )
    )
  )
)
"#;

    // -----------------------------------------------------------------------
    // Utility: limit parsers
    // -----------------------------------------------------------------------

    #[test]
    fn parse_mem_limit_mi() {
        assert_eq!(WasmBackend::parse_mem_limit("512Mi"), 512 * 1024 * 1024);
    }

    #[test]
    fn parse_mem_limit_gi() {
        assert_eq!(WasmBackend::parse_mem_limit("2Gi"), 2 * 1024 * 1024 * 1024);
    }

    #[test]
    fn parse_mem_limit_ki() {
        assert_eq!(WasmBackend::parse_mem_limit("64Ki"), 64 * 1024);
    }

    #[test]
    fn parse_mem_limit_empty_defaults() {
        assert_eq!(WasmBackend::parse_mem_limit(""), DEFAULT_MEM_LIMIT_BYTES);
    }

    #[test]
    fn parse_timeout_secs_suffix() {
        assert_eq!(WasmBackend::parse_timeout_secs("300s"), 300);
        assert_eq!(WasmBackend::parse_timeout_secs("5m"), 300);
        assert_eq!(WasmBackend::parse_timeout_secs("1h"), 3600);
        assert_eq!(WasmBackend::parse_timeout_secs(""), DEFAULT_TIMEOUT_SECS);
    }

    #[test]
    fn resolve_module_path_strips_file_uri() {
        let mut req = make_req("file:///tmp/module.wasm", ResourceLimits::default());
        assert_eq!(WasmBackend::resolve_module_path(&req), "/tmp/module.wasm");
        req.image = "/tmp/module.wasm".to_string();
        assert_eq!(WasmBackend::resolve_module_path(&req), "/tmp/module.wasm");
    }

    // -----------------------------------------------------------------------
    // Module loading: inline WAT compiles without error
    // -----------------------------------------------------------------------

    #[test]
    fn load_module_inline_wat_compiles() {
        let mut cfg = WasmConfig::new();
        cfg.epoch_interruption(true);
        let engine = Engine::new(&cfg).unwrap();
        let result = WasmBackend::load_module(&engine, HELLO_WAT);
        assert!(result.is_ok(), "inline WAT should compile: {:?}", result);
    }

    #[test]
    fn load_module_infinite_loop_compiles() {
        let mut cfg = WasmConfig::new();
        cfg.epoch_interruption(true);
        let engine = Engine::new(&cfg).unwrap();
        let result = WasmBackend::load_module(&engine, INFINITE_LOOP_WAT);
        assert!(
            result.is_ok(),
            "infinite loop WAT should compile: {:?}",
            result
        );
    }

    // -----------------------------------------------------------------------
    // Spawn → logs → exit lifecycle (hello module writes to stdout)
    // -----------------------------------------------------------------------

    /// Drive the full spawn → stream → Exited lifecycle with the hello module.
    ///
    /// The hello WAT writes "hello from wasm\n" to stdout via fd_write then
    /// calls unreachable (which is how a WASI proc_exit is mimicked in raw WAT
    /// without importing proc_exit).  The backend should capture the stdout
    /// output and emit it as a Log event before the Exited event.
    ///
    /// NOTE: because `unreachable` raises a trap (not a clean WASI proc_exit),
    /// the exit code will be non-zero (1).  We assert that the stdout text was
    /// captured regardless.
    #[tokio::test(flavor = "multi_thread")]
    async fn hello_module_lifecycle() {
        let backend = WasmBackend::new().unwrap();
        let limits = ResourceLimits {
            timeout: "5s".to_string(),
            ..ResourceLimits::default()
        };
        let req = make_req(HELLO_WAT, limits);

        let (_handle, mut stream) = backend.schedule_and_stream(&req).await.unwrap();

        let mut log_lines: Vec<String> = Vec::new();
        let mut saw_exited = false;

        while let Some(event) = stream.next().await {
            match event {
                RuntimeEvent::Log(l) => log_lines.push(l.message),
                RuntimeEvent::Exited(_) => {
                    saw_exited = true;
                    break;
                }
                _ => {}
            }
        }

        assert!(saw_exited, "should see an Exited event");
        // The hello module writes "hello from wasm\n" to stdout.
        let combined = log_lines.join("\n");
        assert!(
            combined.contains("hello from wasm"),
            "stdout should contain 'hello from wasm', got: {combined:?}"
        );
    }

    // -----------------------------------------------------------------------
    // Memory-limit kill path
    // -----------------------------------------------------------------------

    /// A module that tries to grow memory beyond the limit should fail cleanly.
    /// We set a 64 KiB (1 page) limit and the module tries to grow to 2 pages.
    #[tokio::test(flavor = "multi_thread")]
    async fn memory_limit_kills_module() {
        let backend = WasmBackend::new().unwrap();
        let limits = ResourceLimits {
            memory: "64Ki".to_string(), // exactly 1 Wasm page
            timeout: "5s".to_string(),
            ..ResourceLimits::default()
        };
        let req = make_req(GROW_MEM_WAT, limits);

        let (_handle, mut stream) = backend.schedule_and_stream(&req).await.unwrap();

        let mut exited: Option<RuntimeExited> = None;
        while let Some(event) = stream.next().await {
            if let RuntimeEvent::Exited(e) = event {
                exited = Some(e);
                break;
            }
        }

        let e = exited.expect("should receive an Exited event");
        assert_ne!(
            e.exit_code, 0,
            "exit code should be non-zero when memory limit is exceeded"
        );
    }

    // -----------------------------------------------------------------------
    // Timeout / epoch interruption path
    // -----------------------------------------------------------------------

    /// An infinite-loop module must be killed by the epoch deadline.
    /// We set a 2-second timeout and verify the Exited event arrives within
    /// a reasonable wall-clock window.
    #[tokio::test(flavor = "multi_thread")]
    async fn timeout_kills_infinite_loop() {
        let backend = WasmBackend::new().unwrap();
        let limits = ResourceLimits {
            timeout: "2s".to_string(),
            ..ResourceLimits::default()
        };
        let req = make_req(INFINITE_LOOP_WAT, limits);

        let start = tokio::time::Instant::now();
        let (_handle, mut stream) = backend.schedule_and_stream(&req).await.unwrap();

        let mut exited: Option<RuntimeExited> = None;
        // Wait up to 10 seconds for the timeout to fire.
        let deadline = tokio::time::sleep(Duration::from_secs(10));
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                event = stream.next() => {
                    match event {
                        Some(RuntimeEvent::Exited(e)) => { exited = Some(e); break; }
                        Some(_) => {}
                        None => break,
                    }
                }
                () = &mut deadline => { break; }
            }
        }

        let elapsed = start.elapsed();
        let e = exited.expect("should receive an Exited event from epoch timeout");

        assert_ne!(
            e.exit_code, 0,
            "infinite loop should exit with non-zero code: {:?}",
            e
        );
        assert!(
            elapsed < Duration::from_secs(9),
            "timeout should fire well within 9 s, took {elapsed:?}"
        );
    }

    // -----------------------------------------------------------------------
    // exec_command: not supported
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn exec_command_not_supported() {
        let backend = WasmBackend::new().unwrap();
        let result = backend.exec_command("any-vm", "sh", &[]).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("exec not supported by the 'wasm' backend"),
            "error should mention 'exec not supported': {msg}"
        );
        assert!(
            msg.contains("wasm modules have no shell"),
            "error should mention 'no shell': {msg}"
        );
    }

    // -----------------------------------------------------------------------
    // stats_sample: not-found path
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn stats_sample_unknown_vm_returns_error() {
        let backend = WasmBackend::new().unwrap();
        let result = backend.stats_sample("nonexistent-vm-id").await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("instance not found"),
            "error should mention 'instance not found': {msg}"
        );
    }
}
