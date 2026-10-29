# ADR 0033 — Batch invocation and async completion callbacks

**Status:** Accepted  
**Date:** 2026-10-29  
**Author:** dshakes  
**Relates to:** Gap analysis gaps #2 and #3 (RUNTIME-GAP-ANALYSIS.md)

---

## Context

Two capabilities that "world-class agentic runtimes" (OpenAI Batch, Anthropic Batch) expose were absent:

1. **Async completion callback** — callers fire and forget a run and receive a
   webhook when it reaches a terminal state, rather than polling.
2. **Batch invocation** — submit N inputs against one agent in a single call;
   the platform fans out the runs with optional concurrency control and notifies
   on completion.

---

## Decision

### A. Async completion callback (gap #2)

`POST /v1/runs` accepts an optional `callbackUrl` field in the request body.
When present:

1. The URL is SSRF-validated at request time (blocks private/loopback/link-local
   ranges, metadata IP `169.254.169.254`, enforces HTTPS in prod) before the run
   is created.
2. The URL is persisted in a new `runs.callback_url TEXT` column (migration 0030).
3. After the inline executor reaches a terminal state (success **or** failure),
   `fireCallbackForRun` is called in `executeRunInline`; it dispatches a
   background goroutine via `inFlightRuns` (drained on shutdown).
4. Delivery (`deliverCallbackWithRetry`): idempotent via `claimSideEffect`
   (key `run_id:callback:1`), up to 4 attempts with capped exponential backoff
   (2 s → 4 s → 8 s), 5xx from the receiver is the only retryable error class.
5. The POST body is `{runId, status, output, error, costUsd, tokensIn, tokensOut}`.
6. The signature is `X-Lantern-Signature: v1=<hmac-sha256>` over the body,
   matching the generic inbound-webhook format so callers can verify with the
   same code. The signing secret is `HMAC-SHA256(PAL_CALLBACK_SIGNING_SECRET,
   tenantID)` — per-tenant without a per-run DB row.

### B. Batch invocation (gap #3)

New `batches` table (tenant-scoped, RLS enabled per migration 0030).

`POST /v1/batches` accepts:
- `agentName`, `items[{input, idempotencyKey?}]` (max `PAL_BATCH_MAX_ITEMS`,
  default 1000), optional `concurrency`, optional `callbackUrl`.
- Idempotent via `Idempotency-Key` request header.
- Returns 201 with the batch summary immediately; child run dispatch is async.

The batch handler fans out items via a goroutine pool bounded by `concurrency`
(0 = unlimited). Each item goes through `RESTHandler.CreateRun` in-process
(same pattern as `TriggerHandler.startRun`) so budgets, quotas, and spawn
rate-limits apply per-run. When a concurrency limit is set, the semaphore
channel provides back-pressure with no external queue.

Each child run carries a `batch_id` foreign key. Counts (`pending_count`,
`running_count`, `succeeded_count`, `failed_count`, `cancelled_count`) and
`cost_usd` are maintained incrementally as children complete, with atomic
`UPDATE batches SET ... WHERE id = $1` writes (no transactions needed —
counter updates are independent).

When all children are terminal, `finalizeBatch` marks the batch terminal
(`succeeded` / `failed` / `cancelled`) and fires the batch-level callback
(idempotent, same delivery path as the run callback).

`POST /v1/batches/{id}/cancel` cancels all `queued`/`running` child runs in
one SQL UPDATE and marks the batch cancelled. Idempotent (already-terminal
batch → 200, no-op).

### Scope annotations

- `POST /v1/batches` and `POST /v1/batches/{id}/cancel`: `runs:execute`
- `GET /v1/batches/{id}` and `GET /v1/batches/{id}/results`: `runs:read`

---

## Consequences

- **New env vars:** `PAL_CALLBACK_SIGNING_SECRET` (also `LANTERN_CALLBACK_SIGNING_SECRET`
  for compat), `PAL_BATCH_MAX_ITEMS` / `LANTERN_BATCH_MAX_ITEMS`.
- **No new dependency.** The HTTP client for callback delivery reuses the stdlib
  `net/http.Client`.
- **Migration 0030** adds `runs.callback_url`, `runs.batch_id`, and the `batches`
  table.
- **SDK surfaces:** TypeScript and Python SDK wrappers are a follow-up (not in
  this PR). The REST contract is stable.
- **Data-plane / workflow-engine paths:** the callback fires only from the inline
  executor. Data-plane and workflow-engine paths do not yet call `fireCallbackForRun`;
  that is follow-up work (the DB column is in place, so the data plane can set it
  and the recovery loop can fire it).
- **Batch polling:** `waitAndRecord` polls every 2 s per run. For large batches
  with many quick runs this is fine; for thousands of long-running runs a
  change-notification channel (Redis pub/sub or Postgres LISTEN/NOTIFY) would be
  more efficient. The polling approach is documented here as a known ceiling.

---

## Alternatives considered

- **Storing a per-tenant callback signing secret in `llm_provider_configs`** —
  rejected: adds UI surface and a DB row for a pure signing key. Deriving from a
  global env var keeps it simpler and operator-auditable.
- **Redis Streams or a dedicated notifier service for delivery** — rejected for
  now; the inline executor goroutine + `inFlightRuns` WaitGroup on shutdown
  satisfies the durability requirement without a new service. The recovery loop
  already re-drives runs, which means a crashed delivery is retried on next
  startup.
- **Per-item callback in batch** — not implemented. Batch receivers should use
  `GET /v1/batches/{id}/results` for per-item output; the batch-level callback
  signals completion.
