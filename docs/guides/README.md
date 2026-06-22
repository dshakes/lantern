# Lantern — User Guides

The **headless agent runtime** is the execution kernel that runs your agents inside
your own Kubernetes cluster. You declare an `AgentSpec` (image, isolation class,
resources, secrets, egress rules), hand it to `lantern run`, and the platform takes
it from there: quota gate, scheduler placement, hardened pod spawn, in-VM harness
boot, short-TTL secret vending, OTel-traced execution, journal-backed crash replay,
and a signed receipt at the end.

This directory contains practical guides for the runtime. Each is self-contained;
follow the cross-links when you need depth.

## Guides in this directory

| Guide | What it covers |
|---|---|
| [Headless agent quickstart](headless-agent-quickstart.md) | Write `agent.yaml`, run it, watch logs, terminate. End-to-end in ~15 min. |
| [Isolation classes](isolation-classes.md) | Pick the right isolation class for your workload. Decision tree + fail-closed gate explanation. |
| [Durable execution](durable-execution.md) | How crash-replay works: exactly-once completion, no re-spent tokens, recovery watchdog. |
| [Observability](observability.md) | One trace per spawn, GenAI semconv, loop/retry anomaly events, `GET /v1/runtime/metrics`. |
| [Identity and secrets](identity-and-secrets.md) | Per-instance Ed25519 identity, short-TTL secret vending over mTLS, the `lantern.secret/` ref form. |
| [Verifiable receipts](verifiable-receipts.md) | Ed25519-signed receipts, offline verification, tamper-evidence. |

## Where to go from here

- **Architecture decisions** — [`docs/adr/`](../adr/) has the full reasoning for each
  load-bearing runtime choice (secret vending, K8s substrate, isolation tiering, secret relay).
- **Strategy + gap analysis** — [`docs/architecture/18-agent-runtime-nextgen.md`](../architecture/18-agent-runtime-nextgen.md)
  explains where the runtime sits relative to AWS AgentCore, Google Vertex, and Temporal,
  and the phased roadmap with validation gates.
- **Runtime isolation deep dive** — [`docs/architecture/04-runtime-isolation.md`](../architecture/04-runtime-isolation.md).
- **Workflow engine internals** — [`docs/architecture/05-workflow-engine.md`](../architecture/05-workflow-engine.md).
- **Example agents** — [`examples/headless-agents/`](../../examples/headless-agents/) —
  four runnable demos, each with an `agent.yaml`, workload code, and a `README.md`
  explaining why that isolation class was chosen.
- **Manual test walkthrough** — [`examples/headless-agents/MANUAL-TEST.md`](../../examples/headless-agents/MANUAL-TEST.md) —
  step-by-step REST-level exercise of scheduling, quotas, audit, and terminate.
- **Docs site** — served at `localhost:3002` in dev (`make dashboard-dev` also starts it).
