# Durable Execution

Every agent run in Lantern is **durable by default**: the workflow engine journals
every step, and on crash it replays from the last completed step — no re-spent
tokens, no double side-effects, no manual checkpoint logic in your code.

This guide explains what that means in practice, how to inspect the journal, and
how to recover a stuck run.

For the engine internals (event sourcing, determinism, signals, queries) see
[`docs/architecture/05-workflow-engine.md`](../architecture/05-workflow-engine.md).

## How it works

### The journal

Every run has an append-only sequence of events in `journal_events`:

```text
run_started
step_started  {step_id="fetch", attempt=1}
step_completed {step_id="fetch", result=...}
step_started  {step_id="summarize", attempt=1}
...
run_completed
```

The journal is the source of truth. No other table or in-memory state wins
against it.

### Replay on crash

When the engine worker that owns a run crashes — mid-step, mid-LLM-call,
mid-tool-execution — the recovery watchdog detects the abandoned run (via the
run lease heartbeat expiry) and re-drives it on the next available worker.

On resume, the engine replays the user's `run` function from the start. When it
reaches a step that already has a `step_completed` event in the journal, it
**returns the cached result immediately** without re-executing the side-effect.
The user's code sees no difference.

Consequence: a crash mid-way through a 10-step agent replays steps 1–N instantly
(journal lookups) and continues from step N+1.

### No re-spent tokens

LLM calls are wrapped as steps. The step result (the model response) is persisted
in the journal on first completion. On replay, the cached response is returned
without calling the model API again. **Tokens are spent exactly once per step,
even under chaos.**

### No double side-effects

External calls — webhook deliveries, email sends, Twilio messages, Stripe charges —
carry an idempotency key derived from `(run_id, step_id, attempt)` stored in
`side_effect_receipts`. On replay, if the receipt exists, the side-effect is
skipped entirely and the original response is returned. **Each external call fires
at most once.**

### Exactly-once completion

The engine uses a distributed run lease (`run_locks` table, heartbeat-renewed by
the owning worker). A second worker cannot pick up a run that is still live. If
the original worker dies, the lease expires and the watchdog re-assigns.
Concurrent double-execution is prevented; exactly-once completion observation is
guaranteed by the journal.

## Run lease and recovery watchdog

Every worker holds a lease row in `run_locks`:

```text
run_id | worker_id     | expires_at
-------+---------------+-------------------
abc123 | worker-7      | 2026-06-21T10:05:00
```

The worker heartbeats the lease every 10s. If `expires_at` lapses without renewal,
the recovery watchdog (a background goroutine in the engine) treats the run as
orphaned and re-queues it. The new worker replays the journal and continues.

## Inspecting the journal

### Via the dashboard

`http://localhost:3001/runs/<run_id>` renders the full event waterfall — step
starts, completions, anomaly events, and the final receipt — in timeline order.

### Via REST

```bash
# Get the run (includes status, cost, token counts)
curl http://localhost:8080/v1/runs/<run_id> \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"

# Stream events (SSE) — includes journal events as they land
curl -N http://localhost:8080/v1/runs/<run_id>/events \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"
```

### Via Postgres (direct access in dev)

```sql
SELECT seq, kind, step_id, payload
FROM journal_events
WHERE run_id = '<run_id>'
ORDER BY seq;
```

## Recovering a stuck run

A run is stuck if:

- `status = 'running'` but no `step_started` event has landed in the last N minutes.
- The run lease in `run_locks` has expired but the watchdog hasn't fired yet.

Normal path: the recovery watchdog re-drives it automatically within the lease
expiry window (default: lease TTL + watchdog poll interval, typically ~60s).

If you need to force recovery:

```bash
# Check the run's current state
curl http://localhost:8080/v1/runs/<run_id> \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"
```

There is no manual "resume" endpoint — the engine re-drives automatically. If a
run stays stuck after 5+ minutes, check the engine logs for a panic or DB
connectivity error; those block the watchdog.

## What "exactly-once" does and does not cover

The engine provides exactly-once **completion observation**: the `run_completed`
event (and the state change from `running` to `succeeded`) happens exactly once.

Side-effects get at-most-once delivery via the idempotency-key dedup in
`side_effect_receipts`. Third-party APIs that do not honor idempotency keys (rare
but real) may fire twice on a crash between the API call and the receipt write.
Design around this by wrapping non-idempotent calls in a step that checks a
precondition before firing.

## `idempotent: true` in agent.yaml

Setting `idempotent: true` in the spec signals that the entire run is safe to
restart from the beginning — all steps and side-effects are idempotent. The
scheduler uses this to allow immediate re-scheduling without waiting for the
lease expiry window on a known-dead node.

```yaml
spec:
  idempotent: true
```

## Loop and subagent nodes

Workflow graph nodes of type `loop` and `subagent` are also durable:

- **Loop** — each iteration emits `step_started`/`step_completed` events. On crash
  mid-iteration, replay re-runs from the last completed iteration.
- **Subagent** — the parent run tracks the child `run_id` in its journal. On crash,
  the watchdog checks the child's status; if it completed, the result is returned
  from the journal without re-spawning.

## Human-in-the-loop (approval nodes)

`approval` nodes block on a `takeover_requests` row:

```text
state: pending → granted → released
```

The run holds its lease (heartbeating) while blocked. When an operator grants the
takeover (via `POST /v1/runs/<id>/takeover/<tid>/grant`), the workflow interpreter
unblocks and continues. The approval wait survives engine restarts — on resume the
interpreter re-checks the `takeover_requests` row state.
