# e2e — live-stack end-to-end suites

End-to-end tests that exercise the **real** local stack over HTTP — real JWT
auth, real Postgres rows, no mocks, no `httptest`. They automate the manual
flows the `examples/` guides document, so "did the control path regress?" is
one command instead of a curl checklist.

## Test tiers

| Tier | Command | Needs | CI |
| ---- | ------- | ----- | -- |
| Unit | `make test` | toolchains | `sdlc-qa.yml` |
| Fixture e2e (examples) | `make test-e2e-examples` (`scripts/e2e-examples.sh`) | go, cargo, psql, python3, Postgres + Redis; no provider key | `sdlc-e2e.yml` job `examples` |
| Fixture e2e (deploy CLI) | `PAL_E2E_API_URL=... go test -tags e2e ./...` in `e2e/deploy` against a running control-plane | Postgres + Redis | `sdlc-e2e.yml` job `deploy-cli` |
| Browser | `cd apps/web && npm run test:e2e` | node, chromium, go, psql | `sdlc-e2e.yml` job `browser` |
| Live real-LLM | `make test-e2e-llm` | a dev stack on a real provider key; spend-capped (see below) | no, local gate only |
| KVM full-stack | `microvm-integration.yml` | a KVM runner (`vars.MICROVM_RUNNER_LABEL`) | not provisioned yet |

CI runs the fixture tier only. There is no skip path in CI: the workflow fails if any
`--- SKIP` appears in the examples/deploy logs or Playwright reports skipped specs.

## Suites

| Dir        | What it covers                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime/` | W12 headless-runtime control path (`/v1/runtime/*`): auth gates, schedule (201 + vm_id), tenant-scoped list, detail + per-VM audit, logs SSE, terminate state transition, quota hard-fail 402, audit trail. Automates `examples/headless-agents/MANUAL-TEST.md`. |
| `quickstart/` | The `examples/quickstart/` runnable agents stay real: each test creates the agent from its committed `spec.json`, posts its `run.json`, polls to `succeeded`, and asserts an output-shape invariant (pr-triage → JSON with a `risk` key; incident-summarizer → markdown sections **plus** issue+verify a receipt through the public no-auth verifier; daily-standup-digest → digest sections). Needs an LLM provider configured for the dev tenant. |

| `examples/` | Webhook examples (`pr-triage-webhook`, `incident-responder`): signed GitHub/Sentry/PagerDuty delivery -> run -> connector calls recorded by `cmd/connector-replay`; replay dedup, 401, 402, approval grant/deny. Needs the fixture stack: run `make test-e2e-examples` (own DB + ports, never `:8080`). Also `daily-digest` (schedule fires -> Slack post), `telegram-assistant` (signed update -> `sendMessage` reply via the real surface-gateway) and `voice-receptionist` (signed Twilio webhooks -> TwiML / `<Reject>` / cost reconciled in `agent_usage_daily`); these need `DATABASE_URL` (set by the script). |

## Running

```bash
make dev-infra   # Postgres + Redis + MinIO (once)
make run-api     # control-plane on :8080 (terminal 1)
make test-e2e    # the suites (terminal 2)
```

Targets the **single-tier** topology (stub scheduler — no microVM/KVM
needed, the macOS default; this is the verified-green path). Against a
**two-tier** run (`PAL_SCHEDULER_GRPC_ADDR` + Docker-backend
runtime-manager) the real backend pulls the scheduled image, so you must set
`PAL_E2E_IMAGE_DIGEST` to a locally pullable image — with the default
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
| `PAL_E2E_API_URL` | `http://localhost:8080` | **Target API URL** (canonical). Always set this — never rely on the default, which silently points at `:8080`. |
| `PAL_API_URL` | — | Alias for `PAL_E2E_API_URL`; checked when the canonical var is unset. |
| `E2E_ALLOW_SKIP` | — | Set to `1` to skip (instead of fail) when the stack is unreachable. |
| `PAL_E2E_EMAIL` | `admin@pal.local` | Login email (seeded dev user) |
| `PAL_E2E_PASSWORD` | `pal` | Login password |
| `PAL_E2E_IMAGE_DIGEST` | `pal/demos/hello@sha256:00…01` (placeholder) | Image to schedule; override with a pullable image on two-tier stacks |

Both suites (`runtime/` and `quickstart/`) print the resolved target URL at
the start of every run, so there is no silent fallback confusion.

## Fixture LLM tier (no provider key)

For CI and kiosk mode, run the control-plane against the deterministic fixture LLM instead of a real
provider: `go run ./cmd/llm-replay` (in `services/control-plane`, `127.0.0.1:9192`), then start the API with
`PAL_LLM_BASEURL_OPENAI=http://127.0.0.1:9192 PAL_LLM_BASEURL_ANTHROPIC=http://127.0.0.1:9192` and
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

## Support desk (`examples/`)

`e2e/examples` drives `examples/support-desk` (KB answer with a cited source, refund question handed to a human, Slack ping, operator reply over SSE). Setup for the fixture tier and the env vars (`PAL_E2E_FIXTURE_LLM`, `PAL_E2E_SLACK_FIXTURE_ADDR`) are in `examples/support-desk/README.md`.
