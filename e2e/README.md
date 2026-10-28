# e2e — live-stack end-to-end suites

End-to-end tests that exercise the **real** local stack over HTTP — real JWT
auth, real Postgres rows, no mocks, no `httptest`. They automate the manual
flows the `examples/` guides document, so "did the control path regress?" is
one command instead of a curl checklist.

## Suites

| Dir        | What it covers                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime/` | W12 headless-runtime control path (`/v1/runtime/*`): auth gates, schedule (201 + vm_id), tenant-scoped list, detail + per-VM audit, logs SSE, terminate state transition, quota hard-fail 402, audit trail. Automates `examples/headless-agents/MANUAL-TEST.md`. |
| `quickstart/` | The `examples/quickstart/` runnable agents stay real: each test creates the agent from its committed `spec.json`, posts its `run.json`, polls to `succeeded`, and asserts an output-shape invariant (pr-triage → JSON with a `risk` key; incident-summarizer → markdown sections **plus** issue+verify a receipt through the public no-auth verifier; daily-standup-digest → digest sections). Needs an LLM provider configured for the dev tenant. |

## Running

```bash
make dev-infra   # Postgres + Redis + MinIO (once)
make run-api     # control-plane on :8080 (terminal 1)
make test-e2e    # the suites (terminal 2)
```

Targets the **single-tier** topology (stub scheduler — no microVM/KVM
needed, the macOS default; this is the verified-green path). Against a
**two-tier** run (`LANTERN_SCHEDULER_GRPC_ADDR` + Docker-backend
runtime-manager) the real backend pulls the scheduled image, so you must set
`LANTERN_E2E_IMAGE_DIGEST` to a locally pullable image — with the default
placeholder digest, schedule returns 500 on two-tier (observed).

## Stack-down semantics

Every test probes `GET /healthz` first. The default behaviour is a hard
**failure**, not a skip, so `make test-e2e` exits non-zero when the stack is
unreachable — you know the suite didn't actually run. Set `E2E_ALLOW_SKIP=1`
to get the old skip behaviour (useful in CI pipelines that run without a live
stack):

```bash
E2E_ALLOW_SKIP=1 make test-e2e   # exits 0 when the stack is down
```

A reachable API with broken dev credentials is always a failure, never a skip.

## Configuration

| Env var | Default | Purpose |
| ------- | ------- | ------- |
| `LANTERN_E2E_API_URL` | `http://localhost:8080` | **Target API URL** (canonical). Always set this — never rely on the default, which silently points at `:8080`. |
| `LANTERN_API_URL` | — | Alias for `LANTERN_E2E_API_URL`; checked when the canonical var is unset. |
| `E2E_ALLOW_SKIP` | — | Set to `1` to skip (instead of fail) when the stack is unreachable. |
| `LANTERN_E2E_EMAIL` | `admin@lantern.dev` | Login email (seeded dev user) |
| `LANTERN_E2E_PASSWORD` | `lantern` | Login password |
| `LANTERN_E2E_IMAGE_DIGEST` | `lantern/demos/hello@sha256:00…01` (placeholder) | Image to schedule; override with a pullable image on two-tier stacks |

Both suites (`runtime/` and `quickstart/`) print the resolved target URL at
the start of every run, so there is no silent fallback confusion.

## Fixture LLM tier (no provider key)

For CI and kiosk mode, run the control-plane against the deterministic fixture LLM instead of a real
provider: `go run ./cmd/llm-replay` (in `services/control-plane`, `127.0.0.1:9192`), then start the API with
`LANTERN_LLM_BASEURL_OPENAI=http://127.0.0.1:9192 LANTERN_LLM_BASEURL_ANTHROPIC=http://127.0.0.1:9192` and
any dummy `OPENAI_API_KEY`. Replies are `fixture: <first 60 chars of the user message>` with realistic token
counts; `-rules rules.json` scripts replies and tool calls. Refused in prod. See the docs `/testing` page.

## Conventions

- Go tests behind the `e2e` build tag (`//go:build e2e`) in a standalone
  module per suite — they never run under plain `go test ./...` / `make test`.
- Stdlib only; auth via the real `POST /auth/login` dev-credential flow
  (same as `examples/headless-agents/MANUAL-TEST.md` §0).
- Tests clean up after themselves (`t.Cleanup`): scheduled VMs are
  terminated and the tenant quota row is restored even when assertions fail.
- Tenant-scoping assertions check that every returned row belongs to the
  caller's tenant. True cross-tenant isolation (a second tenant probing the
  first) needs a second seeded tenant and is **not** covered here yet.

## §0 spend notes

- **Model pinning is advisory until W1-H lands.** The inline run executor
  currently ignores the agent's `model` field; all runs go through whatever
  provider the server picks. The `$0.50/day hard-fail budget` is therefore
  what actually bounds spend — not the pinned model. Once W1-H wires the
  model field through, the pinned cheap model (`reasoning-small` /
  `chat-small` / `fast`) will additionally lower per-run token cost.
- **The quickstart suite posts 3 runs per invocation** (one per example
  agent, in sequence against the same `e2e-quickstart` slot). The per-agent
  cap is 15 runs/day, so **~5 full suite runs per day** before the ceiling.
  Hitting the cap causes the next run to fail with the message:
  `e2e daily budget exhausted for e2e-quickstart (cap working; rerun after local midnight)`.
  This is intentional — it proves the spend guard is wired.

## Known contract notes

- `POST /v1/runtime/schedule` returns **201 Created** (not 200).
- `PUT /v1/runtime/quota` clamps non-positive ceilings back to defaults, so
  "quota = 0" is impossible by design; the 402 test pins
  `maxConcurrentVms` to the current live-VM count instead.
