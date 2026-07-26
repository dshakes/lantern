-- 0020: remember which commitment each number in the morning brief referred to.
--
-- The brief lists items as "1. Review the flagged Amex charge". For a reply
-- of "done 1" to be safe, the mapping has to be the one the OWNER SAW.
-- Recomputing the ranked query at reply time looks equivalent and is not: any
-- commitment created, completed, or re-prioritised in between shifts the
-- ordering, so "done 1" would silently close a different item than the one on
-- screen. A wrong close is unrecoverable from the owner's point of view —
-- they believe the thing is handled.
--
-- One row per (tenant, position) per brief; the whole set is replaced each
-- time a brief is sent, so a stale number can never resolve against a newer
-- brief.
CREATE TABLE IF NOT EXISTS brief_items (
	tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	position      INTEGER NOT NULL,
	commitment_id UUID NOT NULL,
	brief_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, position)
);

CREATE INDEX IF NOT EXISTS brief_items_tenant_sent_idx
	ON brief_items (tenant_id, brief_sent_at DESC);

-- Tenant isolation (invariant #7). Same shape as migration 0003: ENABLE +
-- FORCE, and a policy carrying BOTH USING and WITH CHECK so a row can never
-- be read or written under the wrong tenant. Inert until
-- LANTERN_RLS_ENFORCE=1, like every other tenant table.
ALTER TABLE brief_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE brief_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON brief_items;
CREATE POLICY tenant_isolation ON brief_items
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
