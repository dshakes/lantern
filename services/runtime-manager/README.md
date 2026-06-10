# runtime-manager

Per-node orchestration service for the Lantern W12 headless-agent runtime. It
receives spawn/stop/logs/exec/stats requests over gRPC, delegates to an isolation
backend, tracks live handles, and serves the `RuntimeHarness` endpoint that VM
harnesses call for heartbeats and secret vending.

Proto contract: `packages/proto/lantern/v1/runtime.proto`
Hand-stub Go bindings: `gen/go/lantern/v1/`

---

## Position in the W12 pipeline

```
control-plane  →  runtime-scheduler  →  runtime-manager  →  harness (PID 1 in VM)
   :8080              :50055 / :8085        :50054 gRPC         in-VM unix socket
```

1. Control-plane POSTs `POST /v1/runtime/schedule` to the scheduler.
2. Scheduler scores nodes (warm-pool / region / fair-share / cost / health) and
   forwards a `Spawn` gRPC call to the winning node's manager.
3. Manager calls the configured isolation backend, registers the resulting handle,
   issues a per-VM mTLS client cert, and returns a `VmHandle`.
4. The VM boots the `lantern-harness` binary as PID 1; the harness calls back to
   the manager on the `RuntimeHarness` service (`Heartbeat`, `VendSecret`, `Report`).

The manager also self-registers with the scheduler on startup (`POST
/v1/nodes/heartbeat`) so new nodes join the cluster automatically.

---

## Isolation backends

`RUNTIME_BACKEND` selects the backend at startup. One manager node runs exactly one
backend; nodes with different backends are registered separately so the scheduler can
route by isolation class.

### Docker (default — real implementation)

Uses the bollard crate over the Docker Unix socket. Every spawn pulls the agent image
if absent and starts a container with the declared env, resource limits, and secret
refs. Suitable for local development and trusted/standard workloads.

- `Spawn` → `docker run` with env injection
- `Stop` → `docker stop` + `docker rm`
- `Logs` → streaming attach to container stdout/stderr
- `Snapshot` → `docker commit` (image tag written to MinIO)
- `Restore` → `docker run` from the committed image

**Exec** and **Stats** are backed for Docker (and Kata, which delegates to Docker). See the Known gaps table for Firecracker and K8s specifics.

### Firecracker (Linux/KVM — fully wired, unverified off-KVM)

Full implementation: TAP device setup, Firecracker REST API over per-VM Unix socket,
InstanceStart, vsock frame parsing, process-table teardown, snapshot/restore. Per-VM
mTLS client certs are issued at spawn and injected into the VM env so the harness can
authenticate on the `RuntimeHarness` channel.

**Stats** are served from a heartbeat cache rather than by polling the guest directly
(the manager host has no in-guest poll path for Firecracker VMs). The in-VM harness
reports `ResourceUsage` on every `RuntimeHarness::Heartbeat` message; the manager
caches the last value per `vm_id` and serves it from the `Stats` gRPC stream. An
entry older than 30 s is reported as stale with `Status::UNAVAILABLE` rather than
silently returning zeroes.

**Exec** is not yet implemented for Firecracker. The error message names the harness
channel (`RuntimeHarness` gRPC) as the future path. Callers receive `UNIMPLEMENTED`.

**Availability gate**: every Firecracker path checks `firecracker_available()` first:

1. OS is Linux
2. `firecracker` binary is on `PATH` (or `FC_BINARY_PATH`)
3. `/dev/kvm` is present and readable

All three must pass or the backend returns a hard error. The entire implementation
**compiles and unit-tests on macOS** without `/dev/kvm` — the live cold-boot path is
marked `// LINUX-ONLY` and exercised by `.github/workflows/microvm-integration.yml`
on a KVM runner.

**Isolation routing invariant**: `Hostile` and `Untrusted` isolation classes are
refused on any node whose backend is not `firecracker` or `kata`. The manager returns
`FAILED_PRECONDITION` rather than silently downgrading to Docker.

### Kubernetes (real implementation for trusted workloads)

Creates K8s Jobs in per-tenant namespaces (`lantern-t-<tenant_id>`). Each job runs the
agent image as a single pod with resource limits, SecurityContext (non-root,
`cap_drop: [ALL]`, `readOnlyRootFilesystem`, `seccomp: RuntimeDefault`), and an
accompanying default-deny `NetworkPolicy`. Uses the ambient in-cluster credentials or
`KUBECONFIG`.

**Exec** uses the kube `ws` feature (`Api::exec` / `AttachedProcess`) to attach to the
`agent-runner` container and collect stdout, stderr, and exit code.

**Stats** queries `GET /apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods/{name}`. When
metrics-server is not installed the error message explicitly says so rather than
returning an opaque transport error.

