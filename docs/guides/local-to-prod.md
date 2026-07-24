# Local to production — running Lantern agents everywhere

This guide walks the full promotion path: shared-tier on your laptop → local
microVM tier with Docker → staging K8s cluster → production. Every command in
sections A and B was validated in a dev environment (macOS, Docker 28.0,
runtime-manager + scheduler both local). Section C is operator-validated on
real clusters; the commands work but require infrastructure you do not have
locally.

---

## A. Local loop (shared tier)

The shared tier runs agent logic inline in the control-plane process. No
microVM, no container, no scheduler. Useful for developing agent behaviour
before caring about isolation.

### Start the stack

```bash
make dev-infra          # terminal 1 — Postgres + Redis + MinIO
make run-api            # terminal 2 — control-plane on :8080
```

`make dev-infra` starts three Docker containers (postgres, redis, minio).
`make run-api` runs the Go binary with dev credentials pre-wired
(`DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT` all point at those containers).

Verify the API is healthy:

```bash
curl -s http://localhost:8080/healthz
# → {"status":"ok","llmMode":"api"}
```

### Authenticate

```bash
export TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@lantern.dev","password":"lantern"}' | jq -r .token)
echo "${TOKEN:0:40}..."   # sanity-check the token
```

Dev credentials: `admin@lantern.dev` / `lantern`, tenant `dev`.

### Run example 01 — shared tier

```bash
# Create the agent (idempotent; auto-created by first run too)
curl -s -X POST http://localhost:8080/v1/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"hello-test","description":"Hello world agent"}' | jq .name

# Submit a run
RUN=$(curl -s -X POST http://localhost:8080/v1/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agentName":"hello-test","input":{"name":"Ada"}}')
echo "$RUN" | jq '{id, status}'
RUN_ID=$(echo "$RUN" | jq -r .id)

# Poll until done (usually < 5s for shared-tier)
sleep 3
curl -s http://localhost:8080/v1/runs/$RUN_ID \
  -H "Authorization: Bearer $TOKEN" | jq '{id, status}'
```

Expected: `"status": "succeeded"`. The `output` field contains the agent
response.

### View the run waterfall

Open the dashboard at `http://localhost:3001` and navigate to the run.
The event waterfall shows `step_started` / `step_completed` events from
`journal_events`.

---

## B. Local microVM tier (Docker backend)

This tier runs agent workloads as real Docker containers scheduled by the
placement engine. It proves the control-plane → scheduler → manager →
container chain without requiring KVM.

**What works on macOS:** Docker backend (`RUNTIME_BACKEND=docker`). The
runtime-manager spawns containers on the local Docker daemon. Firecracker,
Kata, and gVisor all need a Linux host with KVM — they will not work here.

**What this tells you:** the scheduling, placement, quota, audit, and log-tail
paths are all real. The isolation guarantees are not — a Docker container does
not provide the same security boundary as a Firecracker microVM.

### Start all three runtime services

