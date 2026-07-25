-- 0019: record WHY a connector is unusable, so a broken credential is visible
-- instead of being rediscovered once per scheduled run.
--
-- Observed live: the Gmail OAuth token was encrypted with a
-- LANTERN_CREDENTIAL_KEY that no longer exists, so every decrypt failed with
-- "credential is encrypted but LANTERN_CREDENTIAL_KEY is not set". The install
-- still said status='connected', so three scheduled agents (inbox-autopilot,
-- domain-tracker, inbox-triage) re-attempted it every hour and failed
-- identically — 124 failed runs in 7 days, each burning a run row and LLM
-- tokens before hitting a failure that could never succeed.
--
-- status now also takes 'needs_reauth': the credential is structurally
-- unusable and only a human re-authorization can fix it. status_reason carries
-- the operator-facing explanation; status_changed_at supports "how long has
-- this been broken".
ALTER TABLE connector_installs ADD COLUMN IF NOT EXISTS status_reason TEXT;
ALTER TABLE connector_installs ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

-- Consecutive permanent failures seen since the last success. Used to avoid
-- re-quarantining (and re-notifying) on every attempt.
ALTER TABLE connector_installs ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS connector_installs_tenant_status_idx
	ON connector_installs (tenant_id, status);
