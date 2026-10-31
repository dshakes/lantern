-- 0035: Stripe billing (ADR 0049).
--
-- Four tables. Two are tenant-scoped and under RLS; two are deliberately
-- cross-tenant and carry the reason inline (they join the exempt set in
-- internal/db/rls_test.go).
--
--   billing_plans          global plan catalog (data, not code). Exempt: one
--                          row per plan, shared by every tenant, like
--                          mcp_servers.
--   billing_accounts       one row per tenant: Stripe customer/subscription,
--                          plan, status and dunning clock. RLS.
--   billing_webhook_events Stripe event-id ledger for idempotent webhook
--                          processing. Exempt: dedup is global by Stripe
--                          event id and is checked before a tenant is known.
--   billing_meter_exports  one row per (tenant, meter, period) pushed to
--                          Stripe meter events; the idempotency record. RLS.
--
-- Nothing here deletes tenant data. Dunning downgrades limits; it never
-- removes agents, runs, or usage.

CREATE TABLE IF NOT EXISTS billing_plans (
	id                        TEXT PRIMARY KEY,
	name                      TEXT NOT NULL,
	description               TEXT NOT NULL DEFAULT '',
	monthly_price_cents       INTEGER,            -- NULL = custom pricing (contact sales)
	self_serve                BOOLEAN NOT NULL DEFAULT true,
	stripe_price_id           TEXT,               -- flat recurring price; set per deployment
	stripe_metered_price_ids  TEXT[] NOT NULL DEFAULT '{}', -- usage prices attached to meters
	-- Limits applied to agent_budgets (tenant-wide '*' row). NULL = no cap.
	max_cost_usd_per_day      NUMERIC(12,4),
	budget_hard_fail          BOOLEAN NOT NULL DEFAULT true,
	-- Limits applied to runtime_quotas. NULL max_concurrent_vms = leave the
	-- tenant's runtime_quotas row untouched (operator-managed).
	max_concurrent_vms        INTEGER,
	max_compute_hours_per_day NUMERIC(10,2),
	max_egress_gb_per_day     INTEGER,
	runtime_max_cost_usd_per_day NUMERIC(12,4),
	features                  JSONB NOT NULL DEFAULT '[]'::jsonb,
	sort_order                INTEGER NOT NULL DEFAULT 0,
	is_public                 BOOLEAN NOT NULL DEFAULT true,
	updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default catalog. ON CONFLICT DO NOTHING: operators edit these rows (prices,
-- limits, Stripe price ids) and a re-run must never overwrite their edits.
INSERT INTO billing_plans (id, name, description, monthly_price_cents, self_serve,
	max_cost_usd_per_day, budget_hard_fail, max_concurrent_vms, max_compute_hours_per_day,
	max_egress_gb_per_day, runtime_max_cost_usd_per_day, features, sort_order)
VALUES
	('free', 'Free', 'Try PAL on a small workload.', 0, true,
	 1.00, true, 2, 1.00, 1, 1.00,
	 '["Community support"]'::jsonb, 0),
	('pro', 'Pro', 'For individuals running agents daily.', 2900, true,
	 25.00, true, 10, 10.00, 5, 10.00,
	 '["Usage-based overage","Email support"]'::jsonb, 10),
	('team', 'Team', 'For teams shipping agents to production.', 9900, true,
	 150.00, true, 50, 50.00, 25, 50.00,
	 '["Usage-based overage","Priority support"]'::jsonb, 20),
	('enterprise', 'Enterprise', 'Custom limits, SSO, and a dedicated data plane.', NULL, false,
	 NULL, false, NULL, NULL, NULL, NULL,
	 '["Custom limits","Customer-cloud data plane","SSO + audit export","Dedicated support"]'::jsonb, 30)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS billing_accounts (
	tenant_id               UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
	stripe_customer_id      TEXT UNIQUE,
	stripe_subscription_id  TEXT,
	plan_id                 TEXT NOT NULL DEFAULT 'free' REFERENCES billing_plans(id),
	-- Mirrors the Stripe subscription status, plus 'none' before any subscription.
	status                  TEXT NOT NULL DEFAULT 'none',
	current_period_end      TIMESTAMPTZ,
	payment_failed_at       TIMESTAMPTZ,
	grace_until             TIMESTAMPTZ,
	-- Set when dunning (or cancellation) moved the tenant onto free limits.
	-- Cleared when a payment succeeds and paid limits are restored.
	downgraded_at           TIMESTAMPTZ,
	-- Plan whose limits were last written to agent_budgets/runtime_quotas.
	applied_plan_id         TEXT REFERENCES billing_plans(id),
	-- First day usage is exported to Stripe meters (set when a subscription
	-- first becomes active), so usage from before subscribing is never billed.
	metering_since          DATE,
	-- Stripe event.created of the last subscription event applied; older
	-- (out-of-order) subscription events are recorded but not applied.
	last_subscription_event_at TIMESTAMPTZ,
	created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_accounts_grace_idx
	ON billing_accounts (grace_until) WHERE grace_until IS NOT NULL AND downgraded_at IS NULL;

CREATE TABLE IF NOT EXISTS billing_webhook_events (
	event_id      TEXT PRIMARY KEY,
	event_type    TEXT NOT NULL,
	tenant_id     UUID,
	received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_meter_exports (
	tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	meter            TEXT NOT NULL,
	period_start     DATE NOT NULL,
	value            BIGINT NOT NULL DEFAULT 0,
	idempotency_key  TEXT NOT NULL,
	status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
	attempts         INTEGER NOT NULL DEFAULT 0,
	last_error       TEXT,
	claimed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	exported_at      TIMESTAMPTZ,
	PRIMARY KEY (tenant_id, meter, period_start)
);

-- Tenant isolation (invariant #7), same shape as 0003/0028.
ALTER TABLE billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing_accounts;
CREATE POLICY tenant_isolation ON billing_accounts
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE billing_meter_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_meter_exports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing_meter_exports;
CREATE POLICY tenant_isolation ON billing_meter_exports
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT ON billing_plans TO pal_app;
GRANT SELECT, INSERT, UPDATE ON billing_accounts TO pal_app;
GRANT SELECT, INSERT ON billing_webhook_events TO pal_app;
GRANT SELECT, INSERT, UPDATE ON billing_meter_exports TO pal_app;
