-- 0012_immigration_deadlines.up.sql
--
-- Persistence for the USCIS / Immigration Deadline Sentinel (Phase 3).
-- Each row is one DERIVED deadline: a (family-member, doc-type, date) triple
-- the LLM inferred from local immigration PDFs + incoming USCIS/attorney mail.
--
-- Rows are upserted on (tenant_id, who, doc_type, deadline) so a re-scan
-- updates basis/confidence/source_refs rather than accumulating duplicates.
-- RLS-enforced: tenant_isolation policy mirrors the pattern in 0003 / 0004.

CREATE TABLE IF NOT EXISTS immigration_deadlines (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    who         TEXT        NOT NULL,        -- family member name
    doc_type    TEXT        NOT NULL,        -- "EAD", "AP", "I-485 pending", etc.
    deadline    DATE        NOT NULL,        -- derived expiry / response-by date
    basis       TEXT        NOT NULL,        -- one-sentence rationale from LLM
    source_refs JSONB       NOT NULL DEFAULT '[]', -- doc paths / email subjects used
    confidence  REAL        NOT NULL DEFAULT 0.0 CHECK (confidence >= 0 AND confidence <= 1),
    scan_id     UUID        NOT NULL,        -- groups results from one scan
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup index: same (tenant, person, document, date) → one row.
CREATE UNIQUE INDEX IF NOT EXISTS immigration_deadlines_dedup_idx
    ON immigration_deadlines (tenant_id, who, doc_type, deadline);

-- Fast lookup of upcoming deadlines for a tenant.
CREATE INDEX IF NOT EXISTS immigration_deadlines_tenant_deadline_idx
    ON immigration_deadlines (tenant_id, deadline);

ALTER TABLE immigration_deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE immigration_deadlines FORCE ROW LEVEL SECURITY;

DO $$BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'immigration_deadlines'
          AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON immigration_deadlines
            USING      (tenant_id::text = current_setting('app.tenant_id', true))
            WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
    END IF;
END$$;

-- Grant DML to the restricted app role so RLS-enforced queries can read/write
-- (the privileged lantern superuser pool bypasses RLS and needs no extra
-- GRANTs). Without this, RLS-enforced queries on the lantern_app pool fail
-- with "permission denied" before the row-level policy even runs.
DO $$BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_name  = 'immigration_deadlines'
          AND grantee       = 'lantern_app'
          AND privilege_type = 'SELECT'
    ) THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON immigration_deadlines TO lantern_app;
    END IF;
END$$;
