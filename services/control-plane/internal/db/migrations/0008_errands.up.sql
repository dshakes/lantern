-- 0008_errands.up.sql
--
-- Errand-runner v1: owner-confirmed outbound AI calls.
--
-- LEGAL / COMPLIANCE: every placed call MUST open with the AI-disclosure
-- + recording-consent preamble (stored in disclosure_script).  The
-- confirm-and-call path is the SOLE dial path; it is owner-only and
-- atomically claims the row to prevent double-dial.
--
-- Two tables:
--   errands     — proposed / placed / completed call records, tenant-scoped.
--   dnc_numbers — per-tenant Do-Not-Call list; any number here is refused.
--
-- RLS posture mirrors 0005–0007 exactly (ENABLE + FORCE + tenant_isolation
-- policy with USING and WITH CHECK, plus GRANT to lantern_app).

CREATE TABLE IF NOT EXISTS errands (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid        NOT NULL,
    callee_number      text        NOT NULL,   -- E.164 destination
    callee_name        text        NOT NULL DEFAULT '',
    goal               text        NOT NULL,   -- what the errand is about
    status             text        NOT NULL DEFAULT 'proposed',
    -- proposed | placed | completed | failed | cancelled
    disclosure_script  text        NOT NULL DEFAULT '',
    -- exact AI-disclosure text; set at propose-time so owner can preview
    provider_call_id   text,                   -- Twilio CallSid once placed
    idempotency_key    text,                   -- per-errand call dedup
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Status+time index for list queries.
CREATE INDEX IF NOT EXISTS errands_tenant_status
    ON errands (tenant_id, status, created_at DESC);

-- Idempotency dedup: same (tenant, key) never stored twice.
CREATE UNIQUE INDEX IF NOT EXISTS errands_tenant_idem_key
    ON errands (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE errands TO lantern_app;

DO $$
BEGIN
    EXECUTE 'ALTER TABLE errands ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE errands FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON errands';
    EXECUTE
        'CREATE POLICY tenant_isolation ON errands '
        || 'USING (tenant_id::text = current_setting(''app.tenant_id'', true)) '
        || 'WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))';
END$$;

-- DNC list: refuse to dial any number listed here.
CREATE TABLE IF NOT EXISTS dnc_numbers (
    tenant_id  uuid        NOT NULL,
    number     text        NOT NULL,
    reason     text        NOT NULL DEFAULT '',
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, number)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE dnc_numbers TO lantern_app;

DO $$
BEGIN
    EXECUTE 'ALTER TABLE dnc_numbers ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE dnc_numbers FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON dnc_numbers';
    EXECUTE
        'CREATE POLICY tenant_isolation ON dnc_numbers '
        || 'USING (tenant_id::text = current_setting(''app.tenant_id'', true)) '
        || 'WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))';
END$$;