Snapshot/restore returns `UNIMPLEMENTED` (K8s Jobs are ephemeral by design; state
persistence is via the workflow engine's durable steps, not VM snapshots).

### Kata (Linux-only — real implementation, requires host setup)

`RUNTIME_BACKEND=kata` activates `KataBackend` (`src/backends/kata.rs`). Kata is a
thin newtype over `DockerBackend`: it delegates all operations (cancel, stream, exec,
stats, snapshot, restore) to the inner Docker client and overrides exactly one field
— `HostConfig.runtime` — so the container runs under the Kata OCI shim instead of
`runc`.

`KATA_RUNTIME_NAME` sets the runtime name as registered in `/etc/docker/daemon.json`
(default: `kata-runtime`). At `schedule()` time, if the daemon does not know the
named runtime, the backend surfaces a precise error pointing at the fix rather than
a generic Docker 400.

**Availability caveat**: the Kata shim and its guest kernel must be installed on the
host and registered in Docker's daemon config before the first workload runs. The
implementation compiles and unit-tests everywhere, but live container creation
requires a Linux host with Kata Containers installed.

**Isolation routing invariant** (unchanged): `Hostile` and `Untrusted` isolation
classes are refused on any node whose backend is not `firecracker` or `kata`.

### Wasm (in-process Wasmtime — runs anywhere)

`RUNTIME_BACKEND=wasm` activates `WasmBackend` (`src/backends/wasm.rs`). Modules
run in-process via Wasmtime on a `spawn_blocking` thread so they cannot stall the
async executor.

- **Module reference**: `ScheduleRequest.image` carries the path (or `file://` URI)
  to the `.wasm` or `.wat` file on the manager host. Inline WAT strings beginning
  with `(module` are also accepted (used in tests).
- **WASI dialect**: WASIp1 (`wasi_snapshot_preview1`) via `wasmtime_wasi::p1` — plain
  `wasm32-wasi` binaries compiled with the standard Rust target work without any
  component-model tooling.
- **Memory limits**: `StoreLimitsBuilder::memory_size` is set from `limits.memory`
  (K8s `Mi`/`Gi` syntax). Growth beyond the limit traps the module.
- **CPU / timeout**: epoch interruption. The engine's epoch is ticked every second by
  a background task. The store deadline is `limits.timeout` ticks; default 300 s.
- **exec_command**: not supported — Wasm modules have no shell. Returns a clear error.
- **snapshot / restore**: not supported — returns an error.
- **stats_sample**: returns the configured memory ceiling as a proxy for live usage
  (Wasmtime does not expose per-store RSS in a stable public API).

---

## Configuration

All env vars; no config file.

| Env | Default | Purpose |
|---|---|---|
| `LISTEN_ADDR` | `0.0.0.0:50054` | gRPC listen address |
| `RUNTIME_BACKEND` | `docker` | Active isolation backend: `docker`, `k8s`, `firecracker`, `kata`, `wasm` |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker daemon Unix socket path |
| `AGENT_IMAGE` | `ghcr.io/lantern/agent-runner:latest` | Default OCI image for spawned workloads |
| `BUNDLE_S3_ENDPOINT` | `http://localhost:9000` | MinIO / S3 endpoint for agent bundles and snapshots |
| `BUNDLE_S3_BUCKET` | `lantern-bundles` | Bucket name |
| `LOG_LEVEL` | `info` | Rust tracing filter (e.g. `debug`, `info,lantern_runtime_manager=debug`) |
| `SCHEDULER_URL` | _(empty — disabled)_ | REST URL of the scheduler for node self-registration heartbeat (`POST /v1/nodes/heartbeat`). Empty → standalone dev mode |
| `SCHEDULER_TOKEN` | _(empty)_ | Shared token sent as `X-Scheduler-Token` on heartbeats |
| `NODE_NAME` | `node-<hostname>` | Logical node identity reported to the scheduler |
| `NODE_ADVERTISE_ADDR` | `<LISTEN_ADDR with 0.0.0.0→localhost>` | Address the scheduler dials to reach this manager |
| `NODE_REGION` | `local` | Region tag used in scheduler placement scoring |
| `NODE_ZONE` | `local-a` | Availability zone tag |
| `LANTERN_ENV` | _(unset)_ | Set to `prod`, `production`, or `staging` to enable fail-closed mTLS enforcement |
| `KATA_RUNTIME_NAME` | `kata-runtime` | OCI runtime name registered in `/etc/docker/daemon.json`. Only used when `RUNTIME_BACKEND=kata` |
| `SNAPSHOT_DIR` | `/var/lib/lantern/snapshots` | Root directory for `SnapshotStore` filesystem persistence (`src/snapshot_store.rs`). Tier-2 retention: keep last 3 per `(agent_version_id, vm_id)`, delete after 7 days (ADR 0007) |
| `S3_ENDPOINT` | _(unset)_ | S3 / MinIO endpoint URL for the `SnapshotStore` S3 tier (e.g. `http://localhost:9000`). Must be set together with `S3_BUCKET` to activate the tier. Path-style URLs are used (required for MinIO). |
| `S3_BUCKET` | _(unset)_ | Bucket name for snapshot uploads. Objects are stored under `snapshots/<agent_version_id>/<vm_id>/<snapshot_id>/`. S3 upload failures on `put` are warn-logged and non-fatal; the local copy is always written first. |
| `AWS_ACCESS_KEY_ID` | _(unset)_ | S3 / MinIO access key. Required when `S3_ENDPOINT` is set. |
| `AWS_SECRET_ACCESS_KEY` | _(unset)_ | S3 / MinIO secret key. Required when `S3_ENDPOINT` is set. |
| `LANTERN_CONTROL_PLANE_URL` | _(unset)_ | Base URL of the control-plane for the `RelaySecretResolver` (e.g. `http://control-plane:8080`). Both this and `LANTERN_RUNTIME_SECRET_TOKEN` must be set to activate the relay |
| `LANTERN_RUNTIME_SECRET_TOKEN` | _(unset)_ | Pre-shared token sent as `X-Lantern-Runtime-Token` when calling `POST /v1/runtime/secrets/resolve`. Both this and `LANTERN_CONTROL_PLANE_URL` must be set. Unset → dev `EnvSecretResolver` (ADR 0008) |

### mTLS (harness ↔ manager)

Three env vars must be set together; see `src/tls.rs`:

| Env | Purpose |
|---|---|
| `LANTERN_MANAGER_TLS_CA` | Path to PEM CA cert. Harness client certs must be signed by this CA |
| `LANTERN_MANAGER_TLS_CERT` | Path to PEM server cert for the manager |
| `LANTERN_MANAGER_TLS_KEY` | Path to PEM private key for the manager cert |

When `LANTERN_ENV` is `prod`/`staging` and any of the three are absent the manager
**exits with status 1** rather than start in plaintext.

In dev (env unset or `dev`): missing mTLS vars → `WARN` log, plaintext gRPC. No
action required to run locally.

Optional overrides for the signing CA (used to issue per-VM client certs at spawn):

| Env | Purpose |
|---|---|
| `LANTERN_VM_SIGNING_CA_CERT` | Path to PEM CA cert used to sign per-VM client certs. Defaults to `LANTERN_MANAGER_TLS_CA` |
| `LANTERN_VM_SIGNING_CA_KEY` | Path to its private key. Defaults to `LANTERN_MANAGER_TLS_KEY` |
| `LANTERN_VM_CERT_DIR` | Host directory for per-VM cert material. Default `/run/lantern/certs` |

---

## Running locally

```bash
# 1. Start infra (Postgres, Redis, MinIO)
make dev-infra

# 2. Start the manager (Docker backend, :50054)
make run-runtime-manager

# 3. Start the scheduler (:50055/:8085)
make run-scheduler

# 4. Start the API wired to the real scheduler
make run-api-runtime
```

`make run-runtime-manager` sets `RUNTIME_BACKEND=docker` and calls `cargo run` from
`services/runtime-manager`. The manager self-registers with the scheduler on
`SCHEDULER_URL` when set; in standalone dev it runs without a scheduler.

Build and test without running:

```bash
cd services/runtime-manager
cargo build
cargo test           # all unit tests including mTLS + cert issuance tests
cargo clippy
```

Smoke test against a running manager (requires a valid JWT in `$TOKEN`):

```bash
# Schedule a Docker workload
curl -s -X POST localhost:50054/Spawn \
  -H "Content-Type: application/grpc" ...

# Via the control-plane REST API (easier)
curl -s -X POST http://localhost:8080/v1/runtime/schedule \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"spec":{"image_digest":"sha256:abc","isolation":1,"limits":{"vcpu":"500m","memory":"256Mi"}}}'
```

---

## Known gaps

| Gap | Location | Notes |
|---|---|---|
| `Exec` — Firecracker | `backends/firecracker.rs` | Returns `UNIMPLEMENTED`; error message names the harness channel as the future path |
| `Exec` / `Stats` — Docker, Kata, K8s | `service.rs` / `backends/k8s.rs` | All three are now backed. Docker/Kata use bollard; K8s uses kube `ws` (exec) and `metrics.k8s.io` (stats) |
| `Stats` — Firecracker | `service.rs` | Served from the heartbeat cache (30 s staleness threshold); no direct guest poll |
| Snapshot persistence — Docker `commit` URI | Docker backend | `docker commit` produces a local image. The `SnapshotStore` S3 tier covers the Firecracker case; a Docker-to-S3 URI path is still open |
| Secret relay — Vault / cloud SM | `secret_resolver.rs` | `RelaySecretResolver` (ADR 0008) now wired: set `LANTERN_CONTROL_PLANE_URL` + `LANTERN_RUNTIME_SECRET_TOKEN` to activate. Vault / AWS Secrets Manager remain future options |
| Live mTLS handshake (multi-process) | `tls.rs` | Unit tests cover cert issuance + identity check. The live two-process handshake is exercised by `.github/workflows/microvm-integration.yml` on a KVM runner — unverified until that CI runs green |
