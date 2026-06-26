-- 0003_rls_all_tenant_tables.up.sql
--
-- Make Row-Level Security a real tenant-isolation backstop across EVERY
-- tenant-scoped table — not just agents/runs.
--
-- For each table in the list below we:
--   1. ENABLE ROW LEVEL SECURITY (RLS is checked for normal roles).
--   2. FORCE  ROW LEVEL SECURITY (RLS is checked even for the table owner —
--      so a careless connection as the owner role can't accidentally bypass it).
--   3. CREATE POLICY tenant_isolation with BOTH USING and WITH CHECK equal to
--          tenant_id::text = current_setting('app.tenant_id', true)
--      USING gates reads/updates/deletes; WITH CHECK gates the post-image of
--      inserts/updates — so a row can never be written under the wrong tenant.
--
-- Safety / idempotency:
--   * Each table is processed only if it exists (to_regclass IS NOT NULL), so a
--     table that hasn't been created yet is skipped, not fatal.
--   * The policy is dropped-then-created so re-running this migration (or
--     retrofitting WITH CHECK onto an existing USING-only policy) is safe.
--
-- This is gated operationally by LANTERN_RLS_ENFORCE: the privileged 'lantern'
-- superuser pool bypasses RLS (BYPASSRLS implied by superuser), so with
-- enforcement off — the dev/default — nothing changes. RLS only bites when a
-- handler runs on the 'lantern_app' (non-superuser) pool with app.tenant_id set.
--
-- EXEMPT tables (intentionally NOT given RLS — no single owning tenant_id, or
-- deliberately cross-tenant): tenants, agent_versions, journal_events,
-- run_locks, marketplace_agents, mcp_servers, marketplace_invocations.

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
		-- Skip tables that don't exist yet (defensive; the list is curated).
		IF to_regclass('public.' || t) IS NULL THEN
			CONTINUE;
		END IF;

		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

		-- Drop+recreate so the policy is idempotent and always carries both
		-- USING and WITH CHECK.
		EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
		EXECUTE format(
			'CREATE POLICY tenant_isolation ON %I '
			|| 'USING (tenant_id::text = current_setting(''app.tenant_id'', true)) '
			|| 'WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))',
			t
		);
	END LOOP;
END$$;

-- Retrofit WITH CHECK onto the existing agents/runs policies. The 0001 baseline
-- created them USING-only; without WITH CHECK an INSERT/UPDATE could write a row
-- under a tenant_id that doesn't match app.tenant_id. Drop+recreate idempotently.
DO $$
BEGIN
	IF to_regclass('public.agents') IS NOT NULL THEN
		ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
		ALTER TABLE agents FORCE ROW LEVEL SECURITY;
		DROP POLICY IF EXISTS tenant_isolation_agents ON agents;
		CREATE POLICY tenant_isolation_agents ON agents
			USING (tenant_id::text = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
	END IF;

	IF to_regclass('public.runs') IS NOT NULL THEN
		ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
		ALTER TABLE runs FORCE ROW LEVEL SECURITY;
		DROP POLICY IF EXISTS tenant_isolation_runs ON runs;
		CREATE POLICY tenant_isolation_runs ON runs
			USING (tenant_id::text = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
	END IF;
END$$;
