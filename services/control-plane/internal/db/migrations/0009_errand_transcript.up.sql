-- 0009_errand_transcript.up.sql
--
-- Adds per-call conversation state to the errands table.
--
-- transcript — JSON array of {role, text} turns accumulated by the
--   ErrandTurn webhook handler (<Gather input="speech"> loop).
-- turns      — count of assistant turns taken; hard-capped at
--   errandMaxTurns (Go-side) so no single call runs forever.
--
-- Both columns carry safe defaults; the migration is non-destructive and
-- safe for in-flight 'placed' calls.  ADD COLUMN IF NOT EXISTS makes it
-- re-runnable (idempotent).

ALTER TABLE errands
    ADD COLUMN IF NOT EXISTS transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS turns      int  NOT NULL DEFAULT 0;
