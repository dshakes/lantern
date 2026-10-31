-- 0038: Agent identity + per-agent least-privilege policy (ADR 0055).
--
-- Three tenant-scoped tables (all under RLS, invariant #7):
--   agent_identities      one principal per agent; NO private key is stored —
--                         the signing key is HKDF-derived from a root secret +
--                         (tenant, agent, generation) at mint time.
--   agent_policies        the agent's allowlists. Existing agents are backfilled
--                         legacy_permissive (nothing that works today breaks);
--                         every agent created from now on gets an empty
--                         default-deny policy via trigger.
--   agent_identity_audit  append-only, hash-chained audit of mint/use/deny.
--
-- Needs a role that bypasses RLS for the backfill (the migrating superuser),
-- like 0036; a non-bypassing migrator gets a WARNING and the control-plane
-- lazily classifies any agent the backfill could not see by its created_at
-- against agent_policy_cutover (below), so a hidden row is never default-denied.

-- 1. Cutover marker: agents created before this instant are "pre-existing".
CREATE TABLE IF NOT EXISTS agent_policy_cutover (
	singleton  BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
	applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO agent_policy_cutover (singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- 2. Identities.
CREATE TABLE IF NOT EXISTS agent_identities (
	agent_id        UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
	tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	spiffe_id       TEXT NOT NULL,
	key_generation  INTEGER NOT NULL DEFAULT 1 CHECK (key_generation >= 1),
	public_key      BYTEA NOT NULL CHECK (octet_length(public_key) = 32),
	status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
	revoked_reason  TEXT,
	created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
	rotated_at      TIMESTAMPTZ,
	revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_identities_tenant_idx ON agent_identities (tenant_id);

-- 3. Policies. `document` holds the allowlists + budget (packages/agentpolicy
--    Policy minus mode/version, which are columns so SQL can filter on them).
CREATE TABLE IF NOT EXISTS agent_policies (
	agent_id    UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
	tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	mode        TEXT NOT NULL CHECK (mode IN ('enforce', 'legacy_permissive')),
	document    JSONB NOT NULL DEFAULT '{}'::jsonb,
	version     INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
	updated_by  TEXT NOT NULL DEFAULT 'system',
	created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_policies_tenant_idx ON agent_policies (tenant_id);

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
		RAISE WARNING '0038_agent_identity_policy: % does not bypass RLS; agents hidden by FORCE ROW LEVEL SECURITY are not backfilled (the control-plane classifies them lazily by created_at)', current_user;
	END IF;
END
$$;

INSERT INTO agent_policies (agent_id, tenant_id, mode, document, updated_by)
SELECT a.id, a.tenant_id, 'legacy_permissive',
       '{"tools":["*"],"connectors":{"*":["*"]},"mcpServers":["*"],"egressHosts":["*"],"a2aTargets":["*"],"a2aInbound":["*"],"secrets":["*"],"budget":{"maxToolCallsPerRun":0,"maxA2AInboundPerMinute":0}}'::jsonb,
       'system:migration-0038'
FROM agents a
ON CONFLICT (agent_id) DO NOTHING;

-- Every agent created after this migration starts default-deny. The one
-- grant made here is the capability the creator DECLARED in the agent's own
-- labels: handoff=human means "this agent's only tool is handing off to a
-- person" (session_handoff.go), so it gets exactly that and nothing else.
CREATE OR REPLACE FUNCTION agent_policies_default_deny() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO agent_policies (agent_id, tenant_id, mode, document, updated_by)
	VALUES (NEW.id, NEW.tenant_id, 'enforce',
	        CASE WHEN COALESCE(NEW.labels->>'handoff', '') = 'human'
	             THEN '{"tools":["handoff_to_human"]}'::jsonb ELSE '{}'::jsonb END,
	        'system:default-deny')
	ON CONFLICT (agent_id) DO NOTHING;
	RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS agents_default_deny_policy ON agents;
CREATE TRIGGER agents_default_deny_policy
	AFTER INSERT ON agents
	FOR EACH ROW EXECUTE FUNCTION agent_policies_default_deny();

-- 4. Append-only, hash-chained audit. No FK on agent_id: the audit trail must
--    outlive the agent. chain_seq (not id) orders the chain, because a
--    BIGSERIAL id is assigned before the per-tenant lock is taken.
CREATE TABLE IF NOT EXISTS agent_identity_audit (
	id                BIGSERIAL PRIMARY KEY,
	tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	chain_seq         BIGINT NOT NULL DEFAULT 0,
	agent_id          UUID,
	agent_name        TEXT NOT NULL DEFAULT '',
	agent_version_id  TEXT NOT NULL DEFAULT '',
	run_id            TEXT NOT NULL DEFAULT '',
	step_id           TEXT NOT NULL DEFAULT '',
	event             TEXT NOT NULL,
	action_kind       TEXT NOT NULL DEFAULT '',
	target            TEXT NOT NULL DEFAULT '',
	decision          TEXT NOT NULL DEFAULT '' CHECK (decision IN ('', 'allow', 'deny')),
	reason            TEXT NOT NULL DEFAULT '',
	principal         TEXT NOT NULL DEFAULT '',
	jti               TEXT NOT NULL DEFAULT '',
	attrs             JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
	prev_hash         TEXT NOT NULL DEFAULT '',
	row_hash          TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_identity_audit_chain_idx ON agent_identity_audit (tenant_id, chain_seq);
CREATE INDEX IF NOT EXISTS agent_identity_audit_agent_idx ON agent_identity_audit (tenant_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_identity_audit_run_idx ON agent_identity_audit (run_id, event) WHERE run_id <> '';

-- The canonical row digest. One definition, used by the insert trigger and by
-- the verifier, so the two can never disagree about what was hashed.
CREATE OR REPLACE FUNCTION agent_identity_audit_digest(r agent_identity_audit) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
	SELECT encode(sha256(convert_to(concat_ws(E'\x1f',
		r.prev_hash, r.tenant_id::text, r.chain_seq::text, COALESCE(r.agent_id::text, ''),
		r.agent_name, r.agent_version_id, r.run_id, r.step_id, r.event, r.action_kind,
		r.target, r.decision, r.reason, r.principal, r.jti, r.attrs::text,
		to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
	), 'UTF8')), 'hex')
$$;

-- SECURITY DEFINER so the chain lookup sees the tenant's whole chain whatever
-- role inserts; it reads only the inserting tenant's rows and writes only NEW.
CREATE OR REPLACE FUNCTION agent_identity_audit_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	last_seq  BIGINT;
	last_hash TEXT;
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended('agent_identity_audit:' || NEW.tenant_id::text, 0));
	SELECT chain_seq, row_hash INTO last_seq, last_hash
	FROM agent_identity_audit WHERE tenant_id = NEW.tenant_id
	ORDER BY chain_seq DESC LIMIT 1;
	NEW.chain_seq  := COALESCE(last_seq, 0) + 1;
	NEW.prev_hash  := COALESCE(last_hash, '');
	NEW.created_at := clock_timestamp();
	NEW.row_hash   := agent_identity_audit_digest(NEW);
	RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS agent_identity_audit_chain ON agent_identity_audit;
CREATE TRIGGER agent_identity_audit_chain
	BEFORE INSERT ON agent_identity_audit
	FOR EACH ROW EXECUTE FUNCTION agent_identity_audit_chain();

-- Append-only for EVERY role (grants alone do not bind the superuser pool).
-- Two exceptions, both tenant erasure: the FK cascade when the tenant row is
-- deleted (parent already gone), and the GDPR purge, which deletes leaf-to-root
-- inside one transaction after SET LOCAL pal.audit_erasure = '<tenant id>'.
-- pal_app holds no DELETE grant, so neither path is reachable from the app role.
CREATE OR REPLACE FUNCTION agent_identity_audit_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
	IF TG_OP = 'DELETE' AND (
		NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id)
		OR current_setting('pal.audit_erasure', true) = OLD.tenant_id::text
	) THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'agent_identity_audit is append-only (% rejected)', TG_OP
		USING ERRCODE = 'insufficient_privilege';
END
$$;
DROP TRIGGER IF EXISTS agent_identity_audit_immutable ON agent_identity_audit;
CREATE TRIGGER agent_identity_audit_immutable
	BEFORE UPDATE OR DELETE ON agent_identity_audit
	FOR EACH ROW EXECUTE FUNCTION agent_identity_audit_immutable();

-- Recompute a tenant's chain. Returns the chain_seq of the first broken link,
-- or 0 when the chain is intact.
CREATE OR REPLACE FUNCTION agent_identity_audit_verify(p_tenant UUID) RETURNS BIGINT
LANGUAGE plpgsql STABLE AS $$
DECLARE
	r        agent_identity_audit;
	expected TEXT := '';
	want_seq BIGINT := 1;
BEGIN
	FOR r IN SELECT * FROM agent_identity_audit WHERE tenant_id = p_tenant ORDER BY chain_seq LOOP
		IF r.chain_seq <> want_seq OR r.prev_hash <> expected OR r.row_hash <> agent_identity_audit_digest(r) THEN
			RETURN r.chain_seq;
		END IF;
		expected := r.row_hash;
		want_seq := want_seq + 1;
	END LOOP;
	RETURN 0;
END
$$;

-- 5. MicroVMs remember which agent they run as (secret relay scoping).
ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS agent_id UUID;

-- 6. RLS (invariant #7), same shape as 0003/0033.
ALTER TABLE agent_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_identities;
CREATE POLICY tenant_isolation ON agent_identities
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE agent_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_policies;
CREATE POLICY tenant_isolation ON agent_policies
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE agent_identity_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_identity_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_identity_audit;
CREATE POLICY tenant_isolation ON agent_identity_audit
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT ON agent_policy_cutover TO pal_app;
GRANT SELECT, INSERT, UPDATE ON agent_identities TO pal_app;
GRANT SELECT, INSERT, UPDATE ON agent_policies TO pal_app;
GRANT SELECT, INSERT ON agent_identity_audit TO pal_app;
GRANT USAGE, SELECT ON SEQUENCE agent_identity_audit_id_seq TO pal_app;
