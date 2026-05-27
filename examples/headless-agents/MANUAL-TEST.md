# Manual test guide — headless microVM runtime

This walks the full surface you can exercise **today**, with explicit notes
on what is real vs. stubbed. Read the "What's real, what's a stub" section
at the bottom first if you want to skip to the truth.

---

## 0. Prereqs (one-time)

```bash
# From repo root
make dev-infra          # Postgres + Redis + MinIO via docker-compose
make run-api            # control-plane on :8080
make dashboard-dev      # Next.js dashboard on :3000
```

Log in at <http://localhost:3000> as `admin@lantern.dev` / `lantern`. Then
grab a JWT for CLI/curl use:

```bash
export TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@lantern.dev","password":"lantern"}' | jq -r .token)
echo "$TOKEN" | head -c 40 ; echo …
```

Build the CLI once:

```bash
cd packages/cli && go build -o /usr/local/bin/lantern ./cmd/lantern
export LANTERN_API_URL=http://localhost:8080
export LANTERN_API_TOKEN="$TOKEN"
```

(Optional) Start the runtime-scheduler — only useful if you want to watch
its placement logs. The control-plane works without it today via the
stubbed scheduler client.

```bash
cd services/runtime-scheduler && go run ./cmd/scheduler
# gRPC on :50055, REST on :8085
```

---

## 1. Schedule a headless agent

### Option A — CLI (recommended)

```bash
lantern run examples/headless-agents/01-hello/agent.yaml \
  --input '{"name":"Shekhar"}'
```

Expected output:

```
scheduled vm_id=vm-7f3e9c2a-1234-…
follow with: lantern vm logs vm-7f3e9c2a-1234-… --follow
```

### Option B — raw curl

```bash
curl -s -X POST http://localhost:8080/v1/runtime/schedule \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d @<(yq -o=json examples/headless-agents/01-hello/agent.yaml | jq .spec) \
  | jq
```

---

## 2. List + inspect

```bash
lantern vm list                         # table view
lantern vm list --state running         # filter
lantern vm get <vm-id>                  # full JSON: spec + audit events
```

In the dashboard: open <http://localhost:3000/runtime>. You'll see:

- 4 stat cards (Running / Spawning / Failed-24h / Nodes)
- State filter chips
- Table of VMs polling every 5s
- Clicking any row → `/runtime/<vm-id>` debug view with live SSE log tail,
  spec panel, audit trail, terminate button.

---

## 3. Quotas (HTTP 402 enforcement)

```bash
# Pin a tight quota
curl -s -X PUT http://localhost:8080/v1/runtime/quota \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"max_concurrent_vms":1,"max_cost_usd_per_day":0.01}' | jq

# Schedule 3 in a row — second/third should 402
for i in 1 2 3; do
  curl -s -o /dev/null -w "attempt $i → HTTP %{http_code}\n" \
    -X POST http://localhost:8080/v1/runtime/schedule \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"image_digest":"sha256:test","isolation_class":"trusted"}'
done
```

Expected:

```
attempt 1 → HTTP 200
attempt 2 → HTTP 402
attempt 3 → HTTP 402
```

Inspect via CLI:

```bash
lantern vm quota get
```

---

## 4. Audit trail

Every schedule / terminate / exec writes a row to `runtime_audit_events`:

```bash
curl -s http://localhost:8080/v1/runtime/audit \
  -H "Authorization: Bearer $TOKEN" | jq '.items[:5]'
```

The dashboard's per-VM debug view renders the same data in the
"Audit trail" right rail.

---

## 5. Termination

```bash
lantern vm stop <vm-id> --grace 5
```

Confirms the row state moves to `terminated` and `terminated_at` is set.
Dashboard list reflects within 5s (the poll interval).

---

## 6. Cluster view (owner-only)

```bash
lantern vm cluster
```

Returns per-node load + warm-pool capacity. With no real
`runtime-scheduler` connected, this returns stub data marked with
`"stub": true`. When you start the scheduler in step 0 and the
control-plane is configured to dial it (env var to be added in next wave),
this becomes live.

---

## 7. Logs SSE

```bash
lantern vm logs <vm-id> --follow
```

Or in the browser: the per-VM debug view opens an EventSource on
`/v1/runtime/vms/<id>/logs?follow=1`. Right now this emits a single
"log streaming not yet wired (stub)" frame — the real path requires the
RuntimeManager gRPC `Logs` stream which lands when proto codegen runs.

---

## 8. End-to-end demos

All four demo agents in this directory have their own README. Each one
documents what it proves about the platform:

| Demo                  | Isolation     | What it proves |
|-----------------------|---------------|------------------|
| `01-hello`            | trusted       | round-trip schedule → stamp → audit |
| `02-web-scraper`      | untrusted     | egress allowlist via 127.0.0.1:3128 |
| `03-stateful-research`| devcontainer  | snapshot/restore via SIGUSR1 |
| `04-ml-inference`     | standard      | GPU class scheduling + cost reporting + OTel |

---

## What's real, what's a stub (TL;DR)

**Real today:**
- POST `/v1/runtime/schedule` validates spec, enforces quota (402), stamps
  `runtime_vms`, returns `vm_id`. Visible in dashboard + CLI list.
- Quota CRUD + enforcement.
- Audit events on every operation.
- Dashboard `/runtime` list + per-VM debug view with 5s polling.
- All CLI subcommands (`lantern run`, `lantern vm {list,get,logs,stop,cluster,quota}`).
- `runtime-scheduler` binary boots cleanly and serves its gRPC + REST surface.
- Rust `harness` compiles + has unit-tested subsystems (egress proxy,
  secret vending, heartbeat reconnect).

**Stubbed (pending `make proto` integration of `runtime.proto`):**
- Real wire-up between `control-plane → scheduler → runtime-manager → harness`
  is via a `stubSchedulerClient` that logs intent and synthesizes
  `node-stub`/`az-stub` values. The contract (`SchedulerClient` interface
  in `services/control-plane/internal/handlers/runtime.go`) is the seam
  for the real `tonic`-generated gRPC client.
- `vm logs --follow` emits a single stub frame instead of streaming from
  the harness.
- `vm exec` returns a stub message instead of streaming bidi from the
  manager.
- `vm cluster` returns stub topology when scheduler isn't dialed.

Once `packages/proto/lantern/v1/runtime.proto` is wired through `make proto`,
swapping the four stubs for real generated clients is the only remaining
work — every other layer (HTTP, DB, dashboard, CLI, quotas, audit) is
production-shape.
