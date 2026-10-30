-- ADR 0042: GRANT audit — brief_items was created in migration 0020 without
-- granting SELECT/INSERT/UPDATE/DELETE to lantern_app.  Every tenant-scoped
-- table must be accessible to the restricted role so RLS enforcement does not
-- silently break code paths that reach it via AppPool.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE brief_items TO lantern_app;
