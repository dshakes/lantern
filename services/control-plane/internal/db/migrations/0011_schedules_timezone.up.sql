-- 0011_schedules_timezone.up.sql
--
-- Adds an optional IANA timezone to each schedule so cron expressions fire
-- at wall-clock time in the schedule's local zone instead of server UTC.
-- NULL means "use deployment default (LANTERN_DEFAULT_TIMEZONE) or UTC".
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS timezone TEXT;
