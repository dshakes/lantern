-- 0024: inbound webhook triggers (ADR 0028).
--
-- agent_triggers: one public endpoint (POST /v1/hooks/{id}) bound to one agent.
-- secret_enc is an internal/secrets envelope (AES-256-GCM when
-- PAL_CREDENTIAL_KEY is set) — never logged, never returned by list/get.
--
-- agent_trigger_deliveries: the idempotency ledger. A delivery is unique per
-- trigger on BOTH the provider delivery id and a hash of the signed bytes, so a
-- redelivery and a replay with a forged delivery id each map to the first run.
CREATE TABLE IF NOT EXISTS agent_triggers (
	id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	agent_name     TEXT NOT NULL,
	provider       TEXT NOT NULL CHECK (provider IN ('generic', 'github', 'sentry', 'pagerduty')),
	secret_enc     JSONB NOT NULL,
	input_template JSONB,
	enabled        BOOLEAN NOT NULL DEFAULT true,
	last_delivery_at TIMESTAMPTZ,
	created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_triggers_tenant_agent_idx
	ON agent_triggers (tenant_id, agent_name);

CREATE TABLE IF NOT EXISTS agent_trigger_deliveries (
	tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	trigger_id  UUID NOT NULL REFERENCES agent_triggers(id) ON DELETE CASCADE,
	delivery_id TEXT NOT NULL,
	replay_key  TEXT NOT NULL,
	run_id      UUID,
	created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (trigger_id, delivery_id),
	UNIQUE (trigger_id, replay_key)
);

-- Tenant isolation (invariant #7), same shape as 0003/0020.
ALTER TABLE agent_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_triggers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_triggers;
CREATE POLICY tenant_isolation ON agent_triggers
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE agent_trigger_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_trigger_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_trigger_deliveries;
CREATE POLICY tenant_isolation ON agent_trigger_deliveries
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_triggers TO pal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_trigger_deliveries TO pal_app;
