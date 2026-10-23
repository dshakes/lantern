-- 0021: sandbox lifecycle (pause / resume / fork) on runtime_vms.
--
-- snapshot_id  — the snapshot a VM was paused into, or a fork child's source
--                snapshot. NULL = never paused / not a fork.
-- parent_vm_id — the VM a fork child was spawned from. NULL = not a fork.
--
-- 'paused' is a new value of the existing free-text `state` column; paused
-- VMs are excluded from the concurrent-VM quota count (which counts only
-- pending/spawning/running) because a paused VM holds no compute.
ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS snapshot_id  TEXT;
ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS parent_vm_id TEXT;
