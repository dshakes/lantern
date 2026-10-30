# ADR 0049 — Stripe billing: plans, subscriptions, dunning, usage export

- Status: Accepted
- Date: 2026-10-30
- Scope: control-plane (`internal/billing`, `internal/handlers/billing.go`, migration 0035), dashboard Settings → Billing

## Context

PAL meters usage (`agent_usage_daily`, written by `RecordUsage` on every run and
LLM call) and enforces limits (`agent_budgets`, `runtime_quotas`), but nobody can
pay for it. GA-AUDIT #9 lists "no payment integration" as a GA blocker for both
products. The `services/billing` service has gRPC metering tables
(`usage_events`, `aggregations`) but nothing writes to them today; the live
rollup is `agent_usage_daily` in the control-plane.

## Decision

Build the Stripe integration **in the control-plane**, behind configuration.

1. **Where.** The control-plane owns tenants, users, JWT/API-key auth, the RLS
   harness, and both enforcement tables. Putting payments in `services/billing`
   would need a new authenticated hop and a second writer to `agent_budgets` /
   `runtime_quotas`. `services/billing` stays the gRPC metering surface (ADR
   0013); its rollups can feed the meter export later without changing the
   Stripe side.
2. **Off by default.** No `PAL_STRIPE_SECRET_KEY` → `GET /v1/billing` reports
   `{enabled:false}` with the plan catalog, checkout/portal/webhook answer 404
   `billing_disabled`, and the billing loop never starts. Existing deployments
   behave exactly as before.
3. **Plans are data.** `billing_plans` (free / pro / team / enterprise, seeded
   `ON CONFLICT DO NOTHING`) holds price, Stripe price ids, metered price ids
   and limits. Operators edit rows, not code. `PAL_STRIPE_PLAN_PRICES` can
   override a plan's Stripe price id per deployment.
4. **Enforcement is reused, not added.** A plan's limits are written to the
   tenant-wide `agent_budgets` row (`agent_name='*'`, already enforced by
   `CheckTenantBudget`) and to `runtime_quotas` (already enforced by the quota
   gate). A NULL budget cap means no cap; a NULL `max_concurrent_vms` leaves
   `runtime_quotas` operator-managed. Billing takes ownership of a tenant's
   limits only after its first subscription event; until then nothing an
   operator configured is touched.
5. **Webhook.** `POST /v1/billing/webhook` verifies `Stripe-Signature`
   (HMAC-SHA256 over `t.payload`, constant-time, 5-minute tolerance, rotated
   secrets supported) and fails closed when `PAL_STRIPE_WEBHOOK_SECRET` is unset
   (the control-plane refuses to start that way in prod). Idempotency: the
   event id is inserted into `billing_webhook_events` in the **same tenant
   transaction** as the state change, so a duplicate is a no-op and a crash
   mid-way redelivers cleanly. Handled: `checkout.session.completed`,
   `customer.subscription.created|updated|deleted`, `invoice.paid`,
   `invoice.payment_failed`. Updates and deletes of a superseded subscription
   are ignored; subscription events older than the last applied one are
   recorded but not applied.
6. **Tenant resolution.** By Stripe customer id (stored at checkout), else by
   the `pal_tenant_id` PAL stamped on the session/subscription metadata — only
   trusted because the payload is signed, and only adopted when that tenant has
   no different customer on file. Unknown customers are acknowledged and
   ignored.
7. **Dunning, never deletion.** `invoice.payment_failed` starts a grace window
   (`PAL_BILLING_GRACE_DAYS`, default 7; a repeat failure never extends it).
   The hourly sweep moves tenants whose grace expired onto **free limits** and
   records `downgraded_at`; `plan_id` is kept. `invoice.paid` clears dunning and
   restores the paid plan's limits. Cancellation goes to free limits. No agent,
   run, or usage row is ever removed by billing.
8. **Usage export.** Settled days of `agent_usage_daily` (strictly before
   yesterday, so late reconciliations land; within Stripe's 35-day window;
   never before `metering_since`, the first active day) are pushed as Stripe
   meter events (`pal_tokens`, `pal_runs`; renamable) — only for plans that
   carry metered price ids. Each `(tenant, meter, day)` has one
   `billing_meter_exports` row claimed with `INSERT … ON CONFLICT … WHERE status
   <> 'sent' AND claimed_at < now() - 10 min`, so replicas cannot double-send,
   and one idempotency key (`pal-meter:<tenant>:<meter>:<day>`) used both as
   Stripe's `identifier` and the `Idempotency-Key` header on every attempt.
9. **Tenancy.** `billing_accounts` and `billing_meter_exports` are under RLS
   (ENABLE + FORCE + `tenant_isolation`, in the catalog gate).
   `billing_plans` (global catalog) and `billing_webhook_events` (global
   dedup, checked before a tenant is known) are in the exempt set with the
   reason written down. Cross-tenant reads (webhook tenant resolution, the
   sweep/export discovery queries) carry `rls-exempt:` comments; every write
   runs under `WithTenantConn` on the restricted pool.
10. **Secrets.** `PAL_STRIPE_SECRET_KEY` and `PAL_STRIPE_WEBHOOK_SECRET` are read
    from env, sent only as the `Authorization` header / used only for HMAC, and
    never logged; Stripe errors are logged by status/type/code only
    (invariant #10).

## Consequences

- Turning billing on is three env vars plus Stripe price ids on the plan rows
  (or `PAL_STRIPE_PLAN_PRICES`) and, for usage pricing, meters named
  `pal_tokens` / `pal_runs` in the Stripe account.
- Once a tenant has subscribed, its tenant-wide budget and runtime quota are
  billing-managed: manual edits are overwritten on the next plan transition.
- The checkout/portal pages are Stripe-hosted; PAL never handles card data.
- Tests use an in-process fake Stripe (`httptest`); no network. The DB tests run
  under the enforced-RLS harness.

## Alternatives considered

- **Payments in `services/billing`.** Rejected for now: a second writer to the
  enforcement tables and a new auth surface, for no isolation gain.
- **Stripe SDK (`stripe-go`).** Rejected: four endpoints and an HMAC check do
  not justify a large dependency with its own API-version pinning; the client
  here is ~200 lines and fully tested.
- **Delete or suspend data on non-payment.** Rejected: downgrade to free limits
  is reversible and keeps the owner's work intact.
