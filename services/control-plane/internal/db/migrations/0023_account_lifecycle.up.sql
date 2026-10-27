-- 0023: email verification + password reset (ADR 0027).
--
-- DEFAULT now() is deliberate: every existing user, and every insert path that
-- does not say otherwise (OAuth — the provider verified the address — and the
-- dev seed), is verified. Only the password sign-up path inserts NULL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ DEFAULT now();

-- Single-use, expiring account tokens. The raw token only ever exists in the
-- emailed link; we store its SHA-256 so a DB read cannot be replayed.
CREATE TABLE IF NOT EXISTS auth_tokens (
	token_hash TEXT PRIMARY KEY,
	tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	purpose    TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
	expires_at TIMESTAMPTZ NOT NULL,
	used_at    TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose);

-- Tenant isolation (invariant #7), same shape as 0003. The auth handlers run
-- pre-tenant on the privileged pool (rls-exempt, like login); the policy keeps
-- the restricted role honest.
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON auth_tokens;
CREATE POLICY tenant_isolation ON auth_tokens
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth_tokens TO lantern_app;

-- 0020 created brief_items without this grant, so every RLS-enforced read of
-- it (the brief "done 1" path, and the tenant export) failed with
-- "permission denied" on the lantern_app pool.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE brief_items TO lantern_app;
