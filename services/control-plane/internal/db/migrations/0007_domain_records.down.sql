-- 0007_domain_records.down.sql
DROP TABLE IF EXISTS domain_records;

-- Best-effort PK revert; leaves existing data intact.
ALTER TABLE gmail_poll_cursors DROP CONSTRAINT IF EXISTS gmail_poll_cursors_pkey;
ALTER TABLE gmail_poll_cursors DROP COLUMN IF EXISTS domain;
ALTER TABLE gmail_poll_cursors ADD PRIMARY KEY (tenant_id);
