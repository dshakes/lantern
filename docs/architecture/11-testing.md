# Testing — Production Grade

> **What this is:** the testing strategy for Lantern. Unit, integration, end-to-end, security, performance, chaos, and replay. Read this if you're writing tests, setting up CI, or auditing coverage.
>
> **Why it matters:** Lantern runs production agents holding production credentials against production SaaS apps. A regression that loses runs, leaks secrets, or escapes a sandbox is unacceptable. Test discipline is the difference.

---

## Test pyramid (and why we don't follow it religiously)

The classic pyramid says many unit tests, fewer integration, fewer e2e. We adapt:

```
                ┌─────────────┐
                │  Security   │  always-on (SAST, DAST, scans, fuzz)
                ├─────────────┤
                │   Chaos     │  weekly + on-demand
                ├─────────────┤
                │   Perf      │  per-release
                ├─────────────┤
                │     E2E     │  on every PR for the critical paths
                ├─────────────┤
                │ Integration │  on every PR for every service
                ├─────────────┤
                │    Unit     │  on every commit, fast, broad
                └─────────────┘
```

We add **security and chaos as peers**, not afterthoughts. Lantern is too risky to treat them as optional.

---

## Per-language tooling

| Language | Unit | Integration | E2E | Bench | Lint / SAST |
|---|---|---|---|---|---|
| **Go** | `go test`, `testify`, table-driven | Testcontainers-go (real Postgres / Redis / S3) | `go test ./e2e/...` | `go test -bench`, `benchstat` | `golangci-lint`, `gosec`, `govulncheck` |
| **Rust** | `cargo test`, `pretty_assertions` | Testcontainers-rs | `cargo test --features e2e` | `criterion` | `clippy`, `cargo-audit`, `cargo-deny` |
| **TypeScript** | `vitest` | `vitest` + Testcontainers | `playwright` | `vitest bench` | `eslint`, `tsc`, `npm audit` |
| **Python (SDK only)** | `pytest` | `pytest` + Testcontainers | `pytest -m e2e` | `pytest-bench` | `ruff`, `mypy --strict`, `bandit`, `pip-audit` |

All tests are runnable locally with one command per service: `make test`. The full repo: `make ci-local`.

---

## Unit tests

Conventions:

- **One test file per source file** (e.g., `journal.go` ↔ `journal_test.go`).
- **Table-driven for branching logic.** No 50 nearly-identical test functions; one table.
- **No mocks for internal types.** Use real structs. Mock only at I/O boundaries.
- **No `t.Skip`, no `it.skip`, no `#[ignore]`.** Either delete the test or fix the bug.
- **Race detector on by default for Go** (`go test -race`). Fail CI on race.
- **Property tests** (rapid in Go, proptest in Rust, fast-check in TS) for the workflow engine determinism rules and the journal replay logic. The bugs they find would never be caught by examples.

What we always unit test:

