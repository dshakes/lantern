-- Kiosk demo only (ADR 0029). Pre-create the RLS-enforced app role so the
-- control-plane can connect as it at boot; migrations add the GRANTs and the
-- baseline's CREATE ROLE is IF NOT EXISTS. The password is a local-demo value
-- on a database that is never exposed outside the compose network.
CREATE ROLE lantern_app LOGIN PASSWORD 'kiosk-app-role-local-only';
