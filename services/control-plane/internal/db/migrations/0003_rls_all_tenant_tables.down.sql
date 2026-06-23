-- 0003_rls_all_tenant_tables.down.sql
--
-- Reverse 0003: drop the tenant_isolation policy and disable RLS on every
-- table that 0003 enabled it on. agents/runs keep their baseline (0001)
-- tenant_isolation_{agents,runs} policies but revert to USING-only by
-- recreating them without WITH CHECK (matching the 0001 baseline state).

DO $$
DECLARE
	t text;
	tenant_tables text[] := ARRAY[
		'users',
		'connector_installs',
		'surface_configs',
		'api_keys',
		'deployments',
		'data_planes',
		'llm_provider_configs',
		'schedules',
		'sessions',
		'agent_budgets',
		'cost_forecasts',
		'marketplace_stars',
		'agent_mcp_attachments',
		'eval_suites',
		'eval_runs',
		'eval_baselines',
		'agent_experiments',
		'agent_usage_daily',
		'run_receipts',
		'run_feedback',
		'takeover_requests',
		'voice_numbers',
		'voice_calls',
		'whatsapp_contact_facts',
		'whatsapp_vip_contacts',
		'whatsapp_pending_drafts',
		'runtime_quotas',
		'runtime_audit_events',
		'runtime_vms',
		'people',
		'person_handles',
		'memory_events',
		'runtime_vm_logs',
		'side_effect_receipts'
	];
BEGIN
	FOREACH t IN ARRAY tenant_tables LOOP
		IF to_regclass('public.' || t) IS NULL THEN
			CONTINUE;
		END IF;
		EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
		EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
		EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
	END LOOP;
END$$;

-- Revert agents/runs to the USING-only baseline policies.
DO $$
BEGIN
	IF to_regclass('public.agents') IS NOT NULL THEN
		DROP POLICY IF EXISTS tenant_isolation_agents ON agents;
		CREATE POLICY tenant_isolation_agents ON agents
			USING (tenant_id::text = current_setting('app.tenant_id', true));
	END IF;

	IF to_regclass('public.runs') IS NOT NULL THEN
		DROP POLICY IF EXISTS tenant_isolation_runs ON runs;
		CREATE POLICY tenant_isolation_runs ON runs
			USING (tenant_id::text = current_setting('app.tenant_id', true));
	END IF;
END$$;
