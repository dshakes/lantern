-- 0007_domain_records.up.sql
--
-- Foundation for domain-tracker loop agents (health / vehicle / career).
-- Two changes:
--   1. Extend gmail_poll_cursors to support per-domain cursors (adding a
--      `domain` column and migrating the PK to (tenant_id, domain)), so each
--      domain-tracker instance advances its own high-water mark independently
--      from the inbox_autopilot's 'inbox' cursor.
--   2. Create domain_records — an encrypted PII store for structured records
--      extracted from email (medications, appointments, service history, …).
--
-- RLS posture mirrors 0004–0006 exactly: ENABLE + FORCE + tenant_isolation
-- policy with USING and WITH CHECK, plus GRANT to lantern_app.

-- Part 1: extend gmail_poll_cursors with a domain dimension.
-- Existing inbox_autopilot rows get domain = 'inbox' via the DEFAULT so the
-- existing cursor values survive the migration without data loss.
ALTER TABLE gmail_poll_cursors
    ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT 'inbox';

-- Migrate the primary key: drop the old single-column PK and replace with a
-- composite key. Existing data is preserved; each (tenant, 'inbox') pair
-- becomes one composite PK row.
ALTER TABLE gmail_poll_cursors DROP CONSTRAINT IF EXISTS gmail_poll_cursors_pkey;
ALTER TABLE gmail_poll_cursors ADD PRIMARY KEY (tenant_id, domain);

-- Part 2: domain_records — structured records with encrypted PII fields.
CREATE TABLE IF NOT EXISTS domain_records (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid        NOT NULL,
    domain            text        NOT NULL,  -- health|vehicle|career
    kind              text        NOT NULL,  -- medication|appointment|lab_result|service|policy|application|…
    title             text        NOT NULL,
    fields_encrypted  text,                  -- AES-256-GCM ciphertext of a JSON object (PII); NULL when no structured fields
    source            text,                  -- gmail|file|web|manual
    source_ref        text,                  -- e.g. Gmail message ID used for dedup
    valid_until       timestamptz,           -- renewal/expiry date (nullable)
    idempotency_key   text,                  -- nullable; dedup across re-extractions
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Dedup guard: same record never upserted twice from the same source.
CREATE UNIQUE INDEX IF NOT EXISTS domain_records_tenant_idem_key
    ON domain_records (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Sweep index: list records by domain + upcoming expiry.
CREATE INDEX IF NOT EXISTS domain_records_tenant_domain_valid
    ON domain_records (tenant_id, domain, valid_until);

-- Grant DML to the non-superuser app role (same as 0005/0006).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE domain_records TO lantern_app;

DO $$
BEGIN
    EXECUTE 'ALTER TABLE domain_records ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE domain_records FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON domain_records';
    EXECUTE
        'CREATE POLICY tenant_isolation ON domain_records '
        || 'USING (tenant_id::text = current_setting(''app.tenant_id'', true)) '
        || 'WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))';
END$$;
