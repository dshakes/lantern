# ADR 0029 — Kiosk / demo mode (ephemeral anonymous tenants)

- **Status:** Accepted
- **Package:** W2-K
- **Relates to:** ADR 0011 (RLS), ADR 0027 (sign-up), W2-0 (fixture LLM)

## Context

We want `lantern demo`: a clean clone reaches a guided tour in minutes, on a booth
machine or a public demo host, with no account and **no LLM provider key**. That
means anonymous visitors get a working workspace. This is a trust-boundary change:
the control plane mints tenants and credentials with no human sign-up.

## Decision

1. **Tenant per visitor.** `POST /v1/kiosk/session` creates a `kiosk-<rand>` tenant
   (slug prefix + `tenants.settings = {"kiosk": true, "kiosk_expires_at": ...}`) with
   one `member` user, seeds three demo agents, one finished run each (with journal
   events so the waterfall renders) and one agent whose daily budget is already spent
   (the HTTP 402 demo). No migration: the marker lives in the existing `settings` JSONB.
   Seed content is code (`handlers/kiosk.go`), not a cloned template tenant: nothing to
   drift or to leak between visitors.
2. **Scope-limited token.** The response carries a JWT with role `kiosk` and scopes
   `read, agents:*, runs:read, runs:execute`. `HasScope` treats role `kiosk` like a
   scoped service key, so `LANTERN_AUTHZ_ENFORCE=1` really constrains it (a plain
   member JWT passes every scope check). It cannot write settings, connectors,
   budgets, mint API keys or delete the tenant. Its `exp` equals the session TTL.
3. **TTL and purge.** Default 30 min (`LANTERN_KIOSK_TTL_MIN`). A sweep
   (`LANTERN_KIOSK_SWEEP_SEC`, default 60) selects tenants where the slug prefix AND the
   settings marker AND an elapsed `kiosk_expires_at` all hold, and purges each with
   `purgeTenantRows` -- the function extracted from the GDPR erasure handler, which
   walks every table with a `tenant_id` column from the catalog. No hardcoded list.
4. **No provider keys, ever.** The kiosk tenant has no `llm_provider_configs` row and the
   token cannot create one. LLM calls go to the `cmd/llm-replay` fixture server through
   `LANTERN_LLM_BASEURL_*` (W2-0). The compose overlay sets placeholder
   `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` only because the env fallback needs a non-empty
   value; startup is fatal if either is set without its fixture base URL, so the
   placeholder cannot reach a real provider. The UI labels every answer "replay".
5. **Endpoint gating.** Route registered only when `LANTERN_KIOSK=1`; the handler also
   returns 404 otherwise. The well-known dev admin is not seeded in kiosk mode.
6. **Prod refusal.** `CheckKioskConfig` is fatal when: kiosk is on in
   prod/production/staging without `LANTERN_KIOSK_ALLOW_PROD=1`; `LANTERN_RLS_ENFORCE`
   or `LANTERN_AUTHZ_ENFORCE` is not on; a provider key is set without its fixture URL;
   `JWT_SECRET` is unset.
7. **Abuse limits.** Per-IP sliding window (`LANTERN_KIOSK_IP_PER_HOUR`, default 3, on
   `RemoteAddr`, never `X-Forwarded-For`) and a global live-session cap
   (`LANTERN_KIOSK_MAX_SESSIONS`, default 20 -> 503).

## Consequences

- **LANTERN_ENV deviates from the plan.** The plan had the overlay set
  `LANTERN_ENV=staging`. W2-0 makes the LLM base-URL override fatal in prod-like
  environments (correctly: it would redirect tenant keys). The overlay therefore leaves
  `LANTERN_ENV` unset and the kiosk supplies its own fail-closed guards (6). If a
  prod-like public kiosk is wanted, W2-0 needs an explicit kiosk carve-out.
- The per-IP limiter is in-memory and per process; behind a proxy every visitor shares one
  address, hence the overlay raises the limit for a booth.
- A visitor can still burn compute (runs against the replay server cost nothing, but
  sandbox VMs would): the overlay does not enable the runtime profile.
- Live-LLM kiosk remains an owner spend decision (needs a capped platform key) and is not built.
