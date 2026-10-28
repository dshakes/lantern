# Launch Checklist

Readiness gates for the transition from public alpha → beta → GA. Sourced from
`SECURITY.md`, `docs/architecture/00-roadmap.md`, and the current repo state.

Checkbox status was re-verified against `master` on 2026-10-28 (W3-G); each changed item cites
the path that proves it. Update as items close.

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
- [x] TypeScript SDK + Python SDK + Go SDK (`packages/sdk-ts`, `packages/sdk-python`, `packages/sdk-go`)
- [x] `lantern` CLI (`packages/cli`)
- [x] Dashboard, landing, docs site (`apps/web`, `apps/landing`, `apps/docs`)
- [x] Dev credentials seeded on first boot; `LANTERN_ENV=prod` hard-fails without `JWT_SECRET` / `LANTERN_CREDENTIAL_KEY`
- [x] Security audits remediated (auth, tenant isolation, webhook verification, XSS, secrets, fail-closed posture) — see `SECURITY.md`
- [x] `~290` Rust unit tests, `~565` bridge-core tests, control-plane + SDK suites

### Still genuinely open (summary)

- SDK registry publishing (PyPI, npm) and a release/publish runbook
- Real-account SaaS tiers: connector and provider calls against live vendor accounts (fixtures only in CI; per-example READMEs describe manual runs)
- Full-stack KVM lane: a provisioned runner for `microvm-integration.yml`
- Flipping `LANTERN_RLS_ENFORCE` and `LANTERN_AUTHZ_ENFORCE` per environment
- Fuzzing, OpenAPI/AsyncAPI, soak/chaos on a real cluster

---

## Beta

Work needed before accepting non-owner production traffic.

### Security (from `SECURITY.md` — GA blockers or near-GA)

- [x] **K8s Job isolation validated end-to-end** — `.github/workflows/runtime-cluster-e2e.yml` runs against a real kind cluster (default-deny `NetworkPolicy`, `seccomp: RuntimeDefault`, `cap_drop: [ALL]`, fail-closed RuntimeClass) (`services/runtime-manager/src/backends/k8s.rs`)
- [x] **Firecracker live cold-boot validated** — `infra/firecracker/integration-test.sh` boots a REAL microVM end-to-end on KVM (backend available + microVM booted both PASS), verified on an Apple Silicon Lima nested-virt guest (`infra/lima/`). Fixed six bugs the test had never exercised (rustls crypto provider, firecracker `--log-level`, unbuilt `certs.img`, missing vsock dir, swallowed error chain, restore mem-path). `.github/workflows/microvm-integration.yml` runs it on the KVM runner. REMAINING: a provisioned KVM runner for `microvm-integration.yml` (it falls back to `ubuntu-latest`, which has no nested virt, unless `vars.MICROVM_RUNNER_LABEL` is set) — the full-stack KVM lane is still OPEN
- [x] **In-guest harness VendSecret agent** — implemented, no longer a stub: `services/harness/src/manager_client.rs` (mTLS client + `VendSecret`), `secrets.rs` (peer-authenticated socket), spawn contract per ADR 0025. Live proof inside a booted microVM (`EXPECT_VENDSECRET=1`) still needs the KVM lane above
- [ ] **Secret vending mTLS two-process handshake verified** — the KVM CI pipeline validates the live harness↔manager mTLS path; see `SECURITY.md` + `services/runtime-manager/src/tls.rs`
- [x] **Secret relay per-VM binding** — `POST /v1/runtime/secrets/resolve` now verifies `(vm_id, tenant_id)` against `runtime_vms` before returning any credential (404 on unknown/wrong-tenant/terminal VMs, rate-limited to block probing). Per-VM MAC tokens remain optional future hardening (`services/control-plane/internal/handlers/runtime_secrets.go`)
- [ ] **Production `SecretResolver`** — `RelaySecretResolver` (ADR 0008) is now implemented and activated by `LANTERN_CONTROL_PLANE_URL` + `LANTERN_RUNTIME_SECRET_TOKEN`. Vault / AWS Secrets Manager remain a GA option; the relay endpoint is the recommended production step (`services/runtime-manager/src/secret_resolver.rs`)
- [ ] **RBAC scope enforcement ON** — mutating routes are annotated with `AuthHandler.WithScope` in `services/control-plane/cmd/server/main.go`, but enforcement is flag-gated, default OFF (`LANTERN_AUTHZ_ENFORCE`); reads are unannotated. OPEN: annotate reads, flip the flag per environment
- [ ] **Non-owner Postgres role in use** — handler cutover is complete (`0 non-exempt srv.Pool sites`, ADR 0011) and `infra/db/least-privilege.sql` exists, but `LANTERN_RLS_ENFORCE=1` + `LANTERN_APP_DB_PASSWORD` is not flipped in any environment (OPEN: per-env rollout)
- [ ] **Egress host-level firewall** — ADR 0026 broker mode (`LANTERN_EGRESS_MODE=broker`, no guest NIC) closes this for Firecracker but is opt-in; guest mode still needs the node iptables REDIRECT rule (`services/harness/src/egress.rs`). OPEN: make broker the default / document node setup

