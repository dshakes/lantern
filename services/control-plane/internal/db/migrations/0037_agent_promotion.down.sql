DROP TABLE IF EXISTS agent_promotion_audit;
DROP FUNCTION IF EXISTS agent_promotion_audit_immutable();
DROP TABLE IF EXISTS agent_promotions;
DROP TABLE IF EXISTS agent_environments;
ALTER TABLE eval_runs DROP COLUMN IF EXISTS source;
