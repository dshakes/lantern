-- ADR 0054: environments, approval, canary and rollback for agents.
-- Reuses agent_versions (immutable), agent_experiments (canary split) and
-- eval_runs/eval_baselines (gates). New tables only hold the promotion state
-- machine and an append-only audit trail.

-- Only server-run (hermetic) eval rows count as promotion evidence; a client
-- that POSTs /v1/eval-runs with a self-reported agent_version must not be able
-- to forge a green gate.
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'client';

CREATE TABLE IF NOT EXISTS agent_environments (
	tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	agent_name           TEXT NOT NULL,
	env                  TEXT NOT NULL CHECK (env IN ('sandbox','staging','prod')),
	version              TEXT NOT NULL,
	previous_version     TEXT,
	status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','canary')),
	canary_experiment_id UUID REFERENCES agent_experiments(id) ON DELETE SET NULL,
	promotion_id         UUID,
	last_sandbox_run     JSONB,
	updated_by           TEXT,
	updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, agent_name, env)
);

CREATE TABLE IF NOT EXISTS agent_promotions (
	id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	agent_name         TEXT NOT NULL,
	env                TEXT NOT NULL CHECK (env IN ('sandbox','staging','prod')),
	version            TEXT NOT NULL,
	from_version       TEXT,
	status             TEXT NOT NULL CHECK (status IN
		('pending_approval','rejected','canary','promoted','rolled_back')),
	canary_pct         INTEGER NOT NULL DEFAULT 0 CHECK (canary_pct BETWEEN 0 AND 99),
	guards             JSONB NOT NULL DEFAULT '{}'::jsonb,
	gate_report        JSONB NOT NULL DEFAULT '[]'::jsonb,
	requested_by       TEXT NOT NULL,
	requested_by_kind  TEXT NOT NULL CHECK (requested_by_kind IN ('human','agent','system')),
	approver           TEXT,
	approved_at        TIMESTAMPTZ,
	decision_note      TEXT,
	created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
	completed_at       TIMESTAMPTZ
);

-- At most one in-flight promotion per (agent, env): a second request while one
-- is pending or in canary is a conflict, not a race.
CREATE UNIQUE INDEX IF NOT EXISTS agent_promotions_open_idx
	ON agent_promotions (tenant_id, agent_name, env)
	WHERE status IN ('pending_approval','canary');
CREATE INDEX IF NOT EXISTS agent_promotions_agent_idx
	ON agent_promotions (tenant_id, agent_name, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_promotion_audit (
	id           BIGSERIAL PRIMARY KEY,
	tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	agent_name   TEXT NOT NULL,
	env          TEXT NOT NULL,
	promotion_id UUID,
	action       TEXT NOT NULL,
	actor        TEXT NOT NULL,
	actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('human','agent','system')),
	detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_promotion_audit_agent_idx
	ON agent_promotion_audit (tenant_id, agent_name, id DESC);

-- Append-only: UPDATE/DELETE are refused. The one sanctioned exception is
-- GDPR tenant erasure, which sets the transaction-local pal.erasure flag
-- (gdpr.go purgeTenantRows) and runs on the privileged pool.
CREATE OR REPLACE FUNCTION agent_promotion_audit_immutable() RETURNS trigger AS $$
BEGIN
	IF current_setting('pal.erasure', true) = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'agent_promotion_audit is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_promotion_audit_immutable ON agent_promotion_audit;
CREATE TRIGGER agent_promotion_audit_immutable
	BEFORE UPDATE OR DELETE ON agent_promotion_audit
	FOR EACH ROW EXECUTE FUNCTION agent_promotion_audit_immutable();

-- Tenant isolation (invariant #7), same shape as 0003/0028/0035.
ALTER TABLE agent_environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_environments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_environments;
CREATE POLICY tenant_isolation ON agent_environments
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE agent_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_promotions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_promotions;
CREATE POLICY tenant_isolation ON agent_promotions
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE agent_promotion_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_promotion_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_promotion_audit;
CREATE POLICY tenant_isolation ON agent_promotion_audit
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON agent_environments TO pal_app;
GRANT SELECT, INSERT, UPDATE ON agent_promotions TO pal_app;
GRANT SELECT, INSERT ON agent_promotion_audit TO pal_app;
GRANT USAGE, SELECT ON SEQUENCE agent_promotion_audit_id_seq TO pal_app;
