# lantern-harness

The **RuntimeHarness** — a single static Rust binary that runs as PID 1 inside
every Lantern microVM. It is the only thing the host's runtime-manager talks to
once a VM is booted; everything the workload knows about the rest of the platform
comes through this process.

See `packages/proto/lantern/v1/runtime.proto` for the wire contract
(specifically the `RuntimeHarness` service: `Heartbeat`, `VendSecret`, `Report`).

---

## Responsibilities

1. **Init (PID 1)** — prep `/run/lantern`, mount `/tmp` as tmpfs, set rlimits,
   exec the workload binary as a child.
2. **Supervisor** — restart the workload on crash up to `LANTERN_MAX_RESTARTS`
   times; exit cleanly when the workload exits with status 0.
3. **Heartbeat** — bidirectional gRPC stream to runtime-manager every 5s,
   reporting `(vm_id, ResourceUsage, worker_pid, restart_count)`. Reads
   `HeartbeatAck`s for live policy updates (egress overrides, drain, snapshot).
4. **Secret vending** — calls `VendSecret` on the manager and exposes a unix
   socket at `/run/lantern/secrets.sock` the workload reads from. Caches in
   tmpfs and re-vends 30s before expiry.
5. **Egress allowlist** — HTTP CONNECT proxy on `127.0.0.1:3128` enforcing
   `AgentSpec.egress_rules`. The host firewall must redirect all VM egress to
   this port; see the `egress.rs` module comment for the iptables/nftables
   recipe.
6. **Log forwarder** — tails workload stdout/stderr, parses JSON if possible,
   forwards as `LogLine` via the Report stream.
7. **OTel pass-through** — reads length-prefixed OTLP/protobuf batches from
   `/run/lantern/otlp.sock` and batches them on a 2s flush.
8. **Signal handlers**
   - `SIGTERM` → drain. Forward `SIGTERM` to the workload, wait
     `LANTERN_DRAIN_GRACE_SECS` (default 25), then `SIGKILL`.
   - `SIGUSR1` → snapshot prep. Flush log buffers, signal the workload via
     `SIGUSR1` (workloads that implement checkpointing handle it).
   - `SIGCHLD` → reap zombies. As PID 1 the harness inherits orphans and
     must `waitpid` them or they linger.
9. **Audit events** — one emitted on every secret vend, egress allow/deny
   decision, exec, snapshot, drain.

The harness **MUST tolerate the manager being unreachable**. On manager
outage the workload keeps running, heartbeat retries with exponential
backoff up to 30s, and `Report` messages are dropped (with a logged
counter) until the stream is restored.

---

## Boot contract

The VM image and the manager must agree on the following:

### Environment variables (set by the manager when launching the harness)

| Variable | Required | Purpose |
|---|---|---|
| `LANTERN_VM_ID` | yes | Globally unique VM id. Tags every heartbeat / report. |
| `LANTERN_MANAGER_ADDR` | yes | `host:port` of the on-node runtime-manager (default `127.0.0.1:50054`). |
| `LANTERN_WORKLOAD_CMD` | yes | Space-separated argv of the workload binary. |
| `LANTERN_DECLARED_SECRETS` | no | JSON array `[{"env_name":"OPENAI_API_KEY","secret_uri":"lantern.secret://..."}, ...]`. Anything not on this list is rejected at vend time. |
| `LANTERN_MAX_RESTARTS` | no | Supervisor restart budget. Default `5`. |
| `LANTERN_DRAIN_GRACE_SECS` | no | SIGTERM→SIGKILL window. Default `25`. |
| `LANTERN_EGRESS_BIND` | no | Proxy bind addr. Default `127.0.0.1:3128`. |
| `LANTERN_SECRETS_SOCKET` | no | Unix socket path. Default `/run/lantern/secrets.sock`. |
| `LANTERN_OTLP_SOCKET` | no | Unix socket path. Default `/run/lantern/otlp.sock`. |
| `LANTERN_RUN_DIR` | no | Runtime dir. Default `/run/lantern`. |
| `LANTERN_RLIMIT_AS_BYTES` | no | Cap on virtual address space, set at boot. |
| `RUST_LOG` | no | Tracing filter. Default `info,lantern_harness=debug`. |

