-- 0030_batch_and_callbacks.down.sql
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_batch_id_fk;
ALTER TABLE runs DROP COLUMN IF EXISTS batch_id;
ALTER TABLE runs DROP COLUMN IF EXISTS callback_url;
DROP TABLE IF EXISTS batches;
