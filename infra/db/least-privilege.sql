-- Least-privilege application database role (security finding M5).
--
-- Why: the control-plane currently connects with a role that OWNS the tables
-- (it runs `CREATE TABLE` migrations on boot). In PostgreSQL the table owner
-- BYPASSES Row-Level Security even with `FORCE ROW LEVEL SECURITY` — so
-- tenant isolation degrades to "every query must remember WHERE tenant_id".
-- For production, run schema migrations as a privileged/owner role at DEPLOY
-- time, and have the running application connect as this non-owner DML role.
-- A non-owner is fully subject to the RLS policies (which set app.tenant_id),
-- giving real defense-in-depth.
--
-- Apply ONCE at provisioning, as the database owner/superuser, AFTER the
-- schema exists (i.e. after the control-plane has run its migrations once, or
-- after you adopt a dedicated migration tool). Then point the app's
-- DATABASE_URL at lantern_app.
--
--   psql "$ADMIN_DATABASE_URL" -v app_password="$LANTERN_APP_DB_PASSWORD" \
--        -f infra/db/least-privilege.sql

\set ON_ERROR_STOP on

-- 1. The application role: can log in, can run DML, cannot own/alter schema.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lantern_app') THEN
    EXECUTE format('CREATE ROLE lantern_app LOGIN PASSWORD %L', :'app_password');
  ELSE
    EXECUTE format('ALTER ROLE lantern_app LOGIN PASSWORD %L', :'app_password');
  END IF;
END
$$;

-- 2. Connect + schema usage (no CREATE — cannot add/alter objects).
GRANT CONNECT ON DATABASE lantern TO lantern_app;
GRANT USAGE  ON SCHEMA public      TO lantern_app;

-- 3. DML only on existing + future tables/sequences. No DDL, no ownership.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO lantern_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES  IN SCHEMA public TO lantern_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO lantern_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT                  ON SEQUENCES TO lantern_app;

-- 4. Explicitly NOT a superuser and NOT BYPASSRLS — so FORCE ROW LEVEL
--    SECURITY on agents/runs (see internal/db/migrate.go) actually applies.
ALTER ROLE lantern_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- Note: PostgreSQL superusers ALWAYS bypass RLS regardless of FORCE — never
-- run the application as a superuser in production.
