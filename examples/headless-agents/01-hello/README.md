# Demo 01 — hello

Smallest possible Lantern headless agent. **One Python script** that echoes
its input + emits a structured log line. Exits 0.

**Isolation class:** `trusted` — Lantern-authored code, no untrusted package
loading, no external network. K8s Job backend, ~100ms warm start.

## Run it

```bash
# Build the OCI image
docker build -t lantern/demos/hello:latest examples/headless-agents/01-hello

# Schedule via CLI
lantern run examples/headless-agents/01-hello/agent.yaml --input '{"name": "Shekhar"}'

# Watch the live log in the dashboard
open http://localhost:3000/runtime
```

## What you'll see end-to-end

1. **Control-plane** (`POST /v1/runtime/schedule`):
   - JWT validated; tenant_id extracted from claims.
   - `checkRuntimeQuota` passes (under 20 concurrent VMs default).
   - Audit event written: `action=schedule`, `vm_id=<new>`.
   - Stub gRPC call to scheduler (real wire-up in P3 of the rollout).
   - Row inserted into `runtime_vms` with `state=pending`.
2. **Scheduler** picks a node (currently: the only registered runtime-manager).
3. **Runtime-manager** spawns the K8s Job using the image digest from the spec.
4. **Harness** comes up as PID 1, opens a heartbeat stream back to the manager.
5. **Workload** reads stdin, writes one JSON log line, exits 0.
6. **Harness** sees clean exit; emits final ResourceUsage + closes stream.
7. **Manager** tears down the pod, marks `runtime_vms.state=terminated`.
8. **Dashboard** sees the state transitions live via the SSE stream on
   `/v1/runtime/vms/{id}/logs` and the WebSocket on `/v1/runtime/events`.

## What this proves

- The proto contract (`runtime.proto`) is well-formed end-to-end.
- The control-plane → scheduler → manager → harness chain works.
- Quotas + audit are enforced before any compute fires.
- Log lines and resource usage flow back from inside the VM to the dashboard.
- Clean shutdown releases the slot for the next schedule.
