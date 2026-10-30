-- 0033: PAL device tenancy — bridge enrollment, per-tenant bridge credentials,
-- and tenant-scoped device signals (ADR 0047).
--
-- bridge_pairing_codes: one-time codes minted by a signed-in user
--   (POST /v1/bridges/enroll) and redeemed once by an unauthenticated device
--   (POST /v1/bridges/pair). Only the SHA-256 of the code is stored; a code is
--   single-use (consumed_at) and short-lived (expires_at).
-- bridges: one row per paired device (a Mac running the bridge, or an iPhone
--   Shortcuts signal source). The bearer credential is stored ONLY as a
--   SHA-256 hash (token_hash); token_prefix is a non-secret display hint.
--   Revocation is a soft delete (revoked_at) so the audit trail survives.
-- device_signals: tenant-scoped replacement for the single-owner
--   ~/.pal/device-signals.jsonl file. Same field contract as the file.
CREATE TABLE IF NOT EXISTS bridge_pairing_codes (
	id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	code_hash    TEXT NOT NULL UNIQUE,
	name         TEXT NOT NULL DEFAULT '',
	platform     TEXT NOT NULL DEFAULT 'macos',
	scopes       TEXT[] NOT NULL DEFAULT '{}',
	created_by   UUID,
	expires_at   TIMESTAMPTZ NOT NULL,
	consumed_at  TIMESTAMPTZ,
	bridge_id    UUID,
	created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bridge_pairing_codes_tenant_idx ON bridge_pairing_codes (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bridges (
	id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	name          TEXT NOT NULL DEFAULT '',
	platform      TEXT NOT NULL DEFAULT 'macos',
	token_hash    TEXT NOT NULL UNIQUE,
	token_prefix  TEXT NOT NULL,
	scopes        TEXT[] NOT NULL DEFAULT '{}',
	created_by    UUID,
	created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
	rotated_at    TIMESTAMPTZ,
	last_seen_at  TIMESTAMPTZ,
	revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bridges_tenant_idx ON bridges (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS device_signals (
	id          BIGSERIAL PRIMARY KEY,
	tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	bridge_id   UUID REFERENCES bridges(id) ON DELETE SET NULL,
	source      TEXT NOT NULL CHECK (source IN ('bridge', 'user', 'legacy')),
	kind        TEXT NOT NULL,
	app         TEXT NOT NULL DEFAULT '',
	detail      TEXT NOT NULL DEFAULT '',
	metric      TEXT NOT NULL DEFAULT '',
	value       DOUBLE PRECISION,
	ts          BIGINT NOT NULL,
	created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_signals_tenant_ts_idx ON device_signals (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS device_signals_tenant_created_idx ON device_signals (tenant_id, created_at);

-- Tenant isolation (invariant #7), same shape as 0003/0028.
ALTER TABLE bridge_pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridge_pairing_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bridge_pairing_codes;
CREATE POLICY tenant_isolation ON bridge_pairing_codes
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE bridges ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bridges;
CREATE POLICY tenant_isolation ON bridges
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE device_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_signals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON device_signals;
CREATE POLICY tenant_isolation ON device_signals
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON bridge_pairing_codes TO pal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON bridges TO pal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON device_signals TO pal_app;
GRANT USAGE, SELECT ON SEQUENCE device_signals_id_seq TO pal_app;
