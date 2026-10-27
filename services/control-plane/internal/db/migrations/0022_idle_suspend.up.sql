-- 0022: idle-suspend support on runtime_vms.
--
-- idle_timeout_secs — auto-suspend the VM after this many seconds of
-- inactivity (no running workload child in the harness). 0 = never auto-suspend.
ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS idle_timeout_secs INT NOT NULL DEFAULT 0;
