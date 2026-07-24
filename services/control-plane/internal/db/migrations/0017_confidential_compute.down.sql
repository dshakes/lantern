-- 0017_confidential_compute (down)
ALTER TABLE runtime_vms DROP COLUMN IF EXISTS attestation;
ALTER TABLE runtime_vms DROP COLUMN IF EXISTS cc_tech;
ALTER TABLE runtime_vms DROP COLUMN IF EXISTS confidential;
