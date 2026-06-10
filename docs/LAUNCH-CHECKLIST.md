# Launch Checklist

Readiness gates for the transition from public alpha → beta → GA. Sourced from
`SECURITY.md`, `docs/architecture/00-roadmap.md`, and the current repo state.

Checkbox status is **as of the date of this file's creation** and should be updated
as items close.

---

## Alpha (current — public alpha)

Items that are already done or intentionally deferred to beta/GA.

- [x] Core control-plane REST + gRPC API (`services/control-plane`) — agents, runs, sessions, budgets, evals, receipts, MCP, A2A, voice, marketplace
- [x] Durable workflow engine with step replay (`services/workflow-engine`)
- [x] Multi-LLM model router with capability aliases (`services/model-router`)
- [x] Runtime scheduler — warm-pool, region, fair-share, cost, health scoring (`services/runtime-scheduler`)
- [x] Runtime manager — Docker, Firecracker, K8s backends; mTLS cert issuance; `VendSecret` allowlist (`services/runtime-manager`)
- [x] Harness — PID 1, egress proxy, secret vending, log forwarding, OTel (`services/harness`)
- [x] Gateway — TLS, JWT auth, rate limiting, SSE streaming (`services/gateway`)
- [x] Personal agent bridges — WhatsApp + iMessage (`services/whatsapp-bridge`, `services/imessage-bridge`)
- [x] TypeScript SDK + Python SDK + Go SDK (stub) (`packages/sdk-ts`, `packages/sdk-python`, `packages/sdk-go`)
- [x] `lantern` CLI (`packages/cli`)
- [x] Dashboard, landing, docs site (`apps/web`, `apps/landing`, `apps/docs`)
- [x] Dev credentials seeded on first boot; `LANTERN_ENV=prod` hard-fails without `JWT_SECRET` / `LANTERN_CREDENTIAL_KEY`
- [x] Security audits remediated (auth, tenant isolation, webhook verification, XSS, secrets, fail-closed posture) — see `SECURITY.md`
- [x] `~290` Rust unit tests, `~565` bridge-core tests, control-plane + SDK suites

---

## Beta

Work needed before accepting non-owner production traffic.

### Security (from `SECURITY.md` — GA blockers or near-GA)

- [ ] **K8s Job isolation validated end-to-end** — run against a real cluster (kind/k3s acceptable) with default-deny `NetworkPolicy` + `seccomp: RuntimeDefault` + `cap_drop: [ALL]`; see `SECURITY.md#must-close` (`services/runtime-manager/src/backends/k8s.rs`)
- [ ] **Firecracker live cold-boot CI green** — `.github/workflows/microvm-integration.yml` now runs `cargo test --all` for both `runtime-manager` and `harness` on the KVM runner (added this batch); live Firecracker boot + teardown + jailer wrapping remain open. Local dev path now exists too: a Firecracker microVM boots to login in ~1.6 s inside the Lima nested-virt guest on Apple Silicon M3+ (`infra/lima/`)
- [ ] **Secret vending mTLS two-process handshake verified** — the KVM CI pipeline validates the live harness↔manager mTLS path; see `SECURITY.md` + `services/runtime-manager/src/tls.rs`
- [x] **Secret relay per-VM binding** — `POST /v1/runtime/secrets/resolve` now verifies `(vm_id, tenant_id)` against `runtime_vms` before returning any credential (404 on unknown/wrong-tenant/terminal VMs, rate-limited to block probing). Per-VM MAC tokens remain optional future hardening (`services/control-plane/internal/handlers/runtime_secrets.go`)
- [ ] **Production `SecretResolver`** — `RelaySecretResolver` (ADR 0008) is now implemented and activated by `LANTERN_CONTROL_PLANE_URL` + `LANTERN_RUNTIME_SECRET_TOKEN`. Vault / AWS Secrets Manager remain a GA option; the relay endpoint is the recommended production step (`services/runtime-manager/src/secret_resolver.rs`)
- [ ] **RBAC scope enforcement on all mutating routes** — `RequireScopeMiddleware` exists; wire it onto every `POST`/`PUT`/`DELETE` route in `services/control-plane/cmd/server/main.go`
- [ ] **Non-owner Postgres role** — apply `infra/db/least-privilege.sql` so the app role cannot bypass RLS; point `DATABASE_URL` at `lantern_app`
- [ ] **Egress host-level firewall** — pair the harness CONNECT proxy with nftables/DNS-stub egress firewall on each node; see `services/harness/README.md#network-expectations`

### Testing gaps