### Testing gaps

- [x] **Integration tests for DB + Redis paths** — DB-backed Go tests run against a pgvector service container in CI (`.github/workflows/sdlc-qa.yml`); no Testcontainers (service containers instead)
- [x] **E2E API suite** — Go suites in `e2e/{quickstart,runtime,examples,deploy}` (not k6). Fixture tier runs in CI via `.github/workflows/sdlc-e2e.yml` (jobs `examples`, `deploy-cli`; skip = fail); the real-LLM tier is local-only (`make test-e2e-llm`, spend-capped). Basic load: `make loadtest-runs`. OPEN: a sustained soak/chaos run on a real cluster
- [x] **E2E web tests (Playwright)** — `apps/web/e2e/specs` (8 tests, own DB + ports, fixture LLM); CI job `browser` in `.github/workflows/sdlc-e2e.yml` uploads report + traces on failure
- [ ] **Fuzz harnesses on sandbox boundary** — OPEN: no `fuzz/` directories exist in `services/` or `packages/`; required before hostile workloads
- [x] **Control-plane runtime handler coverage** — `/v1/runtime/*` handler tests added in the W12 session; DB-backed tests now run in CI against pgvector/pgvector:pg16 (`sdlc-qa.yml`)
- [x] **`go vet` clean** — pre-existing `t.Context()` failures (Go 1.23 vet check) fixed; `go vet ./...` in the control-plane now exits clean
- [x] **CI runs Rust test suites on KVM runner** — `microvm-integration.yml` now runs `cargo test --all` for both `services/runtime-manager` and `services/harness` on the KVM runner before the live boot step

### Runtime / infra

- [x] **Scheduler dispatches to the manager** — real gRPC dialer in `services/runtime-scheduler/internal/dialer/manager.go`, selected by `LANTERN_DEFAULT_MANAGER_ADDR`; `LogOnlyDialer` remains only as the dev stub and is fatal in prod (`dialer.CheckManagerDialer`)
- [x] **Exec + Stats for K8s backend** — `K8sBackend::exec_command` uses the kube `ws` feature (`Api::exec` / `AttachedProcess`); `stats_sample` queries `metrics.k8s.io/v1beta1` with a clear error when metrics-server is absent (`services/runtime-manager/src/backends/k8s.rs`)
- [x] **Firecracker stats via heartbeat cache** — the manager now consumes `RuntimeHarness::Heartbeat` streams from in-VM harnesses and serves the cached `ResourceUsage` from the stats gRPC method; staleness threshold 30 s (`service.rs`). Firecracker `exec` still returns an error naming the harness channel as the future path.
- [x] **Snapshot persistence to S3/MinIO** — `SnapshotStore` now has a two-tier design: local filesystem primary + optional S3/MinIO upload on every `put`, S3 fallback on `get`. Activated by `S3_ENDPOINT` + `S3_BUCKET` env vars (`services/runtime-manager/src/snapshot_store.rs`). Verified live against dev MinIO.
- [x] **Scheduler cluster state persistence** — `WriteThroughStore` (Postgres write-through) implemented; activated when `DATABASE_URL` is set; `sched_nodes` / `sched_vms` / `sched_snapshots` tables created by `store.Migrate()` on boot (`services/runtime-scheduler/internal/store/`)
- [ ] **`memory`, `notifier`, `billing`, `scheduler` services** — billing and scheduler gRPC are registered and smoke-tested, memory is REST-by-design (ADR 0013); `services/notifier` was not re-verified in W3-G. OPEN: update the `⬜ stub` rows in `docs/architecture/00-roadmap.md` and confirm notifier

