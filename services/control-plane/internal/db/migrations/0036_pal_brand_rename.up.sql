-- Brand rename (ADR 0032): rename the database objects and persisted values
-- that still carry the previous brand name, so code that only knows the PAL
-- names keeps working against a database created before the rename. This is
-- the one file allowed to spell the old name (scripts/brand-allowlist.txt):
-- migrations are append-only, and a rename has to name what it renames.
--
-- Every statement is a no-op on a database created after the rename.
-- Needs a role that bypasses RLS (the migrating superuser): the tenant tables
-- have FORCE ROW LEVEL SECURITY, and the value rewrite must see every row.

-- 1. The restricted RLS role. ALTER ROLE ... RENAME keeps the OID, so every
--    GRANT and policy follows it. It CLEARS an MD5 password (the salt is the
--    role name); a SCRAM password survives. The cutover resets the password
--    right after this runs: ALTER ROLE pal_app PASSWORD '<PAL_APP_DB_PASSWORD>'.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lantern_app')
	   AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pal_app') THEN
		ALTER ROLE lantern_app RENAME TO pal_app;
	END IF;
END
$$;

-- 2. Per-tenant K8s namespaces (parsed by the runtime-manager as pal-t-<id>).
UPDATE tenants
SET k8s_namespace = 'pal-t-' || substr(k8s_namespace, length('lantern-t-') + 1)
WHERE k8s_namespace LIKE 'lantern-t-%';

-- 3. Persisted values.
--    a) The at-rest encryption envelope key ({"__pal_enc__":1,...}): without
--       this the decryptor reads an old envelope as plaintext. The quoted
--       marker cannot occur in user content by accident, so every
--       json/jsonb/text column is rewritten, EXCEPT tables whose rows are
--       hashed or signed (rewriting them would invalidate receipts).
--    b) Secret refs and env keys in stored specs/configs: only the columns
--       that hold them, never free-text user content.
--
--    RLS: the tenant tables have FORCE ROW LEVEL SECURITY keyed on the
--    app.tenant_id GUC. A migrating role without BYPASSRLS (e.g. a managed
--    Postgres master user) would see none of their rows and silently
--    half-apply. So the rewrite runs once per tenant with that tenant's GUC
--    set (plus once unset, for rows no policy hides), and after each pass any
--    old marker still visible fails the migration (and rolls it back).
CREATE FUNCTION pg_temp.pal_brand_rewrite() RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
	r record;
BEGIN
	FOR r IN
		SELECT c.table_name, c.column_name, c.data_type
		FROM information_schema.columns c
		JOIN information_schema.tables t
		  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
		WHERE c.table_schema = current_schema()
		  AND t.table_type = 'BASE TABLE'
		  AND c.is_generated = 'NEVER'
		  AND c.data_type IN ('json', 'jsonb', 'text')
		  AND c.table_name NOT IN (
			'journal_events', 'run_receipts', 'marketplace_invocations', 'schema_migrations')
	LOOP
		EXECUTE format(
			'UPDATE %I SET %I = replace(%I::text, %L, %L)::%s WHERE %I::text LIKE %L',
			r.table_name, r.column_name, r.column_name,
			'"__lantern_enc__"', '"__pal_enc__"', r.data_type,
			r.column_name, '%"\_\_lantern\_enc\_\_"%');
	END LOOP;
	FOR r IN
		SELECT c.table_name, c.column_name, c.data_type
		FROM information_schema.columns c
		WHERE c.table_schema = current_schema()
		  AND (c.table_name, c.column_name) IN (
			('runtime_vms', 'spec'), ('agent_versions', 'manifest'),
			('connector_installs', 'config'), ('agent_mcp_attachments', 'config'),
			('schedules', 'config'), ('surface_configs', 'config'), ('data_planes', 'config'))
	LOOP
		EXECUTE format(
			'UPDATE %I SET %I = replace(replace(%I::text, %L, %L), %L, %L)::%s'
			' WHERE %I::text LIKE %L OR %I::text LIKE %L',
			r.table_name, r.column_name, r.column_name,
			'lantern.secret', 'pal.secret',
			'"LANTERN_', '"PAL_',
			r.data_type,
			r.column_name, '%lantern.secret%',
			r.column_name, '%"LANTERN\_%');
	END LOOP;
END
$fn$;

-- Old envelope markers still visible under the current GUC.
CREATE FUNCTION pg_temp.pal_brand_remaining() RETURNS bigint LANGUAGE plpgsql AS $fn$
DECLARE
	r record;
	n bigint;
	total bigint := 0;
BEGIN
	FOR r IN
		SELECT c.table_name, c.column_name
		FROM information_schema.columns c
		JOIN information_schema.tables tb
		  ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
		WHERE c.table_schema = current_schema()
		  AND tb.table_type = 'BASE TABLE'
		  AND c.is_generated = 'NEVER'
		  AND c.data_type IN ('json', 'jsonb', 'text')
		  AND c.table_name NOT IN (
			'journal_events', 'run_receipts', 'marketplace_invocations', 'schema_migrations')
	LOOP
		EXECUTE format('SELECT count(*) FROM %I WHERE %I::text LIKE %L',
			r.table_name, r.column_name, '%"\_\_lantern\_enc\_\_"%') INTO n;
		total := total + n;
	END LOOP;
	RETURN total;
END
$fn$;

-- One pass with no tenant GUC (rows no policy hides), then one per tenant.
-- After each pass nothing visible may still carry the old marker, so a
-- rewrite that missed rows fails the migration (and rolls it back) instead of
-- leaving credentials unreadable.
DO $$
DECLARE
	t record;
	n bigint;
BEGIN
	PERFORM set_config('app.tenant_id', '', true);
	PERFORM pg_temp.pal_brand_rewrite();
	n := pg_temp.pal_brand_remaining();
	IF n > 0 THEN
		RAISE EXCEPTION 'pal_brand_rename: % values still carry the old envelope marker', n;
	END IF;
	FOR t IN SELECT id FROM tenants LOOP
		PERFORM set_config('app.tenant_id', t.id::text, true);
		PERFORM pg_temp.pal_brand_rewrite();
		n := pg_temp.pal_brand_remaining();
		IF n > 0 THEN
			RAISE EXCEPTION 'pal_brand_rename: % values of tenant % still carry the old envelope marker', n, t.id;
		END IF;
	END LOOP;
	PERFORM set_config('app.tenant_id', '', true);
END
$$;

DROP FUNCTION pg_temp.pal_brand_remaining();
DROP FUNCTION pg_temp.pal_brand_rewrite();
