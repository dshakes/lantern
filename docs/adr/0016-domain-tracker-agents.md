# ADR 0016 — Domain-Tracker Agents: ingest → extract → store → track → coach

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Lantern personal-harness, control-plane
- **Tags:** loop-agents, personal-harness, pii, encryption, commitments

## Context

The personal harness already classifies inbound messages into typed life-events
(`bill`, `appointment`, `delivery`, …) and creates commitments from actionable
email via `inbox_autopilot`. But it has no structured, persisted store for
multi-visit health history, vehicle service records, or career milestones.
Obligations from these domains (refill a prescription, renew vehicle
registration, follow up on a job application) disappear into the generic
commitment list with no domain context.

Three life domains need the same pattern:

| Domain  | Name            | Gmail signal                                   |
|---------|-----------------|------------------------------------------------|
| health  | care-coordinator | labs, appointments, prescriptions, insurance   |
| vehicle | garage          | service, registration, recalls, insurance       |
| career  | upskill         | applications, interviews, courses, certs        |

## Decision

### Pattern: ingest → extract → store → track → coach

One generic `domain_tracker` loop role handles all three domains. The manifest
carries `domain` (health|vehicle|career) and `query` (a Gmail search expression)
as configuration. The shared loop body is `runDomainTracker` → `processDomainMessages`.

```
Gmail (list_recent, domain query)
  ↓  per-domain cursor (gmail_poll_cursors WHERE domain = $domain)
  ↓  LLM extraction  (strict JSON: records + obligations)
  ↓
domain_records (encrypted PII)       commitments (obligations)
  ↓                                    ↓
future coaching pass                 concierge nudge loop
```

### `domain_records` table

A dedicated `domain_records` table (migration 0007) stores the structured
records. Key design choices:

1. **`fields_encrypted text`** — the structured detail blob (medications, VIN,
   salary range, …) is AES-256-GCM encrypted via the same `internal/secrets`
   envelope used for connector credentials. In dev (no `LANTERN_CREDENTIAL_KEY`)
   it stores plaintext and decrypts transparently — the rollout is migration-free.
   The column is `text` not `jsonb` because an encrypted envelope is opaque to
   Postgres operators.

2. **Idempotency key** — `"domain:<domain>:<msg_id>:<kind>:<title[:50]>"` deduplicates
   re-extractions of the same message. A partial unique index on
   `(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL` enforces this
   at the DB layer (same pattern as `commitments`).

3. **RLS** — `ENABLE + FORCE + tenant_isolation` (USING + WITH CHECK = same
   `current_setting('app.tenant_id')` guard as every other tenant table). Added
   to the `rlsTenantTables` gate-test (`TestRLSEnforcement_AllTenantTables`).

### Obligations reuse commitments

Domain-derived action items (schedule a follow-up, renew registration, apply
before a deadline) are stored as regular `commitments` with `source = <domain>`.
This means the existing concierge nudge loop surfaces them automatically without
any new nudging infrastructure. The `validSources` enum is extended to include
`"health"`, `"vehicle"`, `"career"`.

### Per-domain Gmail cursor

`gmail_poll_cursors` is extended with a `domain text NOT NULL DEFAULT 'inbox'`
column and its primary key is migrated from `(tenant_id)` to `(tenant_id, domain)`.
This lets each domain-tracker instance advance its own high-water mark
independently from `inbox_autopilot`'s `'inbox'` cursor.

### Trust and security model

| Concern | Decision |
|---------|----------|
| Email content | Treated as **untrusted data**. The LLM system prompt explicitly forbids following email instructions. Extraction is parse-only. |
| LLM output | Stored as structured records for the owner's review. Never executed server-side. |
| PII at rest | `fields_encrypted` is AES-256-GCM via `LANTERN_CREDENTIAL_KEY`. Decrypted only in the handler response; never logged, never traced (invariant #10). |
| Idempotency | Extraction keyed on `(domain, msg_id, kind, title)`. Obligations keyed on `(domain, msg_id, kind, title)`. Both use `ON CONFLICT DO NOTHING`. LLM calls carry `WithLLMIdempotencyBase` (invariant #8). |
| Cross-tenant | RLS enforced at Postgres. HTTP handlers route through `WithTenant`. The loop body uses explicit `tenant_id` filter (same as `runFinancialSentinel`). |
| Owner confirm | All three agents seed with `trust: "ask"` — no auto-action without owner confirmation. |

## Consequences

- **New table:** `domain_records` — tenant-scoped, RLS-enforced, encrypted PII.
- **Schema change:** `gmail_poll_cursors` gains a `domain` column and composite PK.
  Existing `inbox_autopilot` rows are preserved with `domain = 'inbox'`.
- **New source enum values:** `health`, `vehicle`, `career` in `commitments.validSources`.
- **New routes:** `POST/GET /v1/domain-records`, `PUT/DELETE /v1/domain-records/{id}`.
- **Three new seeded agents:** `care-coordinator`, `garage`, `upskill` (all `domain_tracker` role, `tier=macro`, daily cron).
- **Deferred:** Mac-file ingest (PDFs, receipts), web/LinkedIn ingestion for career, coaching pass (proactive domain-specific nudges beyond the generic concierge). These reuse the same `processDomainMessages` → `domain_records` foundation.
