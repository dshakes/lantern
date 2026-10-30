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

-- 3. Persisted values: the at-rest encryption envelope marker
--    ({"__pal_enc__":1,...}; without this the decryptor would read an old
--    envelope as plaintext), secret refs (pal.secret/...), and env keys in
--    stored specs ("PAL_AGENT_INSTANCE_TOKEN" must match the redaction list).
--    Every json/jsonb/text column of every base table, EXCEPT the tables whose
--    rows are hashed or signed (rewriting them would invalidate receipts).
DO $$
DECLARE
	r record;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
		RAISE WARNING 'pal_brand_rename: % does not bypass RLS; rows hidden by FORCE ROW LEVEL SECURITY are not rewritten', current_user;
	END IF;
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
			'UPDATE %I SET %I = replace(replace(replace(%I::text, %L, %L), %L, %L), %L, %L)::%s'
			' WHERE %I::text LIKE %L OR %I::text LIKE %L OR %I::text LIKE %L',
			r.table_name, r.column_name, r.column_name,
			'"__lantern_enc__"', '"__pal_enc__"',
			'lantern.secret', 'pal.secret',
			'"LANTERN_', '"PAL_',
			r.data_type,
			r.column_name, '%"\_\_lantern\_enc\_\_"%',
			r.column_name, '%lantern.secret%',
			r.column_name, '%"LANTERN\_%');
	END LOOP;
END
$$;
