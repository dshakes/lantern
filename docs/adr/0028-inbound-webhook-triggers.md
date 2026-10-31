# ADR 0028 — Inbound webhook triggers (unauthenticated ingress)

- **Status:** Accepted
- **Date:** 2026-10-27
- **Extends:** invariant #7 (multi-tenant trust boundaries), invariant #8 (idempotency), [ADR 0011](0011-rls-all-tenant-tables.md) (RLS).

## Context

Most "real" agent examples start from someone else's event: a GitHub PR, a Sentry
alert, a PagerDuty incident. Today the only ways to start a run are an authenticated
`POST /v1/runs`, a cron schedule, or a messaging surface. None of those lets GitHub
start a run, because GitHub cannot hold a PAL Runtime JWT or API key.

A webhook endpoint is a **new unauthenticated ingress** that creates runs, which spend
the tenant's LLM budget. Whoever can make a request look valid can spend another
tenant's money. That is the risk this ADR bounds.

## Decision

A tenant creates a **trigger** bound to one of its agents
(`agent_triggers`, tenant-scoped, RLS). Each trigger gets an unguessable UUID and a
per-trigger secret. The sender POSTs to the public `POST /v1/hooks/{triggerId}`.

**Authentication is the signature, nothing else.** The handler resolves the trigger by
id (the only pre-auth query, on the privileged pool, `rls-exempt`), then verifies an
HMAC-SHA256 over the raw body with the trigger's secret in the provider's format:

| provider    | signature header                        | signed bytes        | delivery id                  |
| ----------- | --------------------------------------- | ------------------- | ---------------------------- |
| `generic`   | `X-Pal-Signature: t=<unix>,v1=<hex>` | `<t>.<body>`        | `X-Pal-Delivery`, else derived |
| `github`    | `X-Hub-Signature-256: sha256=<hex>`     | body                | `X-GitHub-Delivery`          |
| `sentry`    | `Sentry-Hook-Signature: <hex>`          | body                | `Request-ID`                 |
| `pagerduty` | `X-PagerDuty-Signature: v1=<hex>[,v1=…]` | body                | `event.id` in the body       |

Comparison is constant-time (`hmac.Equal`). Unknown id, disabled trigger, or an agent
that no longer exists → `404` (same body for all three). Bad or missing signature → `401`.
Nothing past the lookup runs before the signature verifies, and the response never says
which check failed.

**Replay.** Only the `generic` format signs a timestamp; it must be within ±5 min. GitHub,
Sentry and PagerDuty sign the body only, and their delivery ids are *not* signed, so an
attacker holding one captured request could replay it with a fresh delivery id. Every
delivery is therefore deduplicated on **two** keys, each unique per trigger:
the provider delivery id, and a SHA-256 of the signed bytes (`replay_key`). A real
redelivery matches the first; a replay with a forged id matches the second. Either
match → `200 {"duplicate":true}`, no second run (invariant #8: the delivery id is the
idempotency key). The cost of this choice: a sender that deliberately posts the
byte-identical body twice gets one run. All four providers include a unique id or
timestamp in their payloads, so this only bites hand-rolled senders, which should use the
`generic` format (its signed bytes include the timestamp).

**Run creation goes through the existing path.** The verified delivery is turned into a
`POST /v1/runs` against `RESTHandler.CreateRun` with the trigger's tenant, so the per-tenant
spawn limiter, `CheckBudget` (402 on a hard-fail budget), microVM/data-plane routing
and inline execution all apply unchanged. The run is stamped `trigger_kind = webhook`.
If creation fails, the delivery row is removed so the provider's own retry can succeed later.

**Limits.** Body capped at 1 MiB (`413`). Each trigger is rate-limited after signature
verification (`PAL_HOOK_RATE_PER_MIN`, default 60; `429`), so an unauthenticated
flood cannot exhaust a legitimate sender's allowance. The limiter is per replica; the
per-IP edge limit is a separate concern.

**Secrets.** Stored with `internal/secrets` (AES-256-GCM when `PAL_CREDENTIAL_KEY`
is set). Shown once on create (when PAL Runtime generates it), never returned by list/get,
never logged (invariant #10). Sentry and PagerDuty generate their own signing secrets,
so `PATCH` accepts a replacement secret.

**Input mapping.** A trigger may carry an `inputTemplate` (JSON object). A string that is
exactly `{{path}}` is replaced by the typed value at that dotted path in
`{payload, event, provider, deliveryId, triggerId}`; `{{path}}` inside a longer string is
interpolated as text. No template → `{provider, event, deliveryId, payload}`. No
expressions, no code: a template cannot do anything but copy fields.

## Consequences

- One new unauthenticated route. Its blast radius is "start a run for one agent, within
  that agent's budget", and only for a sender that holds the trigger's secret.
- `agent_trigger_deliveries` grows by one row per delivery. No retention sweep yet;
  add one when a tenant's volume makes it matter.
- Rotating a secret is `PATCH`; there is no dual-secret grace window. Add one if a
  provider rotation ever needs zero downtime.
