# runtime-scheduler

Cluster-scoped placement service for the Lantern runtime. Picks which
node should host a candidate microVM, dispatches the spawn to that
node's `runtime-manager`, and streams `StatusEvent`s back to callers.

Proto contract: `packages/proto/lantern/v1/runtime.proto`
Generated Go stubs: `gen/go/lantern/v1/runtime.pb.go` (+ `_grpc.pb.go`)

## Responsibilities

1. Receive `Schedule(ScheduleRequest) → VmHandle` from control-plane.
2. Maintain in-memory cluster state — registered nodes, warm-pool
   inventory, per-node load, per-tenant live-VM counts.
3. Pick a node by weighted score (see `internal/scoring/`).
4. Forward the spawn to the picked node's `runtime-manager` over gRPC.
5. Stream `StatusEvent`s through `Events(EventsRequest)`.
6. Enforce per-tenant fair-share + concurrency hard cap.

## Score function

`internal/scoring/score.go` computes a weighted sum of five normalized
`[0..1]` sub-scores:

| Component           | Range | Notes                                                          |
|---------------------|-------|----------------------------------------------------------------|
| `warm_pool_match`   | 0–1   | 1.0 exact image+class+size, 0.3 image-only, 0 cold             |
| `region_match`      | 0–1   | 1.0 same region, 0.5 same continent, 0 cross                   |
| `fair_share`        | 0–1   | Linear decay from soft cap to 2× soft cap                      |
| `cost`              | 0–1   | Spot > on-demand; ARM > x86 when not architecture-locked       |
| `health`            | 0–1   | Penalize recent OOM / kernel events                            |

Weights are configurable via env (`SCHEDULER_WEIGHT_WARM_POOL`,
`SCHEDULER_WEIGHT_REGION`, `SCHEDULER_WEIGHT_FAIR_SHARE`,
`SCHEDULER_WEIGHT_COST`, `SCHEDULER_WEIGHT_HEALTH`). Defaults
prioritize warm-pool hits and region affinity (see
`scoring.DefaultWeights`).

## Ports

| Port  | Protocol | Purpose                                            |
|-------|----------|----------------------------------------------------|
| 50055 | gRPC     | `lantern.v1.RuntimeScheduler` + health + reflection|
| 8085  | HTTP     | REST gateway + `/healthz` + `/readyz`              |

## REST gateway

Same JWT auth as the control-plane (`Authorization: Bearer <jwt>`).
`tenant_id` is taken from the claim, never the body.

| Method | Path                    | Purpose                                          |
|--------|-------------------------|--------------------------------------------------|
| POST   | `/v1/schedule`          | Schedule a workload (returns `VmHandle`)         |
| GET    | `/v1/vms`               | List caller's live VMs (`?labels=k=v,...`)       |
| DELETE | `/v1/vms/{id}`          | Terminate a VM (`?reason=...`)                   |
| GET    | `/v1/cluster`           | Capacity + health overview                       |
| POST   | `/v1/nodes/heartbeat`   | Manager → scheduler node heartbeat (shared token)|

Node heartbeats authenticate with `X-Scheduler-Token` (matches
`SCHEDULER_NODE_TOKEN`). Heartbeats older than 30s flip the node to
`draining`.

## Configuration

| Env                              | Default                                                | Notes                                  |
|----------------------------------|--------------------------------------------------------|----------------------------------------|
| `LISTEN_ADDR`                    | `:50055`                                               | gRPC listen address                    |
| `HTTP_ADDR`                      | `:8085`                                                | REST listen address                    |
| `JWT_SECRET`                     | `lantern-dev-jwt-secret-do-not-use-in-production`      | Same secret as control-plane           |
| `SCHEDULER_NODE_TOKEN`           | (empty: auth disabled)                                 | Required for node heartbeats in prod   |
| `SCHEDULER_TENANT_MAX_VMS`       | `20`                                                   | Hard cap on concurrent VMs per tenant  |
| `SCHEDULER_WEIGHT_*`             | see `scoring.DefaultWeights`                           | Tunable score weights                  |
| `LOG_LEVEL`                      | `info`                                                 | zap level                              |

## Running locally

```bash
cd services/runtime-scheduler
go build ./...                     # compile
go test ./internal/scoring/...     # run scoring tests
go run ./cmd/scheduler             # boot on :50055 + :8085
```

Smoke test (assuming you have a valid JWT in `$TOKEN`):

```bash
# Pretend a node heartbeats in
curl -s -X POST localhost:8085/v1/nodes/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"name":"node-1","address":"node-1.lantern.svc:50054","region":"us-east-1","is_spot":true,"is_arm":true,"free_vcpu_millis":4000,"free_memory_bytes":8589934592}'

# Schedule a VM
curl -s -X POST localhost:8085/v1/schedule \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"spec":{"image_digest":"sha256:abc","isolation":2,"limits":{"vcpu":"500m","memory":"512Mi"},"preferred_regions":["us-east-1"]}}'

# List VMs
curl -s -H "Authorization: Bearer $TOKEN" localhost:8085/v1/vms

# Get cluster topology
curl -s -H "Authorization: Bearer $TOKEN" localhost:8085/v1/cluster
```

## TODOs (W12 follow-ups)

* Replace `dialer.LogOnlyDialer` with a real per-node `RuntimeManagerClient`
  pool (cached `grpc.ClientConn` keyed by node address).
* Wire `Snapshot` to manager (currently returns a synthetic snapshot id).
* Persist cluster state (etcd or Postgres) — `ClusterStore` interface is
  the seam for swapping the backend.
* Replace the lightweight `unaryTracingInterceptor`/`streamTracingInterceptor`
  with `otelgrpc` once the rest of the platform standardizes on it.
* Per-tenant rate limits beyond concurrency hard cap (e.g. spawn rate).
* Source `recent_oom_count` / `recent_kernel_events` from a real signal
  stream (today they come straight from heartbeat payloads).
