# Workflow Engine — Durable Execution

> The heart of Lantern. Read this if you're touching `services/workflow-engine` or any code that calls `step()`.

---

## What "durable execution" means here

A workflow that:
1. Survives any process or host crash and resumes from the last successful step,
2. Re-runs the same code deterministically on resume, returning cached results for already-completed steps,
3. Handles long-running waits (signals, sleeps, approvals) without holding a process open,
4. Provides exactly-once observation of step completion even though execution is at-least-once,
5. Lets you replay any historical run from any step with modified inputs.

This is the same model as Temporal, with two design choices that diverge:

- **Steps, not workflow/activity split.** Lantern collapses Temporal's distinction. Everything inside the user's `run` function is workflow code; anything wrapped in `step(name, fn)` is a side-effect. Determinism is enforced at the boundary by throwing on non-step I/O.
- **Postgres-native journal**, not a custom store. The journal is `journal_events`, hash-partitioned by `run_id`. We chose Postgres because we already need it for everything else and because pg_partman handles the partitioning we need.

---

## Vocabulary

| Term | Meaning |
|---|---|
| **Run** | One execution of an agent. Has a `run_id`, an input, eventually an output or error. |
| **Journal** | Append-only sequence of events for a run, in `journal_events`. The source of truth. |
| **Step** | A side-effect wrapped in `step(name, fn)`. Durable. Idempotent. Replayed on resume. |
| **Replay** | Re-running the user's `run` function from the start with the journal in scope so already-completed steps return cached results immediately. |
| **Worker** | An engine process that picks up runs from the queue and executes them. |
| **Activity host** | The runtime sandbox where the user's code actually runs. The engine talks to it over gRPC. |
| **Signal** | An external event delivered to a running workflow (`POST /signals/{name}`). |
| **Query** | A synchronous read of a workflow's in-memory state (`GET /queries/{name}`). |

---

## Lifecycle of a run

```
                       create run
                            │
                            ▼
                    ┌───────────────┐
                    │    queued     │
                    └──────┬────────┘
                           │ worker picks up
                           ▼
                    ┌───────────────┐
                    │   running     │ ◀──┐
                    └─┬──┬──┬───┬───┘    │ resume after crash
                      │  │  │   │        │
                      │  │  │   │  step.sleep, signal, approval
                      │  │  │   └─────────────┐
                      │  │  │                 ▼
                      │  │  │           ┌──────────┐
                      │  │  │           │  paused  │
                      │  │  │           └─────┬────┘
                      │  │  │                 │
                      │  │  │   wake / signal │
                      │  │  │ ◀───────────────┘
                      │  │  │
                      │  │  ▼
                      │  │ failed
                      │  ▼
                      │ cancelled
                      ▼
                  succeeded
```

State transitions are journal entries. The `runs.status` column is a denormalization for fast reads, updated transactionally with the corresponding journal write.

---

## The journal

`journal_events (run_id, seq, kind, step_id, attempt, payload, created_at)`.

### Event kinds

| Kind | When written | Payload |
|---|---|---|
| `run.started` | First event of a run | input, agent_version, trigger info |
| `run.resumed` | Worker re-acquired a run after pause/crash | worker_id |
| `step.scheduled` | Engine asked the host to execute a step | step_id, attempt |
| `step.started` | Host began executing | step_id, attempt |
| `step.completed` | Host returned a result | step_id, attempt, result (protobuf, possibly spilled to S3) |
| `step.failed` | Host returned an error | step_id, attempt, error |
| `step.cancelled` | Step cancelled (parent context, timeout, user) | step_id, attempt |
| `step.sleep_requested` | `step.sleep(name, dur)` called | step_id, until_ts |
| `step.sleep_fired` | Sleep timer expired | step_id |
| `signal.received` | External signal arrived | name, value, sender |
| `signal.consumed` | Workflow code awaited and got the signal | name, step_id |
| `query.invoked` | External query | name, args, response |
| `child.scheduled` | Child workflow created | child_run_id |
| `child.completed` | Child workflow finished | child_run_id, result |
| `child.failed` | Child workflow failed | child_run_id, error |
| `approval.requested` | `ctx.approval.request(...)` called | request, approvers, deadline |
| `approval.responded` | Approver acted | who, decision, when |
| `run.completed` | Final terminal | output |
| `run.failed` | Final terminal | error |
| `run.cancelled` | Final terminal | cancel reason |

