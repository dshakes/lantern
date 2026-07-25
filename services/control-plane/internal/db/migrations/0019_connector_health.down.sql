-- 0019_connector_health (down)
DROP INDEX IF EXISTS connector_installs_tenant_status_idx;
ALTER TABLE connector_installs DROP COLUMN IF EXISTS failure_count;
ALTER TABLE connector_installs DROP COLUMN IF EXISTS status_changed_at;
ALTER TABLE connector_installs DROP COLUMN IF EXISTS status_reason;