- Pure logic in every package.
- Error paths (the model router's failover, the engine's lock contention, the runtime manager's cgroup accounting).
- Edge cases discovered by fuzz harnesses.
- Determinism rules (replay produces the same trace).

---

## Integration tests

Real services in containers, no mocks, no faked databases.

### Go services
```go
func TestControlPlane_CreateRun(t *testing.T) {
    pg := testcontainers.StartPostgres(t)
    redis := testcontainers.StartRedis(t)
    s3 := testcontainers.StartMinio(t)
    cp := startControlPlane(t, pg, redis, s3)

    run, err := cp.CreateRun(ctx, &v1.CreateRunRequest{...})
    require.NoError(t, err)
    require.Equal(t, "queued", run.Status)
}
```

### Rust services
```rust
#[tokio::test]
async fn router_failover_skips_degraded_provider() {
    let pg = TestcontainersPostgres::start().await;
    let primary = MockProvider::new().with_failures(3);
    let secondary = MockProvider::new();
    let router = ModelRouter::new(vec![primary, secondary]);

    let result = router.complete(&request).await.unwrap();
    assert_eq!(result.provider, "secondary");
}
```

### What we cover at integration level

- Every gRPC handler in every service against a real database.
- Every Postgres query (sqlc-generated; tested for correct SQL, correct indexes, RLS enforcement).
- Every connector (mocked vendor APIs but real OAuth flow up to the boundary).
- Every webhook signature verification.
- Every retry policy (using a flaky mock provider).

### Postgres tests run real migrations
We never test against an in-memory mock of Postgres. The real schema, the real RLS, the real partitioning. Slower CI; far fewer surprises in prod.

---

## End-to-end tests

E2E tests boot a complete Lantern stack via docker-compose (or a Kind cluster for the K8s-specific paths) and exercise it through the public APIs.

### What's covered

| E2E suite | What it does |
|---|---|
| `e2e/agents-crud` | Create agent → upload bundle → list versions → delete |
| `e2e/run-lifecycle` | Create run → stream events → assert final state in journal |
| `e2e/durability` | Start a run, kill the workflow engine mid-step, assert resume from journal |
| `e2e/cancel` | Cancel a long-running run, assert cleanup, assert journal terminal state |
| `e2e/parallel` | `step.map` over 100 items, kill 1 worker, assert no double-execution |
| `e2e/streaming` | Subscribe to a run via SSE, disconnect, reconnect with `Last-Event-ID`, assert no missing events |
| `e2e/connectors-gmail` | Connect a fixture Gmail account, send email, read it back |
| `e2e/connectors-slack` | Same for Slack |
| `e2e/mcp-roundtrip` | Connect a stub MCP server, list tools, invoke a tool, assert result |
| `e2e/a2a-roundtrip` | Stand up a fake A2A peer, send a task, receive an artifact, assert state machine |
| `e2e/visual-builder` | Build a workflow on the canvas, save, run it, assert output |
| `e2e/personal-vault` | Encrypt a secret with a passphrase, run an agent that reads it, assert plaintext never escapes |
| `e2e/budget-enforcement` | Set a $0.01 budget, run an agent, assert `BudgetExceeded` error path |

### Web E2E with Playwright

`apps/web/e2e/` exercises the dashboard:
- Auth flow
- Create agent
- Trigger a run
- Watch the run inspector stream live
- Cancel a run
- Visual builder drag-and-drop
- Connector install OAuth flow

Run on every PR. Visual regression with Percy or screenshots committed to the repo.

### Mobile E2E
- iOS: XCUITest, runs on a simulator in CI
- Android: Espresso, runs on an emulator
- Surface flows: receive a push, approve a gate, watch a screen-share

---

## Security testing

### SAST
- **Semgrep** with the OWASP top 10 ruleset + Lantern-specific rules:
  - "no `panic!` outside main"
  - "no `unwrap` outside tests"
  - "no `sprintf`/`format!` for SQL — use sqlc"
  - "all gRPC handlers must validate `tenant_id`"
  - "secrets must be passed via vault refs, never as strings"
- **gosec** for Go.
- **clippy --deny warnings** for Rust.

### Dependency scanning
- `cargo-audit`, `govulncheck`, `npm audit`, `pip-audit` run on every PR.
- `cargo-deny` for license + advisory + bans.
- `Trivy` for container images.
- `dependabot` for routine updates.

### DAST
- **OWASP ZAP** scans the gateway endpoints on every release.
- **Burp Pro** scheduled scans by the security team monthly.
- Bug bounty program post-launch.

### Fuzz testing
- The agent bundle parser (cargo-fuzz, AFL).
- The journal event payload codec (Go fuzzing).
- The MCP/A2A request decoders.
- The model router's prompt normalizer.
- The connector webhook signature verifier.
- The visual builder canvas.json compiler.

Fuzz harnesses live in `tests/fuzz/`. CI runs them for 5 minutes per PR; weekly job runs them for 24h on dedicated infra.

### Sandbox escape tests
- A "redteam" CI suite that intentionally tries to escape the `untrusted` and `hostile` sandboxes.
- Includes known kernel exploits (where allowed), seccomp policy violations, syscall fuzzing, network egress probing, secret leakage attempts, cross-tenant data exfiltration attempts.
- These tests must fail (i.e., the sandbox must catch them). If a test passes (escape succeeds), CI fails.

### Secrets-in-logs scanner
- Every CI run greps logs and snapshots for things that look like secrets (high-entropy strings, known prefixes like `sk-`, `hlx_live_`, `xoxb-`).
- If found, CI fails.

---

## Performance testing

### Microbenchmarks
- Per-package `bench` targets for hot code: model router routing decisions, journal append, prompt budgeter, embedding kNN, SSE encode.
- `benchstat` over the last green build to detect regressions ≥ 5%.

### Load tests
- **k6** scripts in `tests/load/`:
  - `k6 run agents-crud.js` — sustained CRUD throughput
  - `k6 run run-create.js` — runs created per second across many tenants
  - `k6 run streaming.js` — many concurrent SSE clients receiving long streams
  - `k6 run connector-fanout.js` — many parallel connector calls
- Run nightly against a staging environment.

### SLO targets (spike phase)

| Metric | Target |
|---|---|
| Gateway request latency overhead p99 | ≤ 5 ms |
| Control plane CRUD p99 | ≤ 200 ms |
| Workflow engine step record p99 | ≤ 50 ms |
| Cold start (warm pool hit) p99 | ≤ 200 ms |
| Cold start (snapshot restore) p99 | ≤ 500 ms |
| Model router TTFT overhead p99 | ≤ 30 ms |
| SSE first-byte latency overhead p99 | ≤ 20 ms |
| Memory service search p99 | ≤ 100 ms |

These are codified as SLO checks on every nightly load test. Regression fails the build.

---

## Chaos testing

Chaos tests run weekly on a staging cluster.

### Tools
- **Toxiproxy** for network injection (latency, packet loss, partial failures, slow responses).
- **chaos-mesh** for K8s-level chaos (pod kill, network partition, IO chaos, time skew).
- **Custom chaos suite** for Lantern-specific scenarios.

### Scenarios
- Kill the workflow engine mid-run, assert all in-flight runs resume correctly.
- Postgres failover, assert the engine reconnects and runs continue.
- Redis cluster reshard, assert rate limits are not lost or doubled.
- Provider 5xx storm, assert failover and no run failures.
- Slow consumer on SSE, assert backpressure propagates and producer slows.
- Network partition between gateway and control plane, assert client gets a clean error and retries.
- KMS unavailable, assert vault reads fail gracefully and runs pause.
- Disk full on a runtime manager node, assert sandboxes evict and reschedule.
- Clock skew between services, assert workflow timers still fire on time.

Each scenario asserts: no data loss, correct user-facing error, complete recovery on healing.

---

## Replay testing

This is unique to durable execution and critical to get right.

### Replay correctness suite
- Every workflow engine commit runs the **replay corpus**: a curated set of journal sequences from real-world runs.
- For each sequence, we replay the user's `run` function from scratch with the journal in scope.
- We assert: same step calls in the same order, same arguments, same returned values.
- A divergence is a P0 bug.

### Replay perf benchmark
- We measure how fast we can replay a 10,000-step journal. Target: ≤ 1 second.
- Regression fails the build.

### Property-based replay
- Random journals generated by a state machine.
- Replay produces the same final state regardless of the journal's split points (i.e., where we "crashed" and resumed).
- Found ~5 real bugs during initial design.

---

## Test data

- **No real customer data in test fixtures.** Synthetic only.
- **Connector tests** use vendor sandboxes where available (Stripe test mode, Slack workspace, etc.) and fixture servers otherwise.
- **LLM tests** use a deterministic mock model router by default; real provider calls only in nightly e2e under `LANTERN_E2E_REAL_LLM=1`.

---

## CI matrix

```
On every PR:
  parallel:
    - lint: Go, Rust, TS, Python
    - unit: Go, Rust, TS, Python
    - integration: Go (with Testcontainers), Rust (with Testcontainers)
    - sast: Semgrep, gosec, clippy
    - audit: cargo-audit, govulncheck, npm audit, pip-audit
    - protoc: regenerate, fail if generated files are stale
  sequential after parallel:
    - e2e-core: docker-compose, runs the e2e/run-lifecycle, e2e/durability, e2e/cancel, e2e/parallel, e2e/streaming
    - web-e2e: Playwright on apps/web
  finally:
    - coverage merge + report

Nightly:
  - e2e-full: every e2e suite
  - load: k6 against staging
  - chaos: random chaos-mesh experiment + assertion suite
  - fuzz: 24h on each fuzz harness

Per release:
  - perf SLO check
  - dast: ZAP scan
  - mobile e2e on real devices (BrowserStack)
  - SBOM publish
```

CI configs in `.github/workflows/` (or your CI of choice).

---

## What's intentionally NOT here

- **No 100% coverage target.** Coverage is a side-effect of writing tests for the things that matter, not a goal.
- **No flaky test quarantine.** A flaky test is a bug. Fix it or delete it.
- **No "manual QA before release".** Every release path is automated end-to-end.
- **No "we trust the tests, ship it" philosophy.** Tests catch most things, not all things. Reviews catch the rest.

---

## See also

- [`05-workflow-engine.md`](05-workflow-engine.md) — replay correctness rules
- [`10-security.md`](10-security.md) — what the security tests are guarding