### Release hygiene

- [x] **CHANGELOG.md published** — `CHANGELOG.md` exists; release notes are extracted from it by `.github/workflows/release.yml`
- [x] **Version tags** — `v0.2.0` exists (`git tag`)
- [ ] **Release process documented** — `.github/workflows/release.yml` does tag + GitHub Release + Homebrew tap sync, but there is no `RELEASING.md` and no SDK/Helm publish step. OPEN
- [x] **Go SDK populated** — `packages/sdk-go/client.go` (+ `client_test.go`) is at management-surface parity with the Python SDK
- [ ] **SDKs published to registries** — OPEN: `lantern-sdk` is not on PyPI (`packages/sdk-python`, v0.1.0), the TS SDK is not on npm (`packages/sdk-ts`, v0.1.0), and `release.yml` has no publish step; install-from-repo only

---

## GA

Items required before GA / "run untrusted code from the public in production".

### Security (hard gates from `SECURITY.md`)

- [x] **Firecracker jailer wrapping** — implemented opt-in via `FIRECRACKER_JAILER_PATH` (chroot + drop to non-root `FIRECRACKER_JAILER_UID`/`GID`, default 123:100, `FIRECRACKER_CHROOT_BASE` default `/srv/jailer`) in `services/runtime-manager/src/backends/firecracker.rs`; argv construction unit-tested, jailed exec is Linux-runtime-only. Residual: jailed snapshot-restore fails closed (not yet wired)
- [x] **Kata backend implemented** — `KataBackend` implemented in `services/runtime-manager/src/backends/kata.rs`; `RUNTIME_BACKEND=kata` + `KATA_RUNTIME_NAME`. Requires Linux host with Kata Containers installed and registered in Docker daemon; Exec/Stats work through inner Docker client
- [x] **Wasm backend implemented** — `WasmBackend` implemented in `services/runtime-manager/src/backends/wasm.rs` via Wasmtime (WASIp1); memory limits + epoch timeouts; `RUNTIME_BACKEND=wasm`
- [ ] **Real heartbeat RPC for egress policy revocation** — policy changes must propagate to running VMs; the harness heartbeat `AckFields` design is in `services/harness/README.md` but the manager side is a stub
- [x] **Per-VM resource cgroups v2 accounting** — harness `sample_usage_loop` now reads cgroup v2 (`memory.current`, `cpu.stat usage_usec`) with `/proc/self/status` VmRSS fallback (`services/harness/src/heartbeat.rs`)

### Observability

- [ ] **All services emit OTel traces with `tenant_id`/`run_id`/`step_id`** — control-plane HTTP + gRPC are done (`internal/middleware.EnrichSpan`, `span_test.go`) and OTel code is present in 13 services; OPEN: an end-to-end propagation audit (surface-gateway and the TS bridges not confirmed)
- [ ] **Async API / event schema finalized** — OPEN: no `docs/api/` directory or AsyncAPI file exists in the repo

### Docs + architecture

- [ ] **Architecture docs** `04`–`11` promoted from `🟡 spike` to `✅ done` in `docs/architecture/00-roadmap.md`
- [ ] **OpenAPI spec** — OPEN: no OpenAPI file exists (`docs/api/openapi.yaml` was never created); the REST surface is documented in `CLAUDE.md` and the proto files
- [ ] **ADRs for Kata, Wasm, devcontainer backends** — OPEN: ADR 0002 (runtime class per workload) and 0012 exist, but no ADR dedicated to these three backends
- [ ] **Security policy updated** to reflect closed items from `SECURITY.md#must-close`
