-- 0008_errands.down.sql
--
-- Reverse 0008: drop errand + DNC tables (RLS policies and indexes cascade).
DROP TABLE IF EXISTS dnc_numbers;
DROP TABLE IF EXISTS errands;
