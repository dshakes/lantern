-- 0011_schedules_timezone.down.sql
ALTER TABLE schedules DROP COLUMN IF EXISTS timezone;
