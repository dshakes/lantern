-- 0004_life_events.up.sql
--
-- Persistence for the bridges' life-event engine: typed inbound classifications
-- (bill / delivery / appointment / fraud_alert / otp / travel / receipt / promo)
-- and their outcomes, plus per-category trust toggles. Backs the dashboard
-- "Automations" feed + per-kind auto/ask/off prefs.
--
-- Both tables are tenant-scoped and carry RLS (ENABLE + FORCE + a
-- tenant_isolation policy referencing app.tenant_id), matching migration 0003's
-- pattern exactly. They are added to the catalog gate-test
-- (internal/db/rls_test.go TestRLSEnforcement_AllTenantTables) in the same change.

CREATE TABLE IF NOT EXISTS life_events (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	tenant_id       uuid NOT NULL,
	kind            text NOT NULL,
	channel         text NOT NULL,
	status          text NOT NULL DEFAULT 'suggested', -- suggested|auto_acted|undone|dismissed|done
	urgency         text,
	summary         text NOT NULL,
	fields          jsonb NOT NULL DEFAULT '{}',
	idempotency_key text,
	action_taken    text,
	source_preview  text,
	created_at      timestamptz DEFAULT now(),
	updated_at      timestamptz DEFAULT now()
);

-- Dedup re-emits of the same classified event (the bridge derives the key from
-- the inbound message identity). Partial unique so rows without a key are free.
CREATE UNIQUE INDEX IF NOT EXISTS life_events_tenant_idem_key
	ON life_events (tenant_id, idempotency_key)
	WHERE idempotency_key IS NOT NULL;

-- Newest-first feed, tenant-scoped.
CREATE INDEX IF NOT EXISTS life_events_tenant_created_at
	ON life_events (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS life_event_prefs (
	tenant_id  uuid NOT NULL,
	kind       text NOT NULL,
	mode       text NOT NULL DEFAULT 'ask', -- auto|ask|off
	updated_at timestamptz DEFAULT now(),
	PRIMARY KEY (tenant_id, kind)
);

-- Grant DML to the non-superuser app role (mirrors the baseline's per-table
-- GRANTs). Without this, RLS-enforced queries on the lantern_app pool fail with
-- "permission denied for table" before the row-level policy is even evaluated.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE life_events TO lantern_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE life_event_prefs TO lantern_app;

-- RLS: enable + force + tenant_isolation policy, byte-for-byte matching 0003.
DO $$
DECLARE
	t text;
	tenant_tables text[] := ARRAY['life_events', 'life_event_prefs'];
BEGIN
	FOREACH t IN ARRAY tenant_tables LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
		EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
		EXECUTE format(
			'CREATE POLICY tenant_isolation ON %I '
			|| 'USING (tenant_id::text = current_setting(''app.tenant_id'', true)) '
			|| 'WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))',
			t
		);
	END LOOP;
END$$;
