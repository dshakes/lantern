-- 0004_life_events.down.sql
--
-- Reverse 0004: drop the life-event store + prefs tables (and with them their
-- RLS policies + indexes).

DROP TABLE IF EXISTS life_event_prefs;
DROP TABLE IF EXISTS life_events;
