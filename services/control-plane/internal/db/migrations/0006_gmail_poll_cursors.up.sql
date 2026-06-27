-- 0006_gmail_poll_cursors.up.sql
--
-- Per-tenant high-water mark for the inbox_autopilot loop agent.
-- Stores the Gmail internalDate (ms-since-epoch string) of the most-recently
-- processed message so successive polls skip already-seen messages.
--
-- RLS posture mirrors 0004/0005 exactly: ENABLE + FORCE + tenant_isolation
-- policy with both USING and WITH CHECK, plus a GRANT to lantern_app.

CREATE TABLE IF NOT EXISTS gmail_poll_cursors (
	tenant_id           uuid        PRIMARY KEY,
	last_internal_date  text,                           -- Gmail internalDate of last processed msg
	last_checked_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE gmail_poll_cursors TO lantern_app;

DO $$
BEGIN
	EXECUTE 'ALTER TABLE gmail_poll_cursors ENABLE ROW LEVEL SECURITY';
	EXECUTE 'ALTER TABLE gmail_poll_cursors FORCE ROW LEVEL SECURITY';
	EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON gmail_poll_cursors';
	EXECUTE
		'CREATE POLICY tenant_isolation ON gmail_poll_cursors '
		|| 'USING (tenant_id::text = current_setting(''app.tenant_id'', true)) '
		|| 'WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))';
END$$;
