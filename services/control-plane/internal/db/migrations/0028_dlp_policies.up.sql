-- 0028: DLP policy table for egress data-loss-prevention rules (ADR 0030).
--
-- dlp_policies: one row per (tenant_id, rule_id). A tenant's full policy is the
-- ordered set of rows for that tenant. The manager compiles these at spawn time
-- (shipped in AgentSpec.dlp_policy via the scheduler) and applies them to every
-- inspectable egress request on TLS-terminated injecting hosts and plain-HTTP
-- allowlisted hosts; opaque CONNECT tunnels are never inspected.
--
-- Detectors: card_number | secret_key | email | phone | custom_regex
-- Modes:     off | audit | block
CREATE TABLE IF NOT EXISTS dlp_policies (
	tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	rule_id     TEXT NOT NULL,
	detector    TEXT NOT NULL CHECK (detector IN ('card_number','secret_key','email','phone','custom_regex')),
	pattern     TEXT NOT NULL DEFAULT '',
	mode        TEXT NOT NULL CHECK (mode IN ('off','audit','block')),
	threshold   INTEGER NOT NULL DEFAULT 1,
	created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, rule_id)
);

CREATE INDEX IF NOT EXISTS dlp_policies_tenant_idx ON dlp_policies (tenant_id);

-- Tenant isolation (invariant #7), same shape as 0003/0027.
ALTER TABLE dlp_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlp_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dlp_policies;
CREATE POLICY tenant_isolation ON dlp_policies
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON dlp_policies TO pal_app;
