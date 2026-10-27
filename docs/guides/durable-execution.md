# Durable Execution

**What:** every run journals each step to `journal_events`; after a crash it resumes from the first incomplete step.
**Why:** no re-spent tokens, no double side-effects, no checkpoint code (invariant #3).
**Try it:** start a run, `kill -9` the control plane mid-run, restart it, and watch `curl -N .../v1/runs/<run_id>/events` continue (the sweep runs every 30s).

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
mid-tool-execution — the recovery sweep (`internal/handlers/recovery.go`, every 30s, `LANTERN_RECOVERY_INTERVAL`)
finds runs in `running`/`queued` whose `run_locks` row is absent or expired, takes a fresh
lock, and re-drives them.

On re-drive, the workflow interpreter walks the graph from the trigger again. For every
side-effecting node (`ai-step`, `tool`, `connector`, `subagent`, `approval`) that already has a
`step_completed` event in the journal, it **returns the cached output** without re-executing.
The plain-LLM path has the same cache (`checkCachedLLMStep`, `durable_replay.go`).

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
`side_effect_receipts` (`claimSideEffect`). On replay, if the receipt exists, the side-effect is
skipped entirely and the original response is returned. **Each external call fires
at most once.**

### Exactly-once completion

Runs are guarded by a distributed lease in the `run_locks` table. Recovery only steals a lock that has
expired (a single UPSERT), so a second worker cannot take a live run. If the
original worker dies, the lease expires and the sweep re-assigns.
Concurrent double-execution is prevented; exactly-once completion observation is
guaranteed by the journal.

## Run lease and recovery watchdog

Each driven run holds a lease row in `run_locks`:

```text
run_id | worker_id     | expires_at
-------+---------------+-------------------
abc123 | worker-7      | 2026-06-21T10:05:00
```

A recovery-acquired lock has a TTL of 10 minutes (`recoveryLockTTL`). If `expires_at` lapses, the
recovery sweep treats the run as orphaned and re-drives it; the journal supplies the cached steps.

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

Normal path: the sweep re-drives it automatically once the lease has expired (poll interval 30s by
default; a lease acquired by a previous recovery can last up to 10 minutes).

If you need to force recovery:

```bash
# Check the run's current state
curl http://localhost:8080/v1/runs/<run_id> \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"
```

There is no manual "resume" endpoint for crashed runs - recovery is automatic. If a
run stays stuck past the lease TTL, check the control-plane logs for a panic or DB
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
  the re-driven parent finds the child's completed `step_completed` in the journal and does not re-spawn it. In the durable `workflow-engine`, a crash between creating the child row and journaling completion is handled by adoption via `trigger_meta`. A child that stops on `approval`/`wait_signal` fails the parent step with `ErrChildRunPaused` (nested approvals are not supported yet).

## Human-in-the-loop (approval nodes)

`approval` nodes block on a `takeover_requests` row:

```text
state: pending → granted → released
```

The run stays blocked on the row. When an operator grants the
takeover (via `POST /v1/runs/<id>/takeover/<tid>/grant`), the workflow interpreter
unblocks and continues. The approval wait survives engine restarts — on resume the
interpreter re-checks the `takeover_requests` row state.
