-- 0017_confidential_compute
--
-- Confidential compute (SEV-SNP/TDX under Kata-CC) evidence on runtime_vms.
-- See ADR 0023.
--
-- confidential: the run requested confidential compute (set at schedule time).
-- cc_tech:      the CC hardware technology the workload landed on (e.g.
--               "sev-snp"/"tdx"); NULL until a placement/attestation fills it.
-- attestation:  the harness-reported cc_attestation evidence (runtime_class,
--               measurement_present, measurement_sha256, verified:false), or
--               NULL until reported. Recording only — attestation is UNVERIFIED,
--               not validated on SEV-SNP/TDX hardware; not a confidentiality
--               guarantee.

ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS confidential BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS cc_tech      TEXT;
ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS attestation  JSONB;
