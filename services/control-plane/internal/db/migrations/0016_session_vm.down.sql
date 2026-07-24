-- 0016_session_vm (down)
DROP INDEX IF EXISTS runtime_vms_tenant_session_idx;
ALTER TABLE runtime_vms DROP COLUMN IF EXISTS last_used_at;
ALTER TABLE runtime_vms DROP COLUMN IF EXISTS session_id;
