-- Host-asserted software measurement (ADR 0031).
-- SHA-256 hex over the five canonical inputs the manager booted from.
-- Empty when not computed (non-Firecracker backends, pre-ADR-0031 spawns).
ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS software_measurement TEXT;