### Event ordering

`seq` is a monotonic integer per run, allocated by the engine in a single Postgres `INSERT ... RETURNING seq` against a per-run sequence (we use `MAX(seq)+1` under the run's advisory lock — there's only ever one writer per run).

The engine ensures **no two workers can write to the same run at the same time** via `pg_advisory_xact_lock(run_id::bigint)` taken at the start of every write transaction. Workers that can't get the lock back off and try the next run.

---

## Replay semantics

When a worker picks up a run that already has journal events (because the previous worker crashed or paused), it:

1. Reads the entire journal in order.
2. Loads it into an in-memory `Journal` struct.
3. Calls into the activity host (re-spawning the sandbox if needed).
4. Re-runs the user's `run` function. Each `step(name, fn)` call:
   - Looks up its index in the journal (the step's "key" is `(name, parent_step_id, child_index)`)
   - If `step.completed` exists for that key → returns the cached result instantly
   - If `step.failed` exists and the retry policy allows another attempt → retries with `attempt + 1`
   - If neither exists → executes `fn` for real, then writes `step.scheduled` + `step.started` + `step.completed`/`step.failed` events
5. Once replay reaches the live tail, the run continues normally.

**Determinism:** the user's code outside `step()` must be deterministic given the input + previously-completed step results. Concretely:
- ✅ Pure logic, conditionals, loops over previous step outputs
- ✅ Reading `ctx.now()` (the engine returns a frozen workflow time)
- ✅ Reading `ctx.random()` (seeded by run_id, deterministic across replays)
- ❌ `Date.now()`, `Math.random()`, network calls, filesystem outside `step()`
- ❌ Iterating over a `Set` whose ordering is not guaranteed

The SDK enforces this at compile time where possible (TS proxy on `Date`, `Math.random`, `fetch`) and at runtime by trapping `NondeterministicReplayError` if replay produces a different sequence of step calls than the journal.

---

## Step API

```ts
// Basic
const result = await step("name", async () => {
  return await fetchTheThing();           // any side-effect
});

// With retry policy
const result = await step("name", fn, {
  retry: {
    max_attempts: 5,
    initial_interval: "1s",
    backoff: 2.0,
    max_interval: "30s",
    non_retryable: ["AuthError", "InvalidInput"],
  },
  timeout: "5m",
});

// Map (parallel fan-out)
const results = await step.map("name", items, async (item, i) => {
  return await processItem(item);
}, { concurrency: 8 });

// Race (first success wins)
const winner = await step.race("name", [
  () => callProviderA(),
  () => callProviderB(),
]);

// Sleep (durable, survives crashes)
await step.sleep("wait-1h", "1h");

// Signal (wait for external event)
const value = await step.signal<UserDecision>("user-decision", { timeout: "30m" });

// Child workflow
const summary = await ctx.subagent("summarizer", { text: longDoc });

// Approval
await ctx.approval.request({
  reason: "About to send 1500 emails",
  approvers: ["user:owner"],
  expiresAt: "2h",
});
```

### Idempotency

Every `step()` execution carries an idempotency key automatically derived as:

```
sha256("v1" || run_id || step_id || attempt)
```

This key is passed to the runtime manager and to any external HTTP/gRPC client through a `Idempotency-Key` header (and to providers that support it natively, like Stripe). Side-effects must accept it; the model router, connector framework, and notifier all do.

---

## Sub-agents (child workflows)

```ts
const result = await ctx.subagent("summarizer", { text: longDoc });
```

The engine schedules a new run with `parent_run_id` set, blocks the parent on a `child.scheduled` event, and resumes the parent when `child.completed` or `child.failed` arrives. Cancellation propagates from parent to child.

A2A peers (`ctx.a2a(...)`) work the same way at the journal level — they're modeled as child invocations whose execution happens out-of-band, with task lifecycle events written to the parent's journal as if they were a child workflow.

---

## Queries

```ts
// In agent code
ctx.query("progress", async () => ({
  step: currentStep,
  itemsProcessed: counter,
}));

// External
GET /v1/runs/{id}/queries/progress
```

Queries are read-only callbacks the agent registers. The engine snapshots in-memory state and returns it. Queries do not write to the journal (so they don't affect replay).

---

## Worker pool, sharding, and fairness

Workers form a pool keyed by `run_id` hash mod `N`. Each worker pulls from `runq:{tenant}:{priority}` lists in Redis using fair-share semantics (LCS — Lottery scheduling weighted by `tenant.tier`).

When a worker picks a run:
1. Acquires `pg_advisory_xact_lock(hash(run_id))`
2. Reads the journal
3. Decides what to do (resume, schedule a step, pause, complete)
4. Commits

If the worker crashes between (1) and (4), the lock is released by Postgres and another worker picks up the run on the next poll cycle.

### Backpressure

Per-tenant `concurrency.max_in_flight` from the agent's `agent.yaml` is enforced at scheduling time. Runs above the cap stay in `queued` state. Per-user concurrency is enforced similarly.

### Fairness

Tenants on `personal` tier get equal share within the personal pool; `team` tier has higher weight; `enterprise` gets dedicated worker capacity reserved for them.

---

## Failure modes and recovery

| Failure | Recovery |
|---|---|
| Engine worker crash mid-step | Journal lock released. Next worker resumes from last journal event. Step retries per its retry policy. |
| Activity host (sandbox) crash | Engine sees stream close. Journals `step.failed`. Retries based on policy. |
| Postgres failover | Engine reconnects, re-acquires advisory lock, continues. In-flight transactions roll back; effects are journaled idempotently. |
| Whole engine fleet down | Runs stay in their last persisted state. On recovery, workers replay from journals. No data loss. |
| Network partition between engine and runtime manager | Engine waits with bounded timeout, then journals `step.failed` with `Unreachable` error. Step retries. |
| Stuck signal (no one ever sends it) | The waiting workflow has a timeout. On expiry, the engine journals `step.timeout` and the workflow handles it. |

---

## Determinism enforcement

The SDK injects:

```ts
// ctx.now() — frozen at the time of the first run, deterministic
// ctx.random() — seeded by run_id
// ctx.uuid() — deterministic uuid v5 from run_id + counter
// fetch(), Date.now(), Math.random() — replaced with thrower in non-step scope
```

In Python:

```python
ctx.now()       # deterministic
ctx.random()    # deterministic
# datetime.now(), random.random() raise inside workflow context outside step()
```

Violations throw `NondeterministicWorkflowError` at runtime; CI lint catches the obvious ones at build time.

---

## Performance characteristics (target SLOs for spike phase)

| Metric | Target |
|---|---|
| Step record latency p99 | ≤ 50 ms |
| Worker pickup latency p99 (warm) | ≤ 100 ms |
| Replay throughput | ≥ 10k journal events/sec per worker |
| Journal write throughput per partition | ≥ 5k events/sec |
| Max in-flight runs per worker | 1k (signal-paused), 50 (active) |

These are conservative for the spike. Production targets will be higher.

---

## What's intentionally NOT in the engine

- **No DSL.** Workflows are just code. We picked SDK-as-DSL over YAML or graph DSL for the same reasons Temporal did: real code beats fake code.
- **No process supervisor.** The engine doesn't try to keep a sandbox alive; it asks the runtime manager to schedule and re-schedules on failure.
- **No saga DSL.** Sagas are just workflows that compose `step()` with explicit compensation steps. We have helpers but no separate primitive.
- **No "long-lived workflow ≠ short-lived workflow" distinction.** Same code path, same engine, same journal.

---

## See also

- [`adr/0003-durable-workflow-engine.md`](../adr/0003-durable-workflow-engine.md) — why we built this and didn't use Temporal/Inngest directly
- [`03-data-model.md`](03-data-model.md) — the journal schema
- [`08-streaming.md`](08-streaming.md) — how step events stream to clients live
