-- 0013_microvm_durability
--
-- Adds exit_code and exit_output to runtime_vms so the harness can report
-- workload completion via POST /v1/runtime/report (kind=vm_exit) and the
-- control-plane can close the associated run with typed success/failure.
--
-- exit_code: the process exit code reported by the harness. NULL means the
--   workload has not yet exited (or did not report). 0 = success; non-zero = failure.
-- exit_output: the final output payload forwarded with exit_code=0. Used to
--   populate runs.output when the run is finalized.

ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS exit_code   INT;
ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS exit_output JSONB;
