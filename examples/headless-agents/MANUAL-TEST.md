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

### Two-tier run (real wire, recommended)

Boot all three runtime services + wire them together via env vars:

```bash
# Terminal 1 — runtime-manager (Rust, the per-node sandbox executor)
cd services/runtime-manager
LISTEN_ADDR=0.0.0.0:50054 \
  RUNTIME_BACKEND=docker \
  cargo run

# Terminal 2 — runtime-scheduler (Go, placement)
cd services/runtime-scheduler
LANTERN_DEFAULT_MANAGER_ADDR=localhost:50054 \
  go run ./cmd/scheduler
# gRPC on :50055, REST on :8085

# Terminal 3 — control-plane (Go, public API) — point it at the scheduler
LANTERN_SCHEDULER_GRPC_ADDR=localhost:50055 \
  LANTERN_DEFAULT_MANAGER_ADDR=localhost:50054 \
  make run-api
```

Log lines to grep for:
- control-plane: `gRPC scheduler client wired`
- scheduler: `using gRPC manager dialer`
- runtime-manager: `gRPC server starting`

### Single-tier run (stub fallback, for quick UI work)

Skip the scheduler + manager terminals and run just the control-plane.
The `stubSchedulerClient` synthesizes `vm-<uuid>` IDs and a `node-stub`
node so the dashboard + CLI list still light up. Use this when you're
hacking on dashboard styling and don't need real placement.

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

Returns per-node load + warm-pool capacity. With the two-tier run setup
(`LANTERN_SCHEDULER_GRPC_ADDR` set), this is live data from the
scheduler's `RuntimeScheduler.Cluster` RPC. Without it, returns the
stub topology marked `"stub": true`.

---

## 7. Logs SSE

```bash
lantern vm logs <vm-id> --follow
```

Or in the browser: the per-VM debug view opens an EventSource on
`/v1/runtime/vms/<id>/logs?follow=1`. With the two-tier setup, the
control-plane proxies `RuntimeManager.Logs` server-streaming RPC from
the per-node manager and forwards each `LogLine` as an SSE `data:`
frame. Without `LANTERN_DEFAULT_MANAGER_ADDR`, falls back to a single
stub frame.

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

## What's real, what's still stubbed (TL;DR)

**Real end-to-end today (two-tier run):**
- POST `/v1/runtime/schedule` → real `RuntimeScheduler.Schedule` gRPC →
  scheduler placement (warm-pool / region / fair-share / cost / health
  scoring) → real `RuntimeManager.Spawn` gRPC to the resolved node →
  Docker container spawns (default backend; K8s + Firecracker backends
  also wired).
- Logs SSE proxies the real `RuntimeManager.Logs` server-stream from
  the spawned container.
- Terminate proxies `RuntimeScheduler.Terminate` → `RuntimeManager.Stop`.
- Cluster proxies `RuntimeScheduler.Cluster` → real node topology.
- Quota CRUD + 402 enforcement.
- Audit events on every operation.
- Dashboard `/runtime` list + per-VM debug view with live SSE logs.
- All CLI subcommands (`lantern run`, `lantern vm
  {list,get,logs,stop,cluster,quota}`).
- Rust `harness` compiles + has unit-tested subsystems (egress proxy,
  secret vending, heartbeat reconnect). Reachable from the manager
  once a real microVM image is built that includes it.
- Generated tonic server stubs for `RuntimeScheduler`, `RuntimeManager`,
  and `RuntimeHarness` services (runtime-manager only — scheduler still
  has hand-stub Go code in `gen/go/lantern/v1/`).

**Honest gaps that remain:**
- **`vm exec`**: returns `Status::unimplemented` / a stub placeholder.
  Bidi streams are wired through tonic on the Rust side but the
  per-backend exec primitive isn't exposed in `RuntimeBackend`, and the
  Go control-plane's hand-stub gRPC code doesn't include bidi streaming
  glue. TODO(W12-exec).
- **`vm stats`**: `Status::unimplemented` — `ResourceUsage` rolls up via
  the harness `Heartbeat` stream, not per-backend polling, so returning
  zero samples would be misleading.
- **Snapshot**: scheduler accepts the call and records intent; the
  manager-side snapshot/restore wire for Firecracker is the next mile.
- **Real protoc Go codegen**: `gen/go/lantern/v1/` files are hand-
  maintained stubs (gitignored). `make proto` runs protoc but the
  output drifts from the hand-stubs. Pre-existing tech debt, not
  blocking the wire — Go's struct names are local identifiers; the
  proto tags determine wire compat.

For everything in the **Real** list above, you get a true end-to-end
round trip — POST a spec, watch a Docker container start, tail its
logs in your browser, terminate it.