Start them in this order (the runtime-manager sends a heartbeat to the
scheduler's REST endpoint on `:8085`, so the scheduler must be up first).

```bash
# Terminal 1 — Postgres + Redis + MinIO
make dev-infra

# Terminal 2 — runtime-scheduler (:50055 gRPC, :8085 REST)
make run-scheduler

# Terminal 3 — runtime-manager (:50054, Docker backend)
# SCHEDULER_URL causes it to self-register; NODE_ADVERTISE_ADDR is the
# address the scheduler uses to dial back for spawn/logs/exec.
make run-runtime-manager

# Terminal 4 — control-plane wired to the scheduler
make run-api-runtime
```

Log lines to watch for (grep or scroll the terminal output):
- scheduler: `using gRPC manager dialer`
- runtime-manager: `gRPC server starting` then `heartbeat ok`
- control-plane: `gRPC scheduler client wired`

Verify the node registered:

```bash
curl -s http://localhost:8080/v1/runtime/cluster \
  -H "Authorization: Bearer $TOKEN" | jq '.nodes'
# → [{"name":"local-dev","draining":false,"free_vcpu_millis":4000,...}]
```

If the node shows `"draining":true`, the heartbeat reaper fired (default
interval 30s). Re-run `make run-runtime-manager` or send a manual heartbeat:

```bash
curl -s -X POST http://localhost:8085/v1/nodes/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"name":"local-dev","address":"localhost:50054","region":"local",
       "continent":"NA","availability_zone":"dev",
       "free_vcpu_millis":4000,"free_memory_bytes":8589934592,
       "warm_pool_exact":{},"warm_pool_image_only":{}}'
```

### Build and schedule the hello agent

```bash
# Build the OCI image
docker build -t lantern/demos/hello:latest \
  examples/headless-agents/01-hello/

# Schedule via REST (agent.yaml snake_case fields work too)
VM=$(curl -s -X POST http://localhost:8080/v1/runtime/schedule \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "imageDigest": "lantern/demos/hello:latest",
    "isolation": "trusted",
    "limits": {"vcpu": "100m", "memory": "64Mi", "timeout_secs": 30},
    "command": ["sh", "-c", "echo '"'"'{\"name\":\"Ada\"}'"'"' | python /app/workload.py"],
    "env": {"LANTERN_RUN_ID": "run-hello-local", "LANTERN_VM_ID": "vm-hello-local"}
  }')
echo "$VM" | jq '{vmId, node, az}'
VM_ID=$(echo "$VM" | jq -r .vmId)
```

Expected: `{"vmId":"vm-...","node":"local-dev","az":"dev"}`.

Verify the container ran:

```bash
# After a second or two the container exits — check its output
docker logs $(docker ps -a --filter "ancestor=lantern/demos/hello:latest" \
  --format "{{.ID}}" | head -1)
# → {"level":"info","msg":"hello world","run_id":"run-hello-local",...}
```

Check the VM detail and audit trail:

```bash
curl -s http://localhost:8080/v1/runtime/vms/$VM_ID \
  -H "Authorization: Bearer $TOKEN" | jq '{state: .vm.state, events: [.events[].action]}'
# → {"state":"running","events":["schedule"]}
```

The state shows `running` even after the container exits because the harness
(which reports exit back to the manager) does not run inside local dev
containers. In production the harness runs as PID 1 and propagates exit
to the scheduler.

### Use `lantern run` CLI (reads agent.yaml directly)

```bash
( cd packages/cli && go install ./cmd/lantern )
export LANTERN_API_URL=http://localhost:8080
export LANTERN_API_TOKEN=$TOKEN

lantern run examples/headless-agents/01-hello/agent.yaml \
  --input '{"name":"Ada"}'
# → scheduled vmId=vm-...
# → follow with: lantern vm logs vm-... --follow
```

For more exercises (quota, audit, terminate, cluster view) see
`examples/headless-agents/MANUAL-TEST.md`.

---

## C. Production — K8s data plane

### Architecture

In production the three runtime services run as K8s Deployments in the
`lantern-system` namespace. Agents execute in per-tenant namespaces
(`lantern-t-<tenant_id>`) as K8s Jobs (trusted), Pods with gVisor
RuntimeClass (standard/untrusted), or Pods with Kata RuntimeClass (hostile).

```
                    ┌──────────────────────────────┐
  REST/gRPC         │  control-plane  :8080/:50051  │
  ──────────────►   │  runtime.go → scheduler gRPC  │
                    └────────────┬─────────────────┘
                                 │ LANTERN_SCHEDULER_GRPC_ADDR
                    ┌────────────▼─────────────────┐
                    │  runtime-scheduler  :50055    │
                    │  placement + fair-share        │
                    └────────────┬─────────────────┘
                                 │ per-node gRPC :50054
                    ┌────────────▼─────────────────┐
                    │  runtime-manager  :50054      │
                    │  RUNTIME_BACKEND=k8s           │
                    │  creates Jobs / Pods           │
                    └────────────────────────────────┘
```

### Required env vars (control-plane)

| Var | Default | Effect when unset |
|-----|---------|------------------|
| `LANTERN_SCHEDULER_GRPC_ADDR` | — | **Fatal in prod** — `CheckSchedulerAddr` aborts startup |
| `LANTERN_DEFAULT_MANAGER_ADDR` | — | **Fatal in prod** — scheduler startup guard aborts |
| `LANTERN_ENV` | `development` | `prod`/`production`/`staging` enables all prod guards |
| `LANTERN_GRPC_SERVICE_TOKEN` | — | **Fatal in prod** — gRPC ports fail-closed without token |

Set `LANTERN_ENV=production` (or `staging`) before deploying. All prod guards
are keyed on this value — they are no-ops in development.

### K8s RuntimeClasses

The runtime-manager (`RUNTIME_BACKEND=k8s`) maps isolation classes to
RuntimeClasses:

| Isolation class | RuntimeClass env var | Default |
|-----------------|---------------------|---------|
| `STANDARD` / `DEVCONTAINER` | `LANTERN_RUNTIMECLASS_GVISOR` | bare runc (degraded) |
| `HOSTILE` | `LANTERN_RUNTIMECLASS_KATA` | — (required; fatal if absent) |
| `WASM` | `LANTERN_RUNTIMECLASS_WASM` | in-process wasmtime |

Set `LANTERN_RUNTIMECLASS_GVISOR=gvisor` (or your cluster's gVisor class
name) and `LANTERN_RUNTIMECLASS_KATA=kata-qemu` to get real sandboxing.
Without `LANTERN_RUNTIMECLASS_GVISOR`, `STANDARD` workloads run as bare runc
**unless** `LANTERN_ALLOW_RUNC_FALLBACK=false` is set (default false = allow).
For `HOSTILE` the Kata class is always required — there is no runc fallback.

### Cluster validation

Before promoting to prod, run the cluster validation harness:

```bash
# Validates gVisor + Kata execution, NetworkPolicy, PSA, RuntimeClass fail-closed
lantern vm validate --kubeconfig /path/to/kubeconfig.yaml
# or: make validate-cluster KUBECONFIG=/path/to/kubeconfig.yaml
```

Expect all 9 legs to PASS before enabling `STANDARD`/`HOSTILE` workloads.
See `docs/runbooks/cluster-validation.md` for the full leg list, failure
interpretation, and the GKE setup script.

---

## D. Promotion checklist

| Step | Local (dev) | Staging | Production |
|------|------------|---------|------------|
| `make dev-infra` + `make run-api` | Required | — | — |
| `make run-scheduler` + `make run-runtime-manager` | Required for microVM tier | — | — |
| Node registration (heartbeat) | Manual / `SCHEDULER_URL` env | Auto (SCHEDULER_URL in Deployment) | Auto |
| `LANTERN_ENV` | `development` | `staging` | `production` |
| `LANTERN_GRPC_SERVICE_TOKEN` | Optional | **Required** | **Required** |
| `LANTERN_SCHEDULER_GRPC_ADDR` | Set for microVM tier | **Required** | **Required** |
| `LANTERN_DEFAULT_MANAGER_ADDR` | Set for microVM tier | **Required** | **Required** |
| `LANTERN_RUNTIMECLASS_GVISOR` | — (Docker, no isolation) | Set to `gvisor` | **Required** |
| `LANTERN_RUNTIMECLASS_KATA` | — | Set to `kata-qemu` | **Required** for HOSTILE |
| `LANTERN_RLS_ENFORCE` | 0 (off) | 1 (on) | 1 (on) |
| Cluster validation (`lantern vm validate`) | — | operator-validated | **Required** |
| Shared-tier run succeeds (`POST /v1/runs`) | Verified (this guide) | Smoke test | Re-run on every deploy |
| MicroVM-tier run succeeds (`POST /v1/runtime/schedule`) | Verified (this guide, Docker) | Kata smoke test | Kata + gVisor smoke |

### Staging gate

Run both paths before merging to production:

```bash
# 1. Shared-tier smoke
TOKEN=$(curl -s -X POST $API_URL/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"...","password":"..."}' | jq -r .token)
curl -s -X POST $API_URL/v1/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agentName":"smoke-test","input":{"msg":"ping"}}' | jq .status
# → "succeeded" or "queued" (poll until terminal)

# 2. MicroVM smoke (requires cluster with real RuntimeClasses)
lantern vm validate --kubeconfig $KUBECONFIG
# → all 9 legs PASS
```

---

## Known local dev limitations

| Limitation | Description | Prod behaviour |
|---|---|---|
| State stuck `running` | Container exits but DB shows `running` (no harness) | Harness runs as PID 1; exit propagated via Report stream |
| No egress enforcement | Docker containers ignore harness egress rules | Firecracker/gVisor/Kata: egress enforced via iptables REDIRECT |
| No secret vending | `/run/lantern/secrets/` not available without harness | Harness vends secrets from the manager over Unix socket |
| Quota concurrent-VM cap | Fast containers exit before next request; cap looks ineffective | Cap works correctly; harness reports exit and frees slot immediately |
| Firecracker/Kata/gVisor | Not available on macOS; need Linux + KVM | Full isolation on Linux nodes |
| Snapshot/restore (demo 03) | Not functional without Firecracker | Firecracker on Linux KVM nodes |
| GPU scheduling (demo 04) | No GPU on local Docker backend | K8s GPU pool with NVIDIA device plugin |