- [ ] **Integration tests (Testcontainers)** — `docs/architecture/00-roadmap.md` marks these `⬜ stub`; needed for control-plane DB + Redis paths
- [ ] **E2E API suite (k6)** — `⬜ stub` in roadmap; needed before accepting external traffic
- [ ] **E2E web tests (Playwright)** — `⬜ stub` in roadmap; needed for dashboard regressions
- [ ] **Fuzz harnesses on sandbox boundary** — `⬜ stub` in roadmap; required before hostile workloads
- [x] **Control-plane runtime handler coverage** — `/v1/runtime/*` handler tests added in the W12 session; DB-backed tests now run in CI against pgvector/pgvector:pg16 (`sdlc-qa.yml`)
- [x] **`go vet` clean** — pre-existing `t.Context()` failures (Go 1.23 vet check) fixed; `go vet ./...` in the control-plane now exits clean
- [x] **CI runs Rust test suites on KVM runner** — `microvm-integration.yml` now runs `cargo test --all` for both `services/runtime-manager` and `services/harness` on the KVM runner before the live boot step

### Runtime / infra

- [ ] **Scheduler `LogOnlyDialer` replaced** — the scheduler's default dialer logs but never actually dispatches to the manager; replace with a real `grpc.ClientConn` pool per node (`services/runtime-scheduler` TODOs)
- [x] **Exec + Stats for K8s backend** — `K8sBackend::exec_command` uses the kube `ws` feature (`Api::exec` / `AttachedProcess`); `stats_sample` queries `metrics.k8s.io/v1beta1` with a clear error when metrics-server is absent (`services/runtime-manager/src/backends/k8s.rs`)
- [x] **Firecracker stats via heartbeat cache** — the manager now consumes `RuntimeHarness::Heartbeat` streams from in-VM harnesses and serves the cached `ResourceUsage` from the stats gRPC method; staleness threshold 30 s (`service.rs`). Firecracker `exec` still returns an error naming the harness channel as the future path.
- [x] **Snapshot persistence to S3/MinIO** — `SnapshotStore` now has a two-tier design: local filesystem primary + optional S3/MinIO upload on every `put`, S3 fallback on `get`. Activated by `S3_ENDPOINT` + `S3_BUCKET` env vars (`services/runtime-manager/src/snapshot_store.rs`). Verified live against dev MinIO.
- [x] **Scheduler cluster state persistence** — `WriteThroughStore` (Postgres write-through) implemented; activated when `DATABASE_URL` is set; `sched_nodes` / `sched_vms` / `sched_snapshots` tables created by `store.Migrate()` on boot (`services/runtime-scheduler/internal/store/`)
- [ ] **`memory`, `notifier`, `billing`, `scheduler` services** — all marked `⬜ stub` in `docs/architecture/00-roadmap.md`; at minimum `billing` usage metering is needed before production

### Release hygiene

- [ ] **CHANGELOG.md published** — `CHANGELOG.md` created this session; needs a tagged release entry with a real version number
- [ ] **Version tags** — no `git tag v0.x.y` exists yet; create and push before announcing beta
- [ ] **Release process documented** — no `RELEASING.md` or equivalent; document the tag → build → publish → Helm chart bump cycle
- [ ] **Go SDK populated** — `packages/sdk-go` is a stub (`docs/architecture/00-roadmap.md`)
- [ ] **Python SDK published to PyPI** — currently install-from-repo only; needs `pip install lantern-sdk`

---

## GA

Items required before GA / "run untrusted code from the public in production".

### Security (hard gates from `SECURITY.md`)

- [ ] **Firecracker jailer wrapping** — sandboxes must run under `firecracker-jailer` for filesystem and network isolation; noted as remaining hardening in `SECURITY.md`
- [x] **Kata backend implemented** — `KataBackend` implemented in `services/runtime-manager/src/backends/kata.rs`; `RUNTIME_BACKEND=kata` + `KATA_RUNTIME_NAME`. Requires Linux host with Kata Containers installed and registered in Docker daemon; Exec/Stats work through inner Docker client
- [x] **Wasm backend implemented** — `WasmBackend` implemented in `services/runtime-manager/src/backends/wasm.rs` via Wasmtime (WASIp1); memory limits + epoch timeouts; `RUNTIME_BACKEND=wasm`
- [ ] **Real heartbeat RPC for egress policy revocation** — policy changes must propagate to running VMs; the harness heartbeat `AckFields` design is in `services/harness/README.md` but the manager side is a stub
- [x] **Per-VM resource cgroups v2 accounting** — harness `sample_usage_loop` now reads cgroup v2 (`memory.current`, `cpu.stat usage_usec`) with `/proc/self/status` VmRSS fallback (`services/harness/src/heartbeat.rs`)

### Observability

- [ ] **All services emit OTel traces with `tenant_id`/`run_id`/`step_id`** — required by architectural invariant 9 in `CLAUDE.md`; audit each service for missing span context propagation
- [ ] **Async API / event schema finalized** — `docs/api/asyncapi.yaml` is `🟡 spike` in roadmap

### Docs + architecture

- [ ] **Architecture docs** `04`–`11` promoted from `🟡 spike` to `✅ done` in `docs/architecture/00-roadmap.md`
- [ ] **OpenAPI spec kept in sync** with all W12 runtime endpoints added to `docs/api/openapi.yaml`
- [ ] **ADRs for Kata, Wasm, devcontainer backends** — architectural invariant requires ADR before new isolation class ships
- [ ] **Security policy updated** to reflect closed items from `SECURITY.md#must-close`
