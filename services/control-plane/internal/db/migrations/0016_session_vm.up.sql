-- 0016_session_vm
--
-- Adds session affinity to runtime_vms so one VM is reused across turns of
-- the same interactive session (AgentCore parity, ADR 0022).
--
-- session_id: the sessions.id this VM is pinned to. NULL for non-session runs.
-- last_used_at: touched on each reuse so the idle-sweep can terminate stale
--   session VMs after LANTERN_SESSION_VM_IDLE_TTL (default 30m).

ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS session_id   TEXT;
ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS runtime_vms_tenant_session_idx
    ON runtime_vms (tenant_id, session_id)
    WHERE session_id IS NOT NULL;
