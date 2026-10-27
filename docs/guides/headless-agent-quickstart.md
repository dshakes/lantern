# Headless Agent Quickstart

**What:** run an agent as an isolated, quota-gated, traced workload with one command.
**Why:** untrusted agent code never touches the control plane (invariant #5), and you get logs, traces and a signed receipt for free.
**Try it:** `lantern run examples/headless-agents/01-hello/agent.yaml -f` (after the setup below, ~15 min end to end).

## Prerequisites

The runtime stack must be running. Start it with:

```bash
make dev-infra            # terminal 1 — Postgres, Redis, MinIO
make run-scheduler        # terminal 2 — scheduler on :50055 (gRPC) / :8085 (REST)
make run-runtime-manager  # terminal 3 — runtime-manager on :50054; self-registers with scheduler
make run-api-runtime      # terminal 4 — control-plane wired to the scheduler on :8080
```

Start them in this order: scheduler must be up before the runtime-manager so the
self-registration heartbeat can reach `:8085`.

Or with Docker Compose:

```bash
docker compose -f infra/docker/docker-compose.yml --profile runtime up --build
```

You need the `lantern` CLI:

```bash
( cd packages/cli && go install ./cmd/lantern )
lantern login   # authenticates against localhost:8080 by default
```

## Step 1 — Understand agent.yaml

Every headless agent starts as an `AgentSpec`. Here is the smallest valid one
(identical to `examples/headless-agents/01-hello/agent.yaml`):

```yaml
apiVersion: lantern.dev/v1
kind: AgentSpec

metadata:
  name: hello
  labels:
    demo: "01"

spec:
  # OCI image (digest-pinned in production; tag ok in dev).
  image_digest: lantern/demos/hello@sha256:0000...0001

  # Isolation class — see docs/guides/isolation-classes.md for the decision tree.
  isolation: trusted

  limits:
    vcpu: "100m"       # 0.1 vCPU
    memory: "64Mi"
    timeout: 30s
    scratch_size: "16Mi"

  network: none        # no egress at all
  secrets: []
  egress_rules: []

  idempotent: true     # safe to replay on crash
```

The key fields:

| Field | What it controls |
|---|---|
| `spec.isolation` | RuntimeClass tier: `trusted`, `standard`, `untrusted`, `hostile`, `wasm`, `devcontainer` — see [Isolation classes](isolation-classes.md) |
| `spec.limits` | CPU, memory, wall-clock timeout, scratch disk |
| `spec.secrets` | `lantern.secret/...` refs resolved at boot — see [Identity and secrets](identity-and-secrets.md) |
| `spec.egress_rules` | Domain allowlist enforced by the in-VM harness |
| `spec.idempotent` | Marks the run safe for crash-replay without re-spending tokens |

## Step 2 — Schedule the agent

```bash
lantern run examples/headless-agents/01-hello/agent.yaml \
  --input '{"name": "world"}'
```

`lantern run` posts the spec to `POST /v1/runtime/schedule` and prints the VM id. Add `-f` to stream logs immediately; `lantern vm ls` lists VMs.

Or call the REST API directly:

```bash
curl -X POST http://localhost:8080/v1/runtime/schedule \
  -H "Authorization: Bearer $LANTERN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "imageDigest": "lantern/demos/hello@sha256:0000000000000000000000000000000000000000000000000000000000000001",
    "isolation": "trusted",
    "network": "none",
    "idempotent": true,
    "limits": { "vcpu": "100m", "memory": "64Mi", "timeout": "30s", "scratch_size": "16Mi" }
  }'
# -> {"vmId":"...","node":"...","az":"...","createdAt":"..."}
```

The body is the flat spec (camelCase or the snake_case keys from `agent.yaml`), not wrapped in `spec`.

> If your tenant is over quota the response is `HTTP 402`. Raise the limit with
> `PUT /v1/runtime/quota` (owner role required).

## Step 3 — Watch logs

```bash
lantern vm logs <vm_id> -f
```

Or via the dashboard at `http://localhost:3001/runtime/<vm_id>` — live log stream,
resource sparklines, and the full audit trail in one view.

Via REST:

```bash
curl -N http://localhost:8080/v1/runtime/vms/<vm_id>/logs \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"
# SSE stream of log lines until the VM terminates
```

## Step 4 — Inspect the trace

If you set `OTEL_EXPORTER_OTLP_ENDPOINT` before starting the control-plane, every
spawn emits a correlated trace spanning control-plane → scheduler → manager → harness.
The correlation tuple is `(tenant_id, run_id, step_id, agent_instance_id, trace_id)`.

`OTEL_EXPORTER_OTLP_ENDPOINT` is typically `http://localhost:4318`. Query your trace backend (Jaeger, Tempo, Honeycomb) by `run_id` to see the full
chain. See [Observability](observability.md) for the span names and attribute keys.

## Step 5 — Terminate

```bash
lantern vm stop <vm_id> --grace 10     # seconds
# or: curl -X DELETE http://localhost:8080/v1/runtime/vms/<vm_id> -H "Authorization: Bearer $LANTERN_API_TOKEN"
```

The manager sends `SIGTERM`, waits for the grace window, then kills the pod and
marks the VM `terminated`. The journal gets a final event; if receipts are enabled,
`POST /v1/runs/<run_id>/receipt` issues a signed Ed25519 receipt.

## Step 6 — Fetch the receipt

```bash
curl -X POST http://localhost:8080/v1/runs/<run_id>/receipt \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"
```

The receipt is an Ed25519 signature over the SHA-256 of the run's `journal_events`.
Anyone with the public key at `/.well-known/lantern-receipts` can verify it offline.
See [Verifiable receipts](verifiable-receipts.md).

## Going further

- **Egress + secrets** — try `examples/headless-agents/02-web-scraper/` which
  uses `isolation: untrusted`, an egress allowlist, and a `lantern.secret/` ref.
- **Snapshot/restore** — `03-stateful-research/` demonstrates `devcontainer`
  isolation with workspace persistence across node failures.
- **GPU + cost telemetry** — `04-ml-inference/` reports per-step reasoning tokens
  and accumulated cost via the harness `Report` channel.
- **Isolation decision tree** — [Isolation classes](isolation-classes.md).
- **Crash-replay and exactly-once** — [Durable execution](durable-execution.md).
