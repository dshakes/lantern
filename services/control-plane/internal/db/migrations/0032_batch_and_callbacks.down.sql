-- 0032_batch_and_callbacks.down.sql
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_batch_id_fk;
DROP INDEX IF EXISTS runs_tenant_idem;
ALTER TABLE runs DROP COLUMN IF EXISTS idempotency_key;
ALTER TABLE runs DROP COLUMN IF EXISTS batch_id;
ALTER TABLE runs DROP COLUMN IF EXISTS callback_url;
DROP TABLE IF EXISTS batches;
