-- 0009_errand_transcript.down.sql
ALTER TABLE errands
    DROP COLUMN IF EXISTS transcript,
    DROP COLUMN IF EXISTS turns;
