# Demo 04 — ml-inference

Embeds input texts with sentence-transformers (MiniLM). Proves the
**GPU + cost + telemetry plane** — GPU-class scheduling, cost
accumulation, OTel traces from inside the workload.

**Isolation:** `standard` (Firecracker; the base image is signed/trusted
since we don't load untrusted model weights at runtime).

## Run it

```bash
docker build -t lantern/demos/ml-inference:latest examples/headless-agents/04-ml-inference

lantern run examples/headless-agents/04-ml-inference/agent.yaml \
  --input '{"texts": ["the quick brown fox", "lantern is a microvm runtime"]}'
```

Expected response (truncated):

```json
{
  "count": 2,
  "total_tokens": 14,
  "total_cost_usd": 0.0000028,
  "wall_ms": 312.5,
  "embeddings": [
    { "text": "the quick brown fox", "dim": 384, "sample": [...] },
    { "text": "lantern is a microvm runtime", "dim": 384, "sample": [...] }
  ]
}
```

## What you'll see in the dashboard

`localhost:3000/runtime/<vm_id>`:

- **Resource panel**: vCPU, memory, **GPU=1 (NVIDIA L4)**, accumulated
  cost ticking up while the workload runs.
- **Trace panel**: spans `model.load` → `inference.encode[0]` →
  `inference.encode[1]` with timings, all linked to the parent
  `runtime.spawn` trace.
- **Logs**: the workload's single JSON line at the end + harness
  audit events (`secret.vend` × 0, `egress.allow` × 0, `cost.report` × 2).

## What this proves

- **GPU scheduling**: `limits.gpu="1"` forces the scheduler to a node
  whose warm pool has free GPU slots. If none available, scheduler
  rejects with `429 no-capacity` instead of overcommitting.
- **Tier-1 snapshot caching**: first run pays the model-load cost
  (~12s in real life). The harness signals "model loaded, ready to
  snapshot" and the manager takes a Firecracker snapshot. Subsequent
  invocations restore from that snapshot — model weights already in
  GPU VRAM, first inference completes in ~150ms.
- **OTel trace continuity**: the trace_id created in the control-plane
  schedule call flows through scheduler → manager → harness → workload
  spans. One trace view per agent run, end-to-end.
- **Cost accumulation**: the workload writes running cost to
  `/run/lantern/cost.txt`. Harness reads it, reports via
  `Heartbeat.ResourceUsage.cost_usd_accumulated`. Control-plane
  totals across the day, hits 402 when `max_cost_usd_per_day` exceeded.