### Mount points the VM image must provide

- `/run/lantern` — owned by the harness uid, a tmpfs is fine (and recommended).
  This is where the unix sockets live.
- `/tmp` — tmpfs (mounted by the harness on Linux if not already present).

### Unix sockets the harness exposes for the workload

| Path | Direction | Protocol |
|---|---|---|
| `/run/lantern/secrets.sock` | workload → harness | NDJSON: `{"env_name":"..."} → {"value":"...", "expires_at_unix_ms":N}` |
| `/run/lantern/otlp.sock` | workload → harness | Length-prefixed (u32 big-endian) OTLP/protobuf batches |

The workload SDK ships small helpers for both — workloads written outside
the SDK can speak the protocols directly.

### Network expectations

- Host firewall **DROPs** all outbound traffic from the VM's tap except to
  `127.0.0.1:3128` (the egress proxy).
- Inside the VM, `iptables -t nat -A OUTPUT -p tcp -m owner ! --uid-owner harness -j REDIRECT --to-ports 3128`
  forces all workload TCP through the proxy. The harness's own RPCs to the
  manager run as `uid harness` and bypass.
- DNS resolves via a stub at `127.0.0.1:53` whose allowlist mirrors the
  proxy's; stand it up alongside the harness on hosts where the workload
  needs DNS. (Not bundled; expected on the rootfs.)

---

## How to embed

In a Lantern VM image (alpine/distroless rootfs):

```dockerfile
FROM lantern/harness:latest AS harness
FROM your-workload-base
COPY --from=harness /usr/local/bin/lantern-harness /usr/local/bin/lantern-harness
USER 0
ENTRYPOINT ["/usr/local/bin/lantern-harness"]
```

In a Firecracker rootfs the harness is the init binary (PID 1). Set
`init=/usr/local/bin/lantern-harness` on the kernel cmdline.

---

## Build

```bash
cargo build --release --bin lantern-harness
# or via docker
docker build -t lantern/harness:dev services/harness/
```

The release profile (see `Cargo.toml`) enables LTO + symbol stripping; the
final binary is ~6–8 MiB statically linked against musl.

---

## Known TODOs

- `// TODO: regenerate from runtime.proto` markers point at the spots that
  need a real `tonic-build` codegen pass. Today the harness uses
  hand-defined types in `src/proto.rs` (mirroring the
  `services/runtime-manager` convention) so the crate builds standalone.

## Implemented (previously listed as TODOs)

**Egress rate limiting and HTTP method filtering** (`src/egress.rs`): both are now
enforced. A per-CONNECT-tunnel token bucket throttles byte throughput when a rule
carries a non-zero `rate_bps` (burst = 1 second of traffic; rate 0 = unlimited).
HTTP method filtering applies to plain-HTTP requests where the request line is
directly visible. CONNECT tunnels carry opaque TLS — the proxy cannot inspect the
inner HTTP method without MITM termination, so method filtering is intentionally
not applied to CONNECT connections.

**Cgroup v2 stats** (`src/heartbeat.rs`): the `sample_usage_loop` now tries cgroup
v2 first: it reads `/proc/self/cgroup` to locate the unified-hierarchy path, then
reads `memory.current` and `cpu.stat usage_usec` from `/sys/fs/cgroup/<path>/`.
When those files are absent (macOS dev, cgroup v1, or no cgroup v2 mount) it falls
back to `VmRSS` from `/proc/self/status`. The Linux cgroup path is
`#[cfg(target_os = "linux")]`-gated so the harness still builds on macOS.
