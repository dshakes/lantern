-- 0005_commitments.up.sql
--
-- Persistence for the Concierge agent's commitment tracker: tenant-scoped open
-- tasks captured from inbound messages (spouse asks, VIP requests, bills, etc.)
-- with lifecycle states, tier prioritization, and a loop-scan index for the
-- nudge engine.
--
-- Mirrors 0004_life_events.up.sql exactly in RLS posture (ENABLE + FORCE +
-- tenant_isolation policy with both USING and WITH CHECK referencing
-- app.tenant_id) and in the GRANT pattern so the lantern_app role can
-- run DML under RLS enforcement.

CREATE TABLE IF NOT EXISTS commitments (
	id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
	tenant_id        uuid        NOT NULL,
	title            text        NOT NULL,
	source           text        NOT NULL,  -- spouse|self|vip|bill|email|appointment|other
	assigned_by      text,                  -- nullable; who asked (e.g. 'Manu')
	kind             text,                  -- nullable; free-form category (legal, errand, payment, admin)
	status           text        NOT NULL DEFAULT 'open',   -- open|researching|suggested|in_progress|snoozed|done|dismissed
	tier             text        NOT NULL DEFAULT 'meso',   -- nano|micro|meso|macro|mega
	urgency          text        NOT NULL DEFAULT 'normal', -- now|soon|normal|fyi
	deadline         timestamptz,
	action_plan      jsonb,                 -- nullable; cited step plan (filled in stage 2)
	next_nudge_at    timestamptz,           -- nullable; when the loop should next surface this
	idempotency_key  text,                  -- nullable; dedup re-captured tasks
	source_preview   text,                  -- nullable; short snippet of the originating message
	created_at       timestamptz NOT NULL DEFAULT now(),
	updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Dedup re-captures of the same task (key derived from inbound message identity).
-- Partial unique so rows without a key are free to coexist.
CREATE UNIQUE INDEX IF NOT EXISTS commitments_tenant_idem_key
	ON commitments (tenant_id, idempotency_key)
	WHERE idempotency_key IS NOT NULL;

-- Loop-scan index: the nudge engine queries open/snoozed rows by next_nudge_at.
CREATE INDEX IF NOT EXISTS commitments_tenant_status_nudge
	ON commitments (tenant_id, status, next_nudge_at);

-- Grant DML to the non-superuser app role. Without this, RLS-enforced queries on
-- the lantern_app pool fail with "permission denied" before the row-level policy
-- is even evaluated.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE commitments TO lantern_app;

-- RLS: enable + force + tenant_isolation policy, byte-for-byte matching 0003/0004.
DO $$
BEGIN
	EXECUTE 'ALTER TABLE commitments ENABLE ROW LEVEL SECURITY';
	EXECUTE 'ALTER TABLE commitments FORCE ROW LEVEL SECURITY';
	EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON commitments';
	EXECUTE
		'CREATE POLICY tenant_isolation ON commitments '
		|| 'USING (tenant_id::text = current_setting(''app.tenant_id'', true)) '
		|| 'WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))';
END$$;
