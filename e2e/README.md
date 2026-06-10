# e2e — live-stack end-to-end suites

End-to-end tests that exercise the **real** local stack over HTTP — real JWT
auth, real Postgres rows, no mocks, no `httptest`. They automate the manual
flows the `examples/` guides document, so "did the control path regress?" is
one command instead of a curl checklist.

## Suites

| Dir        | What it covers                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime/` | W12 headless-runtime control path (`/v1/runtime/*`): auth gates, schedule (201 + vm_id), tenant-scoped list, detail + per-VM audit, logs SSE, terminate state transition, quota hard-fail 402, audit trail. Automates `examples/headless-agents/MANUAL-TEST.md`. |

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

## Skip semantics (CI-safe)

Every test probes `GET /healthz` first. When `:8080` is unreachable the whole
suite **skips with a clear message instead of failing**, so `make test-e2e`
in a pipeline without the dev stack stays green. A reachable API with broken
dev credentials is a real failure, not a skip.

## Configuration

| Env var                | Default                 | Purpose                          |
| ---------------------- | ----------------------- | -------------------------------- |
| `LANTERN_E2E_API_URL`  | `http://localhost:8080` | Control-plane base URL           |
| `LANTERN_E2E_EMAIL`    | `admin@lantern.dev`     | Login email (seeded dev user)    |
| `LANTERN_E2E_PASSWORD` | `lantern`               | Login password                   |
| `LANTERN_E2E_IMAGE_DIGEST` | `lantern/demos/hello@sha256:00…01` (placeholder) | Image to schedule; override with a pullable image on two-tier stacks |

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

## Known contract notes

- `POST /v1/runtime/schedule` returns **201 Created** (not 200).
- `PUT /v1/runtime/quota` clamps non-positive ceilings back to defaults, so
  "quota = 0" is impossible by design; the 402 test pins
  `maxConcurrentVms` to the current live-VM count instead.
