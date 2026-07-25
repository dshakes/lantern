-- 0018_runtime_vm_state_reason (down)
ALTER TABLE runtime_vms DROP COLUMN IF EXISTS state_reason;
