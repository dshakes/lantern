# Headless-Agent Demos

Four end-to-end examples that showcase the Lantern headless-agent execution
layer (`packages/proto/lantern/v1/runtime.proto`, `services/runtime-scheduler`,
`services/runtime-manager`, `services/harness`). Each demo:

1. Has its own `agent.yaml` declaring image, isolation class, resources, secrets, egress rules.
2. Has minimal workload code (`workload.py` or similar).
3. Has a `README.md` explaining what it demonstrates and why this isolation class was picked.
4. Runs end-to-end via `lantern run agent.yaml --input <payload>`.

> **Trying things out?** [`MANUAL-TEST.md`](./MANUAL-TEST.md) is a step-by-step
> guide for exercising the runtime today: scheduling, listing, quotas
> (HTTP 402), audit, terminate — with an honest "what's real vs. stubbed"
> section so you know where the seams are.

| # | Demo | Isolation | What it proves |
|---|---|---|---|
| **01** | `hello`             | `trusted`      | The smallest possible round-trip. Validates spawn → exec → stream → terminate. Cold start ≤ 1.5s, warm ≤ 100ms. |
| **02** | `web-scraper`       | `untrusted`    | Egress allowlist + secret vending. Agent fetches a URL via the harness-enforced proxy; non-allowlisted requests get denied + audited. |
| **03** | `stateful-research` | `devcontainer` | Snapshot/restore for long-lived work. Agent maintains a workspace across calls; checkpoints to a snapshot the scheduler can restore on a different node. |
| **04** | `ml-inference`      | `standard`     | GPU pool + cost telemetry. Loads a small ONNX model, runs inference, reports tokens-equivalent compute cost back via the harness Report channel. |

---

## Running locally

Requirements:
- `make dev-infra` running (Postgres + Redis + MinIO).
- `make run-api`, `make run-scheduler`, `make run-runtime-manager` (or just `make dev` if you have all the local services wired).
- One Lantern node registered with the scheduler (the runtime-manager auto-registers on boot).
- Docker / containerd present on the node — the demos use OCI images.

```bash
# Build all four demo images locally
make -C examples/headless-agents build-all

# Schedule + tail logs for one demo
lantern run examples/headless-agents/01-hello/agent.yaml --input '{"name": "Shekhar"}'

# Or via REST directly
curl -X POST http://localhost:8080/v1/runtime/schedule \
  -H "Authorization: Bearer $LANTERN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @examples/headless-agents/01-hello/spec.json
```

The dashboard at `localhost:3000/runtime` shows the live VM, its log stream,
resource usage, and lets you exec into it for debugging.

---

## Why these four

They're chosen to exercise different parts of the system:

- **01** is the smoke test — if this works, the proto, scheduler, manager, and harness all talk to each other.
- **02** exercises the security plane — egress allowlist, secret vending, audit log all visible in the dashboard.
- **03** exercises the HA + state plane — snapshot/restore is the load-bearing feature for "long-lived agents that survive node failure".
- **04** exercises the cost + telemetry plane — GPU-class scheduling, accumulated cost reporting, OTel traces from inside the workload.

If a fifth demo is needed later, a good candidate is a **multi-agent workflow**
(orchestrator agent in one VM that spawns N sub-agents) which exercises the
scheduler's fair-share and the workflow engine's step replay together.
