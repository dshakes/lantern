-- 0001_baseline.down.sql
--
-- Drops the ENTIRE schema created by 0001_baseline.up.sql.
-- FOR DEVELOPMENT RESET ONLY — this destroys all data.
--
-- Run only against a dev / test database:
--   migrate -path ./internal/db/migrations -database "$DATABASE_URL" down 1

DROP TABLE IF EXISTS side_effect_receipts CASCADE;
DROP TABLE IF EXISTS runtime_vm_logs CASCADE;
DROP TABLE IF EXISTS runtime_vms CASCADE;
DROP TABLE IF EXISTS runtime_audit_events CASCADE;
DROP TABLE IF EXISTS runtime_quotas CASCADE;
DROP TABLE IF EXISTS memory_events CASCADE;
DROP TABLE IF EXISTS person_handles CASCADE;
DROP TABLE IF EXISTS people CASCADE;
DROP TABLE IF EXISTS whatsapp_pending_drafts CASCADE;
DROP TABLE IF EXISTS whatsapp_vip_contacts CASCADE;
DROP TABLE IF EXISTS whatsapp_contact_facts CASCADE;
DROP TABLE IF EXISTS voice_calls CASCADE;
DROP TABLE IF EXISTS voice_numbers CASCADE;
DROP TABLE IF EXISTS takeover_requests CASCADE;
DROP TABLE IF EXISTS marketplace_invocations CASCADE;
DROP TABLE IF EXISTS run_feedback CASCADE;
DROP TABLE IF EXISTS run_receipts CASCADE;
DROP TABLE IF EXISTS agent_usage_daily CASCADE;
DROP TABLE IF EXISTS agent_experiments CASCADE;
DROP TABLE IF EXISTS eval_baselines CASCADE;
DROP TABLE IF EXISTS eval_runs CASCADE;
DROP TABLE IF EXISTS eval_suites CASCADE;
DROP TABLE IF EXISTS agent_mcp_attachments CASCADE;
DROP TABLE IF EXISTS mcp_servers CASCADE;
DROP TABLE IF EXISTS marketplace_stars CASCADE;
DROP TABLE IF EXISTS marketplace_agents CASCADE;
DROP TABLE IF EXISTS cost_forecasts CASCADE;
DROP TABLE IF EXISTS agent_budgets CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS schedules CASCADE;
DROP TABLE IF EXISTS llm_provider_configs CASCADE;
DROP TABLE IF EXISTS data_planes CASCADE;
DROP TABLE IF EXISTS deployments CASCADE;
DROP TABLE IF EXISTS api_keys CASCADE;
DROP TABLE IF EXISTS surface_configs CASCADE;
DROP TABLE IF EXISTS connector_installs CASCADE;
DROP TABLE IF EXISTS run_locks CASCADE;
DROP TABLE IF EXISTS journal_events CASCADE;
DROP TABLE IF EXISTS runs CASCADE;
DROP TABLE IF EXISTS agent_versions CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;

DROP ROLE IF EXISTS lantern_app;
