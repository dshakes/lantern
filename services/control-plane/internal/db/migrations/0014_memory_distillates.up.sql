-- 0014_memory_distillates.up.sql
--
-- LLM-distilled long-term memory.  The immigration_sentinel stores raw
-- DERIVED deadlines; this table stores DURABLE facts, preferences, and
-- relationship notes that the distillation loop extracts from session
-- transcripts and the memory_events timeline.
--
-- Each row is one durable "memory item" the LLM decided is worth keeping
-- long-term.  Newer distillations for the same (tenant, person, topic)
-- supersede older ones: the old row gets its superseded_by set to the new
-- row's id, so the active view is always "WHERE superseded_by IS NULL".
--
-- person_id is nullable: NULL = owner-global fact; non-NULL = fact about
-- a specific person in the people graph.
--
-- RLS: same ENABLE + FORCE + tenant_isolation policy as migration 0012.

-- Drop the self-referential FK on superseded_by if it was created by an earlier
-- draft of this migration (before the FK was intentionally removed). Idempotent:
-- the outer IF guards against "relation does not exist" on a fresh DB.
DO $$BEGIN
    IF to_regclass('public.memory_distillates') IS NOT NULL THEN
        ALTER TABLE memory_distillates DROP CONSTRAINT IF EXISTS memory_distillates_superseded_by_fkey;
    END IF;
END$$;

CREATE TABLE IF NOT EXISTS memory_distillates (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    person_id      UUID        REFERENCES people(id) ON DELETE SET NULL,
    topic          TEXT        NOT NULL,
    content        TEXT        NOT NULL,
    confidence     REAL        NOT NULL DEFAULT 0.0
                               CHECK (confidence >= 0 AND confidence <= 1),
    source_kind    TEXT        NOT NULL DEFAULT 'events'
                               CHECK (source_kind IN ('session', 'run', 'events')),
    source_ref     TEXT        NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- ponytail: no FK here — superseded_by is a bare audit pointer; we
    -- pre-generate the new row's UUID and write it into the old row BEFORE
    -- inserting the new row, so an FK would fail mid-transaction.
    superseded_by  UUID
);

-- Fast active-row lookup.
CREATE INDEX IF NOT EXISTS memory_distillates_tenant_active_idx
    ON memory_distillates (tenant_id, updated_at DESC)
    WHERE superseded_by IS NULL;

-- Dedup indexes: only one ACTIVE row per (tenant, person, topic).
-- Nullable person_id requires two partial indexes (NULLs are not equal
-- to each other in a regular unique index).

-- owner-global distillates (person_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS memory_distillates_active_global_idx
    ON memory_distillates (tenant_id, topic)
    WHERE superseded_by IS NULL AND person_id IS NULL;

-- per-person distillates
CREATE UNIQUE INDEX IF NOT EXISTS memory_distillates_active_person_idx
    ON memory_distillates (tenant_id, person_id, topic)
    WHERE superseded_by IS NULL AND person_id IS NOT NULL;

ALTER TABLE memory_distillates ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_distillates FORCE ROW LEVEL SECURITY;

DO $$BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'memory_distillates'
          AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON memory_distillates
            USING      (tenant_id::text = current_setting('app.tenant_id', true))
            WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
    END IF;
END$$;

DO $$BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_name   = 'memory_distillates'
          AND grantee      = 'lantern_app'
          AND privilege_type = 'SELECT'
    ) THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON memory_distillates TO lantern_app;
    END IF;
END$$;
