-- 0021_runtime_vm_lifecycle (down)
ALTER TABLE runtime_vms DROP COLUMN IF EXISTS parent_vm_id;
ALTER TABLE runtime_vms DROP COLUMN IF EXISTS snapshot_id;
