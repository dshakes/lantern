-- 0015_memory_distillates_drop_superseded_fk.up.sql
--
-- Drop the self-referential FK on memory_distillates.superseded_by.
--
-- The FK was present in the first draft of migration 0014 but removed by
-- design: we pre-generate the new row's UUID and write it into the old row
-- BEFORE inserting the new row, which would cause the FK check to fire
-- mid-transaction.  superseded_by is a bare audit pointer (the chain of
-- provenance), not a relational join — DB-level enforcement is unnecessary.
--
-- Idempotent: IF EXISTS makes this safe on DBs that never had the FK.

ALTER TABLE memory_distillates
    DROP CONSTRAINT IF EXISTS memory_distillates_superseded_by_fkey;
