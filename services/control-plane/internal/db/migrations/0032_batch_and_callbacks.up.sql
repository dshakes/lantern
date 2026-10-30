-- 0032_batch_and_callbacks.up.sql
-- Async completion callbacks (gap #2) + batch invocation (gap #3).
-- ADR 0033.

-- Callback URL on runs: caller may supply an https endpoint that receives a
-- signed POST when the run reaches a terminal status.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS callback_url TEXT;

-- batch_id: links a run to the batch that created it (NULL for standalone runs).
-- Declared before batches to avoid the FK deferral ordering concern; the FK
-- is added after the batches table is created.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS batch_id UUID;

-- Per-run idempotency key: when POST /v1/runs (or spawnBatchRun) sets an
-- Idempotency-Key header, the key is stored here and consulted on replay to
-- return the existing run instead of creating a duplicate (ADR 0033).
-- The unique index enforces at-most-once creation per (tenant, key) pair.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS runs_tenant_idem
    ON runs (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Batches: a named collection of up to PAL_BATCH_MAX_ITEMS parallel runs
-- against one agent, dispatched with optional concurrency throttling.
CREATE TABLE IF NOT EXISTS batches (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_name      TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running','succeeded','failed','cancelled')),
    total_count     INT         NOT NULL DEFAULT 0,
    pending_count   INT         NOT NULL DEFAULT 0,
    running_count   INT         NOT NULL DEFAULT 0,
    succeeded_count INT         NOT NULL DEFAULT 0,
    failed_count    INT         NOT NULL DEFAULT 0,
    cancelled_count INT         NOT NULL DEFAULT 0,
    cost_usd        NUMERIC(12,8) NOT NULL DEFAULT 0,
    callback_url    TEXT,
    concurrency     INT         NOT NULL DEFAULT 0,  -- 0 = unlimited within child budgets
    idempotency_key TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS batches_tenant_idem
    ON batches (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_batches ON batches
    USING  (tenant_id::text = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE runs ADD CONSTRAINT runs_batch_id_fk
    FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL;

-- Grant the non-superuser app role access so RLS-enforced queries work.
-- Without this, BatchHandler queries over srv.TenantPool() fail with
-- "permission denied for table batches" under PAL_RLS_ENFORCE=1.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE batches TO lantern_app;
