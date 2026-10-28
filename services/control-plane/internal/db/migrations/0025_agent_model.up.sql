-- 0025: per-agent model on agents.
--
-- The capability ("fast", "reasoning-small", "auto") or vendor model id the
-- agent's runs and sessions prefer; NULL/''/'auto' keeps the balanced default
-- chain. templates.go and the inline executor's prompt back-fill already wrote
-- this column, so before it existed those UPDATEs failed (system_prompt and
-- labels included) and the error was discarded.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model TEXT;
