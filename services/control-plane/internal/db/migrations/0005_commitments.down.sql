-- 0005_commitments.down.sql
--
-- Reverse 0005: drop the commitments table (and with it its RLS policies + indexes).

DROP TABLE IF EXISTS commitments;
